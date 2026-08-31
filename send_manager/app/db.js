'use strict';
/* ============================================================================
 * 数据层：better-sqlite3（同步 API）
 * - WAL 模式 + busy_timeout；全参数化查询（禁止字符串拼接 SQL）
 * - 版本化迁移：schema_migrations 表，启动时事务内执行
 * - 敏感字段不落明文：密码(bcrypt)/会话token(sha256)/验证码(sha256+salt)
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const nowISO = () => new Date().toISOString();

/* ------------------------------ 迁移定义 ------------------------------ */
const MIGRATIONS = [
  // v1: 初始表结构
  (db) => {
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL DEFAULT '',
        pass_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'pending',
        must_change_password INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT,
        approved_by TEXT,
        approved_at TEXT,
        reject_reason TEXT,
        last_login_at TEXT
      );
      CREATE INDEX idx_users_status ON users(status);
      CREATE INDEX idx_users_role ON users(role);

      CREATE TABLE records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        filename TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        mime TEXT NOT NULL DEFAULT '',
        is_text INTEGER NOT NULL DEFAULT 0,
        destination TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'sending',
        sha256 TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX idx_records_user ON records(user_id);
      CREATE INDEX idx_records_dest ON records(destination);
      CREATE INDEX idx_records_status ON records(status);
      CREATE INDEX idx_records_started ON records(started_at);

      CREATE TABLE audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        user_id INTEGER,
        username TEXT,
        action TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        ip TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_audit_ts ON audit(ts);

      CREATE TABLE login_lock (
        username TEXT PRIMARY KEY,
        fail_count INTEGER NOT NULL DEFAULT 0,
        first_fail_at TEXT,
        locked_until TEXT
      );

      CREATE TABLE captcha (
        id TEXT PRIMARY KEY,
        answer_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX idx_captcha_expires ON captcha(expires_at);
    `);
  },
  // v2：传输内容备份（backup_path 为 dataDir 下的相对路径，空串表示未备份）
  (db) => {
    db.exec(`
      ALTER TABLE records ADD COLUMN backup_path TEXT NOT NULL DEFAULT '';
      ALTER TABLE records ADD COLUMN backup_size INTEGER NOT NULL DEFAULT 0;
    `);
  },
];

/* ------------------------------- 数据类 ------------------------------- */
class RqrDb {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.dbPath = dbPath;
    this.migrate();
    this._prepare();
  }

  migrate() {
    const db = this.db;
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
    const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
    for (let i = 0; i < MIGRATIONS.length; i++) {
      const version = i + 1;
      if (applied.has(version)) continue;
      const run = db.transaction(() => {
        MIGRATIONS[i](db);
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, nowISO());
      });
      run();
    }
  }

  _prepare() {
    const db = this.db;
    /* users */
    this.st = {
      userByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
      userById: db.prepare('SELECT * FROM users WHERE id = ?'),
      insertUser: db.prepare(
        'INSERT INTO users (username, display_name, pass_hash, role, status, must_change_password, created_at, created_by) VALUES (@username, @display_name, @pass_hash, @role, @status, @must_change_password, @created_at, @created_by)'
      ),
      updateUserApprove: db.prepare(
        'UPDATE users SET status = ?, approved_by = ?, approved_at = ?, reject_reason = ? WHERE id = ?'
      ),
      updateUserStatus: db.prepare('UPDATE users SET status = ? WHERE id = ?'),
      updateUserRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
      updateUserPassword: db.prepare('UPDATE users SET pass_hash = ?, must_change_password = ? WHERE id = ?'),
      updateUserLogin: db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?'),
      updateUserDisplay: db.prepare('UPDATE users SET display_name = ? WHERE id = ?'),
      listUsers: db.prepare(`
        SELECT id, username, display_name, role, status, must_change_password, created_at, created_by,
               approved_by, approved_at, reject_reason, last_login_at
        FROM users
        WHERE (@status = '' OR status = @status)
          AND (@q = '' OR username LIKE @like OR display_name LIKE @like)
        ORDER BY id ASC LIMIT @limit OFFSET @offset
      `),
      countUsers: db.prepare(`
        SELECT COUNT(*) AS n FROM users
        WHERE (@status = '' OR status = @status)
          AND (@q = '' OR username LIKE @like OR display_name LIKE @like)
      `),
      adminCount: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'"),

      /* records */
      insertRecord: db.prepare(`
        INSERT INTO records (user_id, username, filename, size, mime, is_text, destination, status, sha256, note, started_at, backup_path, backup_size)
        VALUES (@user_id, @username, @filename, @size, @mime, @is_text, @destination, @status, @sha256, @note, @started_at, @backup_path, @backup_size)
      `),
      recordById: db.prepare('SELECT * FROM records WHERE id = ?'),
      setRecordBackup: db.prepare('UPDATE records SET backup_path = ?, backup_size = ? WHERE id = ?'),
      clearRecordBackup: db.prepare("UPDATE records SET backup_path = '', backup_size = 0 WHERE id = ?"),
      updateRecordStatus: db.prepare(`
        UPDATE records SET status = @status, completed_at = COALESCE(@completed_at, completed_at), note = COALESCE(@note, note)
        WHERE id = @id
      `),
      listRecords: db.prepare(`
        SELECT * FROM records
        WHERE (@user_id = 0 OR user_id = @user_id)
          AND (@destination = '' OR destination = @destination)
          AND (@status = '' OR status = @status)
          AND (@from = '' OR started_at >= @from)
          AND (@to = '' OR started_at <= @to)
          AND (@q = '' OR filename LIKE @like)
        ORDER BY started_at DESC, id DESC LIMIT @limit OFFSET @offset
      `),
      countRecords: db.prepare(`
        SELECT COUNT(*) AS n FROM records
        WHERE (@user_id = 0 OR user_id = @user_id)
          AND (@destination = '' OR destination = @destination)
          AND (@status = '' OR status = @status)
          AND (@from = '' OR started_at >= @from)
          AND (@to = '' OR started_at <= @to)
          AND (@q = '' OR filename LIKE @like)
      `),

      /* audit */
      insertAudit: db.prepare('INSERT INTO audit (ts, user_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?, ?)'),
      listAudit: db.prepare(`
        SELECT * FROM audit
        WHERE (@q = '' OR username LIKE @like OR action LIKE @like OR detail LIKE @like)
        ORDER BY id DESC LIMIT @limit OFFSET @offset
      `),
      countAudit: db.prepare(`
        SELECT COUNT(*) AS n FROM audit
        WHERE (@q = '' OR username LIKE @like OR action LIKE @like OR detail LIKE @like)
      `),

      /* login lock */
      loginLockByUser: db.prepare('SELECT * FROM login_lock WHERE username = ?'),
      upsertLoginLock: db.prepare(`
        INSERT INTO login_lock (username, fail_count, first_fail_at, locked_until) VALUES (?, ?, ?, ?)
        ON CONFLICT(username) DO UPDATE SET fail_count = excluded.fail_count,
          first_fail_at = excluded.first_fail_at, locked_until = excluded.locked_until
      `),
      clearLoginLock: db.prepare('DELETE FROM login_lock WHERE username = ?'),

      /* captcha */
      captchaById: db.prepare('SELECT * FROM captcha WHERE id = ?'),
      insertCaptcha: db.prepare('INSERT INTO captcha (id, answer_hash, expires_at) VALUES (?, ?, ?)'),
      deleteCaptcha: db.prepare('DELETE FROM captcha WHERE id = ?'),
      purgeCaptcha: db.prepare('DELETE FROM captcha WHERE expires_at < ?'),

      /* stats */
      statOverview: db.prepare(`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(size), 0) AS total_bytes,
               COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
               COALESCE(SUM(CASE WHEN status = 'sending' THEN 1 ELSE 0 END), 0) AS sending
        FROM records WHERE (@user_id = 0 OR user_id = @user_id)
      `),
      statByDestination: db.prepare(`
        SELECT destination, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes,
               COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed
        FROM records WHERE (@user_id = 0 OR user_id = @user_id)
        GROUP BY destination ORDER BY n DESC
      `),
      statByUser: db.prepare(`
        SELECT user_id, username, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes,
               COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed
        FROM records GROUP BY user_id ORDER BY n DESC LIMIT @limit
      `),
      statDaily: db.prepare(`
        SELECT substr(started_at, 1, 10) AS day, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes
        FROM records WHERE started_at >= @from GROUP BY day ORDER BY day ASC
      `),
      statUserSummary: db.prepare(`
        SELECT destination, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes,
               COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed
        FROM records WHERE user_id = @user_id GROUP BY destination ORDER BY n DESC
      `),
    };
  }

  /* ------------------------------ users ------------------------------ */
  getUserByUsername(username) {
    return this.st.userByUsername.get(username);
  }
  getUserById(id) {
    return this.st.userById.get(id);
  }
  createUser({ username, displayName, passHash, role = 'user', status = 'pending', mustChangePassword = 0, createdBy = null }) {
    const info = this.st.insertUser.run({
      username,
      display_name: displayName,
      pass_hash: passHash,
      role,
      status,
      must_change_password: mustChangePassword ? 1 : 0,
      created_at: nowISO(),
      created_by: createdBy,
    });
    return this.getUserById(info.lastInsertRowid);
  }
  approveUser(id, approve, approvedBy, rejectReason = '') {
    const status = approve ? 'active' : 'rejected';
    const info = this.st.updateUserApprove.run(status, approve ? approvedBy : null, approve ? nowISO() : null, approve ? '' : rejectReason, id);
    return info.changes > 0;
  }
  setUserStatus(id, status) {
    return this.st.updateUserStatus.run(status, id).changes > 0;
  }
  setUserRole(id, role) {
    return this.st.updateUserRole.run(role, id).changes > 0;
  }
  setUserPassword(id, passHash, mustChangePassword = 0) {
    return this.st.updateUserPassword.run(passHash, mustChangePassword ? 1 : 0, id).changes > 0;
  }
  touchLogin(id) {
    this.st.updateUserLogin.run(nowISO(), id);
  }
  listUsers({ status = '', q = '', page = 1, pageSize = 50 }) {
    const like = `%${q}%`;
    const offset = (page - 1) * pageSize;
    const rows = this.st.listUsers.all({ status, q, like, limit: pageSize, offset });
    const { n } = this.st.countUsers.get({ status, q, like });
    return { rows, total: n, page, pageSize };
  }
  activeAdminCount() {
    return this.st.adminCount.get().n;
  }

  /* ----------------------------- records ----------------------------- */
  createRecord({ userId, username, filename, size, mime, isText, destination, sha256, note, backupPath = '', backupSize = 0 }) {
    const info = this.st.insertRecord.run({
      user_id: userId,
      username,
      filename,
      size: size || 0,
      mime: mime || '',
      is_text: isText ? 1 : 0,
      destination,
      status: 'sending',
      sha256: sha256 || '',
      note: note || '',
      started_at: nowISO(),
      backup_path: backupPath || '',
      backup_size: backupSize || 0,
    });
    return this.st.recordById.get(info.lastInsertRowid);
  }
  getRecord(id) {
    return this.st.recordById.get(id);
  }
  setRecordBackup(id, backupPath, backupSize) {
    return this.st.setRecordBackup.run(backupPath || '', backupSize || 0, id).changes > 0;
  }
  clearRecordBackup(id) {
    return this.st.clearRecordBackup.run(id).changes > 0;
  }
  updateRecordStatus(id, status, completedAt = null, note = null) {
    const ts = status === 'completed' || status === 'stopped' || status === 'failed' ? nowISO() : null;
    return this.st.updateRecordStatus.run({ id, status, completed_at: completedAt || ts, note }).changes > 0;
  }
  listRecords({ userId = 0, destination = '', status = '', from = '', to = '', q = '', page = 1, pageSize = 50 }) {
    const like = `%${q}%`;
    const offset = (page - 1) * pageSize;
    const rows = this.st.listRecords.all({ user_id: userId, destination, status, from, to, q, like, limit: pageSize, offset });
    const { n } = this.st.countRecords.get({ user_id: userId, destination, status, from, to, q, like });
    return { rows, total: n, page, pageSize };
  }

  /* ------------------------------ audit ------------------------------ */
  audit({ userId = null, username = '', action, detail = '', ip = '' }) {
    this.st.insertAudit.run(nowISO(), userId, username, action, detail.slice(0, 2000), ip || '');
  }
  listAudit({ q = '', page = 1, pageSize = 50 }) {
    const like = `%${q}%`;
    const offset = (page - 1) * pageSize;
    const rows = this.st.listAudit.all({ q, like, limit: pageSize, offset });
    const { n } = this.st.countAudit.get({ q, like });
    return { rows, total: n, page, pageSize };
  }

  /* ---------------------------- login lock ---------------------------- */
  loginLockState(username) {
    const row = this.st.loginLockByUser.get(username);
    const now = Date.now();
    if (!row) return { locked: false, failCount: 0, needCaptcha: false };
    if (row.locked_until && new Date(row.locked_until).getTime() > now) {
      return { locked: true, failCount: row.fail_count, needCaptcha: true, lockedUntil: row.locked_until };
    }
    return { locked: false, failCount: row.fail_count, needCaptcha: false };
  }
  registerLoginFail(username, maxFails, windowMinutes, lockMinutes) {
    const row = this.st.loginLockByUser.get(username);
    const now = Date.now();
    let failCount = 1;
    let firstFailAt = now;
    let lockedUntil = null;
    if (row && row.first_fail_at) {
      const first = new Date(row.first_fail_at).getTime();
      if (now - first < windowMinutes * 60 * 1000 && !row.locked_until) {
        failCount = row.fail_count + 1;
        firstFailAt = first;
      } else if (row.locked_until && new Date(row.locked_until).getTime() > now) {
        failCount = row.fail_count + 1;
        firstFailAt = first;
        lockedUntil = row.locked_until;
      }
    }
    if (failCount >= maxFails && !lockedUntil) {
      lockedUntil = new Date(now + lockMinutes * 60 * 1000).toISOString();
    }
    this.st.upsertLoginLock.run(
      username,
      failCount,
      new Date(firstFailAt).toISOString(),
      lockedUntil
    );
    return { failCount, lockedUntil, locked: !!lockedUntil };
  }
  clearLoginLock(username) {
    this.st.clearLoginLock.run(username);
  }

  /* ----------------------------- captcha ----------------------------- */
  saveCaptcha(id, answerHash, ttlMinutes) {
    this.st.insertCaptcha.run(id, answerHash, new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString());
  }
  getCaptcha(id) {
    return this.st.captchaById.get(id);
  }
  consumeCaptcha(id) {
    this.st.deleteCaptcha.run(id);
  }
  purgeCaptchas() {
    this.st.purgeCaptcha.run(nowISO());
  }

  /* ------------------------------- stats ------------------------------ */
  overview(userId = 0) {
    return this.st.statOverview.get({ user_id: userId });
  }
  byDestination(userId = 0) {
    return this.st.statByDestination.all({ user_id: userId });
  }
  byUser(limit = 100) {
    return this.st.statByUser.all({ limit });
  }
  daily(fromISO, days = 30) {
    const rows = this.st.statDaily.all({ from: fromISO });
    // 补齐缺失日期为 0，保证趋势图连续
    const map = new Map(rows.map((r) => [r.day, r]));
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      out.push(map.get(d) || { day: d, n: 0, bytes: 0 });
    }
    return out;
  }
  userSummary(userId) {
    return this.st.statUserSummary.all({ user_id: userId });
  }

  /* ------------------------------ session ----------------------------- */
  cleanupSessions() {
    // 扫描 express_session 表，按 session 内 expiresAt 删除过期会话
    const rows = this.db.prepare('SELECT id, data FROM express_session').all();
    const del = this.db.prepare('DELETE FROM express_session WHERE id = ?');
    const now = Date.now();
    let n = 0;
    for (const row of rows) {
      try {
        const data = JSON.parse(row.data);
        const exp = data && data.expiresAt ? new Date(data.expiresAt).getTime() : 0;
        if (exp && exp < now) { del.run(row.id); n++; }
      } catch (_) { /* 保留无法解析的行 */ }
    }
    return n;
  }
  destroyUserSessions(userId) {
    // 重置密码/停用后销毁该用户全部会话，强制重新登录
    const rows = this.db.prepare('SELECT id, data FROM express_session').all();
    const del = this.db.prepare('DELETE FROM express_session WHERE id = ?');
    let n = 0;
    for (const row of rows) {
      try {
        const data = JSON.parse(row.data);
        if (data && data.userId === userId) { del.run(row.id); n++; }
      } catch (_) { /* 保留无法解析的行 */ }
    }
    return n;
  }

  /* ------------------------------ backup ------------------------------ */
  backup(destPath) {
    // 官方 backup API：在线安全备份（WAL checkpoint 语义）
    fs.mkdirSync(path.dirname(destPath), { recursive: true, mode: 0o700 });
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    return new Promise((resolve, reject) => {
      this.db.backup(destPath)
        .then(() => resolve(destPath))
        .catch(reject);
    });
  }
  checkpoint() {
    try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) { /* 尽力而为 */ }
  }
  close() {
    try { this.db.close(); } catch (_) { /* 已关闭 */ }
  }
}

/* 会话 token 哈希（落库只存 sha256） */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { RqrDb, hashToken, nowISO };
