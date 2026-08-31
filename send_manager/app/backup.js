'use strict';
/* ============================================================================
 * 传输内容备份：写入 / 解析 / 到期清理
 * - 存储布局：<dataDir>/backups/records/<recordId>/<安全文件名>
 * - record.backup_path 存 dataDir 相对路径（POSIX 分隔符），空串表示无备份
 * - 文件名做清洗（去路径分隔符/../控制字符），防路径穿越
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

function sanitizeFilename(name) {
  const base = String(name || 'file')
    .replace(/[\\/]/g, '_')      // 路径分隔符
    .replace(/\.\./g, '_')       // 目录穿越
    .replace(/[\x00-\x1f\x7f]/g, '_') // 控制字符
    .replace(/^\.+/, '')         // 前导点
    .slice(0, 180);
  return base || 'file';
}

/** 写入备份，返回 dataDir 相对路径（POSIX 分隔符）；失败返回空串 */
function storeBackup({ dataDir, recordId, filename, buffer }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return '';
  const dir = path.join(dataDir, 'backups', 'records', String(recordId));
  const rel = `backups/records/${String(recordId)}/${sanitizeFilename(filename)}`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, sanitizeFilename(filename)), buffer, { mode: 0o600 });
    return rel;
  } catch (_) {
    return '';
  }
}

/** 解析备份文件绝对路径；无备份 / 路径越界 / 文件缺失返回 null */
function resolveBackup({ dataDir, record }) {
  if (!record || !record.backup_path) return null;
  const baseDir = path.join(dataDir, 'backups', 'records');
  const abs = path.resolve(dataDir, record.backup_path);
  if (!abs.startsWith(baseDir + path.sep)) return null; // 防路径穿越
  if (!fs.existsSync(abs)) return null;
  return { absPath: abs, filename: path.basename(abs) };
}

/**
 * 清理超过 retentionDays 的备份：删除旧文件与空目录，返回被清理的 recordId 列表。
 * 由定时任务调用；调用方负责把返回的 id 在 DB 中清掉 backup_path。
 */
function cleanupBackups({ dataDir, retentionDays }) {
  const baseDir = path.join(dataDir, 'backups', 'records');
  if (!fs.existsSync(baseDir)) return [];
  const cutoff = Date.now() - Math.max(1, retentionDays) * 86400000;
  const cleaned = [];
  const dirs = fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ id: d.name, dir: path.join(baseDir, d.name) }));

  for (const { id, dir } of dirs) {
    let emptied = true;
    let files;
    try { files = fs.readdirSync(dir); } catch (_) { continue; }
    for (const f of files) {
      const fp = path.join(dir, f);
      let st;
      try { st = fs.statSync(fp); } catch (_) { continue; }
      if (st.isFile() && st.mtimeMs < cutoff) {
        try { fs.unlinkSync(fp); } catch (_) {}
      } else {
        emptied = false;
      }
    }
    if (emptied) {
      try { fs.rmdirSync(dir); } catch (_) {}
      cleaned.push(id);
    }
  }
  return cleaned;
}

module.exports = { storeBackup, resolveBackup, cleanupBackups, sanitizeFilename };
