'use strict';
/* ============================================================================
 * 认证模块：注册 / 审批 / 登录（限流+锁定+验证码）/ 会话 / 改密 / 首启建管
 * ========================================================================== */
const crypto = require('crypto');
const Joi = require('joi');
const bcrypt = require('bcryptjs');

const { asyncHandler, httpError, sanitizeUser, clientIP } = require('./util');
const { createCaptcha, verifyCaptcha } = require('./captcha');
const { issueToken } = require('./csrf');
const { DEFAULT_ADMIN } = require('./config');

const BCRYPT_COST = 12;
const RESERVED_USERNAMES = new Set(['admin', 'administrator', 'root', 'system', 'setup', '总管理', 'superadmin']);

function hashPassword(pw) {
  return bcrypt.hash(pw, BCRYPT_COST);
}

function verifyPassword(pw, hash) {
  return bcrypt.compare(pw, hash);
}

/* ============================================================================
 * 部署引导建管：首次启动（无任何管理员）时按配置自动创建超级管理员
 * - 配置：config.admin.bootstrap { enabled, username, password, displayName, forcePasswordChange }
 * - 环境变量覆盖：RQR_ADMIN_USERNAME / RQR_ADMIN_PASSWORD / RQR_ADMIN_DISPLAY
 * - 未配置用户名/密码时使用默认凭据（admin / Admin@1145，首次登录强制改密）
 * - 关闭 bootstrap 时退回 /setup 初始化向导
 * ========================================================================== */
async function bootstrapAdmin(config, db) {
  if (db.activeAdminCount() > 0) return null;
  const b = config.admin.bootstrap;
  if (!b || !b.enabled) return null;

  const username = (b.username || DEFAULT_ADMIN.username).toLowerCase();
  const password = b.password || DEFAULT_ADMIN.password;
  const usingDefault = !b.username || !b.password;

  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
    console.warn(`[bootstrap] 超级管理员用户名无效（${username}），已跳过自动建号，请使用 /setup 初始化`);
    return null;
  }
  if (password.length < config.password.minLength) {
    console.warn('[bootstrap] 超级管理员密码过短，已跳过自动建号，请使用 /setup 初始化');
    return null;
  }

  const existing = db.getUserByUsername(username);
  if (existing) {
    if (existing.role === 'admin' && existing.status === 'active') {
      return { user: existing, usingDefault: false }; // 幂等
    }
    console.warn(`[bootstrap] 用户名 ${username} 已存在但状态异常，已跳过自动建号，请使用 /setup 或 CLI 处理`);
    return null;
  }

  const passHash = await hashPassword(password);
  const user = db.createUser({
    username,
    displayName: b.displayName || username,
    passHash,
    role: 'admin',
    status: 'active',
    mustChangePassword: b.forcePasswordChange !== false ? 1 : 0,
    createdBy: 'bootstrap',
  });
  db.audit({
    userId: user.id,
    username,
    action: 'BOOTSTRAP_ADMIN',
    detail: usingDefault ? '部署默认账号（首次登录强制改密）' : '部署配置账号',
    ip: 'localhost',
  });
  return { user, usingDefault };
}

