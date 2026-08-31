'use strict';
/* ============================================================================
 * 敏感值管理：首启生成会话密钥 / 验证码盐 / CSRF 盐，
 * 存 data/secrets.json（chmod 600，仅服务账号可读），不入库、不入版本控制。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadSecrets(dataDir) {
  const file = path.join(dataDir, 'secrets.json');
  if (fs.existsSync(file)) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`secrets.json 解析失败: ${err.message}`);
    }
    if (!data.sessionSecret || typeof data.sessionSecret !== 'string') {
      throw new Error('secrets.json 缺少 sessionSecret，请修复或删除该文件重新生成');
    }
    return data;
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const secrets = {
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    captchaSalt: crypto.randomBytes(16).toString('hex'),
    csrfSalt: crypto.randomBytes(16).toString('hex'),
  };
  fs.writeFileSync(file, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) { /* 某些文件系统不支持 */ }
  return secrets;
}

module.exports = { loadSecrets };
