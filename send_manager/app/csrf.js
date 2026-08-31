'use strict';
/* ============================================================================
 * CSRF 防护：SameSite=Strict 主防御 + 双提交令牌 + Origin 校验（纵深）
 * - 令牌由 csrf（pillarjs 官方）基于会话内随机 secret 生成
 * - 写请求必须携带 X-CSRF-Token 头，且 Origin（如存在）须与 Host 一致
 * ========================================================================== */
const crypto = require('crypto');
const Tokens = require('csrf');
const tokens = new Tokens();

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function getCsrfSecret(req) {
  if (!req.session.csrfSecret) {
    req.session.csrfSecret = crypto.randomBytes(24).toString('hex');
  }
  return req.session.csrfSecret;
}

function createToken(req) {
  return tokens.create(getCsrfSecret(req));
}

function verifyToken(req) {
  if (!req.session.csrfSecret) return false;
  const header = req.headers['x-csrf-token'];
  if (!header) return false;
  return tokens.verify(req.session.csrfSecret, String(header));
}

function verifyOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 无 Origin（同源表单/非浏览器）交给令牌校验
  try {
    const o = new URL(origin);
    const host = req.headers.host;
    // host 可能含端口；URL.host 同样含端口，直接比对
    if (o.host !== host && o.host !== req.app.get('trustedHost')) {
      return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

/** 写请求统一走此中间件 */
function csrfProtect(req, res, next) {
  if (!WRITE_METHODS.has(req.method)) return next();
  if (!verifyOrigin(req)) {
    return res.status(403).json({ error: '请求来源校验失败' });
  }
  if (!verifyToken(req)) {
    return res.status(403).json({ error: 'CSRF 令牌缺失或无效' });
  }
  next();
}

/** 供页面返回令牌：登录后前端从 /api/auth/session 的 csrfToken 字段获取 */
function issueToken(req) {
  return createToken(req);
}

module.exports = { csrfProtect, issueToken, verifyToken };
