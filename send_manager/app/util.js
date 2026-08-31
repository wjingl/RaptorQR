'use strict';
/* ============================================================================
 * 通用工具：HTTP 错误、异步包装、认证中间件、用户脱敏、HTML 转义
 * ========================================================================== */

class HttpError extends Error {
  constructor(status, message) {
    // message 可为对象（结构化载荷，如 needCaptcha/failCount）；Error 会将其字符串化，故单独保存 payload
    super(typeof message === 'object' && message !== null ? (message.message || '请求失败') : message);
    this.status = status;
    this.payload = typeof message === 'object' && message !== null ? message : null;
  }
}

/** Express 5 已原生支持 async handler，此包装仅用于显式类型标注（保留） */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function httpError(status, message) {
  return new HttpError(status, message);
}

function sanitizeUser(user) {
  if (!user) return null;
  const { pass_hash, ...safe } = user;
  return safe;
}

/** 用户相关字段直接来自 DB 行，禁止把 pass_hash 传给前端 */
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: '未登录或会话已过期' });
  }
  if (req.session.expiresAt && Date.now() > req.session.expiresAt) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: '会话已过期，请重新登录' });
  }
  // 账号状态实时校验：停用/归档即时失效
  const user = req.app.locals.db.getUserById(req.session.userId);
  if (!user || user.status === 'disabled' || user.status === 'archived') {
    req.session.destroy(() => {});
    return res.status(401).json({ error: '账号不可用，请重新登录' });
  }
  req.user = user;
  req.session.username = user.username;
  req.session.displayName = user.display_name;
  req.session.role = user.role;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: '无权限执行此操作' });
  }
  next();
}

/** 页面路由用：未登录重定向到 /login（而非返回 JSON） */
function requireAuthPage(req, res, next) {
  if (!req.session || !req.session.userId) {
    return redirect(res, '/login');
  }
  if (req.session.expiresAt && Date.now() > req.session.expiresAt) {
    req.session.destroy(() => {});
    return redirect(res, '/login');
  }
  const user = req.app.locals.db.getUserById(req.session.userId);
  if (!user || user.status === 'disabled' || user.status === 'archived') {
    req.session.destroy(() => {});
    return redirect(res, '/login');
  }
  req.user = user;
  req.session.username = user.username;
  req.session.displayName = user.display_name;
  req.session.role = user.role;
  next();
}

function requireAdminPage(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return redirect(res, '/app');
  next();
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 安全重定向：直接写 Location 结束响应，不解析 Accept 头。
 *  （Express res.redirect 会调用 res.format 解析 Accept，畸形头会导致 500） */
function redirect(res, url) {
  if (res.headersSent) return;
  res.statusCode = 302;
  res.setHeader('Location', url);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

function clientIP(req) {
  return req.ip || req.socket?.remoteAddress || '';
}

module.exports = { HttpError, asyncHandler, httpError, sanitizeUser, requireAuth, requireAdmin, requireAuthPage, requireAdminPage, escapeHtml, redirect, clientIP };
