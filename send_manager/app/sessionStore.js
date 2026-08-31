'use strict';
/* ============================================================================
 * 会话存储：express-session 的 SQLite Store
 * - 库中只存 sid 的 sha256（杜绝明文会话标识落库）
 * - 表结构自保证（CREATE TABLE IF NOT EXISTS），不依赖外部迁移版本
 * - 提供按过期时间清理的接口（服务器定时调用）
 * ========================================================================== */
const crypto = require('crypto');

function hashSid(sid) {
  return crypto.createHash('sha256').update(sid).digest('hex');
}

module.exports = function makeHashedSqliteStore(expressSession, db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS express_session (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_express_session_expires ON express_session(expires_at);
  `);

  const st = {
    get: db.prepare('SELECT data FROM express_session WHERE id = ?'),
    set: db.prepare(`
      INSERT INTO express_session (id, data, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at
    `),
    destroy: db.prepare('DELETE FROM express_session WHERE id = ?'),
    length: db.prepare('SELECT COUNT(*) AS n FROM express_session'),
    clear: db.prepare('DELETE FROM express_session'),
    all: db.prepare('SELECT id, data FROM express_session'),
  };

  class HashedSqliteStore extends expressSession.Store {
    get(sid, callback) {
      try {
        const row = st.get.get(hashSid(sid));
        callback(null, row ? JSON.parse(row.data) : null);
      } catch (err) { callback(err); }
    }
    set(sid, sess, callback) {
      try {
        // 兼容 express-session 的 touch 默认实现：sess 可能被更新
        const expiresAt = sess.expiresAt ? new Date(sess.expiresAt).getTime() : 0;
        st.set.run(hashSid(sid), JSON.stringify(sess), expiresAt);
        callback(null);
      } catch (err) { callback(err); }
    }
    destroy(sid, callback) {
      try { st.destroy.run(hashSid(sid)); callback(null); } catch (err) { callback(err); }
    }
    touch(sid, sess, callback) {
      this.set(sid, sess, callback);
    }
    length(callback) {
      try { callback(null, st.length.get().n); } catch (err) { callback(err); }
    }
    clear(callback) {
      try { st.clear.run(); callback(null); } catch (err) { callback(err); }
    }
    all(callback) {
      try {
        callback(null, st.all.all().map((r) => ({ id: r.id, data: JSON.parse(r.data) })));
      } catch (err) { callback(err); }
    }
  }

  return HashedSqliteStore;
};

/* 清理过期会话：删除 expires_at < now 的记录（供定时任务调用） */
module.exports.cleanupExpired = function cleanupExpired(db) {
  const del = db.prepare('DELETE FROM express_session WHERE expires_at > 0 AND expires_at < ?');
  return del.run(Date.now()).changes;
};
