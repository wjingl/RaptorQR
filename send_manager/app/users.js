'use strict';
/* ============================================================================
 * 用户管理 API（总管理专属）：列表/审批/批量注册/重置密码/停用启用/角色
 * 所有操作写审计日志；密码只重置不可读。
 * ========================================================================== */
const Joi = require('joi');
const { asyncHandler, httpError, sanitizeUser, clientIP } = require('./util');

function createUsersApi(ctx) {
  const { config, db, auth } = ctx;

  const idSchema = Joi.number().integer().min(1).required();

  function getAdmin(req) {
    return db.getUserById(req.session.userId);
  }

  /* ------------------------------ 列表 ------------------------------ */
  function list(req, res) {
    const q = String(req.query.q || '').slice(0, 64);
    const status = String(req.query.status || '').slice(0, 16);
    const allowed = ['', 'pending', 'active', 'disabled', 'archived', 'rejected'];
    if (!allowed.includes(status)) throw httpError(400, '无效的状态筛选');
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(config.limits.maxPageSize, Math.max(1, parseInt(req.query.pageSize, 10) || config.limits.pageSize));
    const data = db.listUsers({ status, q, page, pageSize });
    res.json({ rows: data.rows, total: data.total, page: data.page, pageSize: data.pageSize });
  }

  /* ------------------------------ 审批 ------------------------------ */
  async function approve(req, res) {
    const id = idSchema.validate(req.params.id).value;
    const schema = Joi.object({
      decision: Joi.string().valid('approve', 'reject').required(),
      reason: Joi.string().max(200).allow(''),
    });
    const { value, error } = schema.validate(req.body || {});
    if (error) throw httpError(400, error.message);
    const user = db.getUserById(id);
    if (!user) throw httpError(404, '用户不存在');
    if (user.status !== 'pending') throw httpError(409, '该账号不在待审批状态');
    db.approveUser(id, value.decision === 'approve', getAdmin(req).username, value.reason || '');
    db.audit({
      userId: getAdmin(req).id,
      username: getAdmin(req).username,
      action: value.decision === 'approve' ? 'USER_APPROVE' : 'USER_REJECT',
      detail: `${user.username}${value.reason ? `：${value.reason}` : ''}`,
      ip: clientIP(req),
    });
    res.json({ ok: true });
  }

  /* ------------------------------ 批量注册 ------------------------------ */
  async function batchRegister(req, res) {
    const schema = Joi.object({
      lines: Joi.string().max(200000).required(),
    });
    const { value, error } = schema.validate(req.body || {});
    if (error) throw httpError(400, '批量注册内容无效或过大');

    const admin = getAdmin(req);
    const initialPassword = config.batchRegister.initialPassword;
    if (!initialPassword || initialPassword.length < config.password.minLength) {
      throw httpError(500, '系统未配置有效的初始密码（config.batchRegister.initialPassword）');
    }

    // 解析：每行 "用户名,姓名" 或 "用户名"（兼容逗号/制表符/中文逗号）
    const seen = new Set();
    const results = { created: 0, failed: 0, errors: [] };
    const passHash = await auth.hashPassword(initialPassword);

    for (const rawLine of value.lines.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      let username = '';
      let displayName = '';
      const parts = line.split(/[,\t，]/).map((s) => s.trim());
      username = parts[0] || '';
      displayName = parts[1] || parts[0] || '';
      const uname = username.toLowerCase();
      if (!/^[a-zA-Z0-9_]{3,32}$/.test(uname) || seen.has(uname)) {
        results.failed++;
        results.errors.push(`${line}：无效或重复的用户名`);
        continue;
      }
      if (db.getUserByUsername(uname)) {
        results.failed++;
        results.errors.push(`${line}：用户名已存在`);
        continue;
      }
      seen.add(uname);
      db.createUser({
        username: uname,
        displayName: displayName.slice(0, 50),
        passHash,
        role: 'user',
        status: 'active',
        mustChangePassword: 1,
        createdBy: admin.username,
      });
      results.created++;
    }

    db.audit({
      userId: admin.id,
      username: admin.username,
      action: 'USER_BATCH_REGISTER',
      detail: `批量注册成功 ${results.created} 个，失败 ${results.failed} 个`,
      ip: clientIP(req),
    });
    res.status(201).json({ ok: true, ...results });
  }

  /* ------------------------------ 重置密码 ------------------------------ */
  async function resetPassword(req, res) {
    const id = idSchema.validate(req.params.id).value;
    const user = db.getUserById(id);
    if (!user) throw httpError(404, '用户不存在');
    const admin = getAdmin(req);
    if (user.id === admin.id) throw httpError(400, '不能重置自己的密码');

    const newPw = cryptoRandomPassword();
    const passHash = await auth.hashPassword(newPw);
    db.setUserPassword(id, passHash, 1);
    db.audit({
      userId: admin.id,
      username: admin.username,
      action: 'USER_RESET_PASSWORD',
      detail: `为 ${user.username} 重置密码（下次登录强制改密）`,
      ip: clientIP(req),
    });
    // 销毁该用户所有会话，强制其重新登录
    db.destroyUserSessions(id);
    res.json({ ok: true, message: '密码已重置', temporaryPassword: newPw });
  }

  /* ------------------------------ 停用/启用/归档 ------------------------------ */
  function setStatus(req, res) {
    const id = idSchema.validate(req.params.id).value;
    const schema = Joi.object({
      action: Joi.string().valid('disable', 'enable', 'archive').required(),
    });
    const { value, error } = schema.validate(req.body || {});
    if (error) throw httpError(400, error.message);
    const user = db.getUserById(id);
    if (!user) throw httpError(404, '用户不存在');
    const admin = getAdmin(req);
    if (user.id === admin.id) throw httpError(400, '不能操作自己的账号');

    const statusMap = { disable: 'disabled', enable: 'active', archive: 'archived' };
    db.setUserStatus(id, statusMap[value.action]);
    db.audit({
      userId: admin.id,
      username: admin.username,
      action: `USER_${value.action.toUpperCase()}`,
      detail: user.username,
      ip: clientIP(req),
    });
    res.json({ ok: true });
  }

  /* ------------------------------ 角色 ------------------------------ */
  function setRole(req, res) {
    const id = idSchema.validate(req.params.id).value;
    const schema = Joi.object({ role: Joi.string().valid('user', 'admin').required() });
    const { value, error } = schema.validate(req.body || {});
    if (error) throw httpError(400, error.message);
    const user = db.getUserById(id);
    if (!user) throw httpError(404, '用户不存在');
    const admin = getAdmin(req);
    if (user.id === admin.id && value.role !== 'admin') throw httpError(400, '不能降级自己的角色');
    db.setUserRole(id, value.role);
    db.audit({
      userId: admin.id,
      username: admin.username,
      action: 'USER_ROLE_CHANGE',
      detail: `${user.username} → ${value.role}`,
      ip: clientIP(req),
    });
    res.json({ ok: true });
  }

  return {
    list: asyncHandler(list),
    approve: asyncHandler(approve),
    batchRegister: asyncHandler(batchRegister),
    resetPassword: asyncHandler(resetPassword),
    setStatus: asyncHandler(setStatus),
    setRole: asyncHandler(setRole),
  };
}

/* 随机临时密码：字母+数字，12 位，避免易混字符 */
function cryptoRandomPassword() {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = require('crypto').randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += charset[bytes[i] % charset.length];
  return out;
}

module.exports = { createUsersApi };