function createAuth(ctx) {
  const { config, secrets, db } = ctx;
  const pwMin = config.password.minLength;
  const pwMax = config.password.maxLength;

  const passwordSchema = Joi.string()
    .min(pwMin).max(pwMax)
    .message(`密码长度须在 ${pwMin}-${pwMax} 位之间`)
    .required();

  const usernameSchema = Joi.string()
    .min(3).max(32)
    .pattern(/^[a-zA-Z0-9_]+$/)
    .message('用户名仅允许字母、数字、下划线，长度 3-32 位')
    .required();

  const displayNameSchema = Joi.string().min(1).max(50).required();

  const loginSchema = Joi.object({
    username: Joi.string().min(1).max(64).required(),
    password: Joi.string().min(1).max(128).required(),
    captchaId: Joi.string().max(64).allow(''),
    captchaAnswer: Joi.string().max(16).allow(''),
  });

  const registerSchema = Joi.object({
    username: usernameSchema,
    displayName: displayNameSchema,
    password: passwordSchema,
  });

  const changePwSchema = Joi.object({
    oldPassword: Joi.string().min(1).max(128).allow(''),
    newPassword: passwordSchema,
  });

  const setupSchema = Joi.object({
    username: usernameSchema,
    displayName: displayNameSchema,
    password: passwordSchema,
  });

  function needCaptchaFor(username) {
    const state = db.loginLockState(username);
    return config.captcha.enabled && state.failCount >= config.captcha.afterFailures;
  }

  /* ------------------------------ 注册 ------------------------------ */
  async function register(req, res) {
    if (!config.registration.enabled) throw httpError(403, '注册已关闭，请联系管理员开通账号');
    const { value, error } = registerSchema.validate(req.body || {});
    if (error) throw httpError(400, error.message);
    const username = value.username.toLowerCase();
    if (RESERVED_USERNAMES.has(username)) throw httpError(400, '该用户名不可用');
    if (db.getUserByUsername(username)) throw httpError(409, '用户名已存在');
    const passHash = await hashPassword(value.password);
    db.createUser({
      username,
      displayName: value.displayName,
      passHash,
      role: 'user',
      status: 'pending',
      mustChangePassword: 0,
      createdBy: null,
    });
    db.audit({ username, action: 'REGISTER', detail: '自助注册（待审批）', ip: clientIP(req) });
    res.status(201).json({ ok: true, message: '注册成功，请等待管理员审批后登录' });
  }

  /* ------------------------------ 登录 ------------------------------ */
  async function login(req, res) {
    const { value, error } = loginSchema.validate(req.body || {});
    if (error) throw httpError(400, error.message);
    const username = value.username.toLowerCase();
    const ip = clientIP(req);

    const lock = db.loginLockState(username);
    if (lock.locked) {
      db.audit({ username, action: 'LOGIN_LOCKED', detail: `锁定至 ${lock.lockedUntil}`, ip });
      throw httpError(423, '尝试次数过多，账号已临时锁定，请稍后再试');
    }

    const needCaptcha = needCaptchaFor(username);
    if (needCaptcha) {
      const ok = verifyCaptcha(db, secrets, value.captchaId, value.captchaAnswer);
      if (!ok) {
        db.audit({ username, action: 'CAPTCHA_FAIL', detail: '验证码错误', ip });
        throw httpError(400, { message: '验证码错误或已过期', needCaptcha: true });
      }
    }

    const user = db.getUserByUsername(username);
    if (!user) {
      const st = db.registerLoginFail(username, config.lockout.maxFails, config.lockout.windowMinutes, config.lockout.lockMinutes);
      db.audit({ username, action: 'LOGIN_FAIL', detail: '用户名不存在', ip });
      throw httpError(401, { message: '用户名或密码错误', failCount: st.failCount, needCaptcha: needCaptchaFor(username) });
    }

    if (user.status === 'pending') throw httpError(403, '账号待审批，请等待管理员通过');
    if (user.status === 'rejected') throw httpError(403, `注册申请已被驳回${user.reject_reason ? `：${user.reject_reason}` : ''}`);
    if (user.status === 'disabled') throw httpError(403, '账号已被停用，请联系管理员');
    if (user.status === 'archived') throw httpError(403, '账号已归档');

    const okPw = await verifyPassword(value.password, user.pass_hash);
    if (!okPw) {
      const st = db.registerLoginFail(username, config.lockout.maxFails, config.lockout.windowMinutes, config.lockout.lockMinutes);
      db.audit({ userId: user.id, username, action: 'LOGIN_FAIL', detail: '密码错误', ip });
      throw httpError(401, { message: '用户名或密码错误', failCount: st.failCount, needCaptcha: needCaptchaFor(username) });
    }

    // 登录成功：清锁定、轮换会话（防固定）、写会话
    db.clearLoginLock(username);
    db.touchLogin(user.id);
    db.audit({ userId: user.id, username, action: 'LOGIN_OK', ip });

    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.displayName = user.display_name;
    req.session.role = user.role;
    req.session.mustChangePassword = user.must_change_password === 1;
    req.session.createdAt = Date.now();
    req.session.expiresAt = Date.now() + config.session.absoluteTtlHours * 3600 * 1000;
    req.session.csrfSecret = crypto.randomBytes(24).toString('hex');

    res.json({
      ok: true,
      user: sanitizeUser(user),
      mustChangePassword: user.must_change_password === 1,
      csrfToken: issueToken(req),
    });
  }

  /* ------------------------------ 登出 ------------------------------ */
  function logout(req, res) {
    const username = req.session?.username || '';
    if (req.session?.userId) {
      db.audit({ userId: req.session.userId, username, action: 'LOGOUT', ip: clientIP(req) });
    }
    req.session.destroy(() => {
      res.clearCookie('rqr_sess', { path: '/' });
      res.json({ ok: true });
    });
  }

  /* --------------------------- 当前会话 --------------------------- */
  function sessionInfo(req, res) {
    if (!req.session?.userId) {
      return res.json({ authenticated: false });
    }
    const user = db.getUserById(req.session.userId);
    // 停用/归档/已删除即时失效
    if (!user || user.status === 'disabled' || user.status === 'archived') {
      req.session.destroy(() => {});
      return res.json({ authenticated: false });
    }
    res.json({
      authenticated: true,
      user: sanitizeUser(user),
      mustChangePassword: req.session.mustChangePassword || user.must_change_password === 1,
      csrfToken: issueToken(req),
    });
  }

  /* --------------------------- 修改密码 --------------------------- */
  async function changePassword(req, res, forced) {
    const { value, error } = changePwSchema.validate(req.body || {});
    if (error) throw httpError(400, error.message);
    if (!forced && !value.oldPassword) throw httpError(400, '请提供当前密码');
    const user = db.getUserById(req.session.userId);
    if (!user) throw httpError(401, '账号不存在');

    if (!forced) {
      const ok = await verifyPassword(value.oldPassword, user.pass_hash);
      if (!ok) {
        db.audit({ userId: user.id, username: user.username, action: 'PASSWORD_CHANGE_FAIL', detail: '当前密码错误', ip: clientIP(req) });
        throw httpError(400, '当前密码不正确');
      }
    }
    const newHash = await hashPassword(value.newPassword);
    db.setUserPassword(user.id, newHash, 0);
    db.audit({ userId: user.id, username: user.username, action: forced ? 'PASSWORD_CHANGED_FORCED' : 'PASSWORD_CHANGED', ip: clientIP(req) });
    // 改密后强制重新登录（销毁当前会话）
    req.session.destroy(() => {
      res.clearCookie('rqr_sess', { path: '/' });
      res.json({ ok: true, message: '密码已修改，请重新登录' });
    });
  }

  /* --------------------------- 验证码 --------------------------- */
  function captcha(req, res) {
    const c = createCaptcha(db, secrets, config);
    res.type('application/json').json({ id: c.id, svg: c.svg });
  }

  /* --------------------------- 首启建管 --------------------------- */
  async function setup(req, res) {
    if (db.activeAdminCount() > 0) throw httpError(403, '系统已完成初始化');
    const { value, error } = setupSchema.validate(req.body || {});
    if (error) throw httpError(400, error.message);
    const username = value.username.toLowerCase();
    if (RESERVED_USERNAMES.has(username)) throw httpError(400, '该用户名不可用');
    if (db.getUserByUsername(username)) throw httpError(409, '用户名已存在');
    const passHash = await hashPassword(value.password);
    const admin = db.createUser({
      username,
      displayName: value.displayName,
      passHash,
      role: 'admin',
      status: 'active',
      mustChangePassword: 0,
      createdBy: 'setup',
    });
    db.audit({ userId: admin.id, username, action: 'SETUP_ADMIN', detail: '首次初始化创建总管理', ip: clientIP(req) });
    res.status(201).json({ ok: true, message: '总管理账号创建成功，请登录' });
  }

  return {
    register: asyncHandler(register),
    login: asyncHandler(login),
    logout,
    sessionInfo,
    changePassword: asyncHandler((req, res) => changePassword(req, res, false)),
    changePasswordForced: asyncHandler((req, res) => changePassword(req, res, true)),
    captcha,
    setup: asyncHandler(setup),
    hashPassword,
    verifyPassword,
  };
}

module.exports = { createAuth, bootstrapAdmin };
