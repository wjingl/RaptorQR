'use strict';
/* ============================================================================
 * 离线维护 CLI（仅限服务器本机、服务账号运行 —— OS 级信任边界，勿暴露到网络）
 * 用法（在 send_manager 目录，用捆绑 node 执行）：
 *   ./runtime/bin/node scripts/cli.js create-admin <username> [显示名]
 *   ./runtime/bin/node scripts/cli.js reset-password <username>
 *   ./runtime/bin/node scripts/cli.js list-users [--status active]
 *   ./runtime/bin/node scripts/cli.js backup [--dir 备份目录]
 *   ./runtime/bin/node scripts/cli.js export-records [--format json|csv] [--out 文件]
 *   ./runtime/bin/node scripts/cli.js stats
 *   ./runtime/bin/node scripts/cli.js health
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadConfig, ROOT } = require('../app/config');
const { loadSecrets } = require('../app/secrets');
const { RqrDb } = require('../app/db');

const config = loadConfig();
const secrets = loadSecrets(config.dataDir);
const db = new RqrDb(path.join(config.dataDir, 'db.sqlite'));

const BCRYPT = require('bcryptjs');

function log(...a) { console.log(...a); }
function die(msg) { console.error(`错误：${msg}`); process.exit(1); }

function randomPassword(len = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

async function cmdCreateAdmin(args) {
  const username = (args[0] || '').toLowerCase();
  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) die('用户名仅允许字母/数字/下划线，3-32 位');
  const displayName = args[1] || username;
  if (db.getUserByUsername(username)) die('用户名已存在');
  const password = process.env.RQR_ADMIN_PASSWORD || randomPassword();
  const hash = await BCRYPT.hash(password, 12);
  const u = db.createUser({ username, displayName, passHash: hash, role: 'admin', status: 'active', mustChangePassword: 0, createdBy: 'cli' });
  db.audit({ userId: u.id, username, action: 'CLI_CREATE_ADMIN', detail: '通过 CLI 创建总管理', ip: 'localhost' });
  log(`总管理创建成功：${username}（#${u.id}）`);
  if (!process.env.RQR_ADMIN_PASSWORD) log(`临时密码：${password}\n（请立即登录修改，勿明文传播）`);
}

async function cmdResetPassword(username) {
  const user = db.getUserByUsername((username || '').toLowerCase());
  if (!user) die('用户不存在');
  const pw = randomPassword();
  const hash = await BCRYPT.hash(pw, 12);
  db.setUserPassword(user.id, hash, 1);
  db.destroyUserSessions(user.id);
  db.audit({ userId: user.id, username: user.username, action: 'CLI_RESET_PASSWORD', detail: '通过 CLI 重置密码', ip: 'localhost' });
  log(`已重置 ${user.username} 的密码（下次登录强制修改）`);
  log(`临时密码：${pw}`);
}

function cmdListUsers(args) {
  const status = args[0] || '';
  const data = db.listUsers({ status, q: '', page: 1, pageSize: 1000 });
  log(`${'用户名'.padEnd(20)} ${'姓名'.padEnd(16)} ${'角色'.padEnd(6)} ${'状态'.padEnd(9)} 最近登录`);
  for (const u of data.rows) {
    log(`${u.username.padEnd(20)} ${(u.display_name || '').padEnd(16)} ${u.role.padEnd(6)} ${u.status.padEnd(9)} ${u.last_login_at || '-'}`);
  }
  log(`共 ${data.total} 个账号`);
}

async function cmdBackup(args) {
  const backupDir = path.resolve(args[0] || path.join(config.dataDir, 'backups'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(backupDir, `db-${stamp}.sqlite`);
  await db.backup(dest);
  log(`数据库备份完成：${dest}`);
  // 备份 secrets 与配置（不含日志）
  for (const f of ['secrets.json']) {
    const src = path.join(config.dataDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, f));
  }
  log('secrets 已随备份复制（请妥善保管备份文件，含会话密钥）');
}

function cmdExport(args) {
  const format = args[0] || 'csv';
  const out = args[1];
  const records = db.db.prepare('SELECT * FROM records ORDER BY id').all();
  let content;
  if (format === 'json') {
    content = JSON.stringify(records, null, 2);
  } else {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    content = ['id,username,filename,size,mime,is_text,destination,status,sha256,started_at,completed_at,note']
      .concat(records.map((r) => [r.id, r.username, r.filename, r.size, r.mime, r.is_text, r.destination, r.status, r.sha256, r.started_at, r.completed_at, r.note].map(esc).join(',')))
      .join('\n');
  }
  if (out) { fs.writeFileSync(path.resolve(out), content); log(`已导出 ${records.length} 条记录 → ${out}`); }
  else process.stdout.write(content + '\n');
}

function cmdStats() {
  const ov = db.overview();
  log(`记录总数：${ov.total}  字节：${ov.total_bytes}  完成：${ov.completed}  传输中：${ov.sending}`);
  const dest = db.byDestination();
  for (const d of dest) log(`  ${d.destination.padEnd(6)} ${d.n} 次 / ${d.bytes} B`);
  log('--- 每人 ---');
  for (const u of db.byUser(50)) log(`  ${u.username.padEnd(20)} ${u.n} 次 / ${u.bytes} B / 完成 ${u.completed}`);
}

function cmdHealth() {
  db.db.prepare('SELECT 1').get();
  log(`数据库正常：${db.dbPath}`);
  log(`数据目录：${config.dataDir}`);
  log(`配置：${config.configPath}`);
  log(`端口：${config.port}  会话绝对有效期：${config.session.absoluteTtlHours}h / 空闲 ${config.session.idleTtlMinutes}m`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'create-admin': await cmdCreateAdmin(args); break;
    case 'reset-password': await cmdResetPassword(args[0]); break;
    case 'list-users': cmdListUsers(args); break;
    case 'backup': await cmdBackup(args); break;
    case 'export-records': cmdExport(args); break;
    case 'stats': cmdStats(); break;
    case 'health': cmdHealth(); break;
    default:
      die(`未知命令：${cmd || '(空)'}\n可用命令：create-admin / reset-password / list-users / backup / export-records / stats / health`);
  }
  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
