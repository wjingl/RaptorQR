'use strict';
/* ============================================================================
 * 服务器入口：Express 5 + helmet + 会话 + 限流 + 路由 + 错误处理 + 优雅停机
 * 用法：
 *   node app/server.js                 # 启动（读 config.json）
 *   RQR_CONFIG=xxx node app/server.js  # 指定配置路径
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const rfs = require('rotating-file-stream');

const { loadConfig, ROOT } = require('./config');
const { loadSecrets } = require('./secrets');
const { RqrDb } = require('./db');
const makeSessionStore = require('./sessionStore');
const { createAuth } = require('./auth');
const { createUsersApi } = require('./users');
const { createRecordsApi } = require('./records');
const { csrfProtect, issueToken } = require('./csrf');
const { createBridge } = require('./bridge');
const { cleanupBackups } = require('./backup');
const { HttpError, requireAuth, requireAdmin, requireAuthPage, requireAdminPage, redirect, clientIP } = require('./util');
const { bootstrapAdmin } = require('./auth');

const SENDER_HTML = path.join(__dirname, 'sender', 'RaptorQR_彩色版.html');
const STATIC_DIR = path.join(__dirname, 'static');
const RECEIVER_OUT = path.join(ROOT, 'receiver', 'out');

/* ------------------------------ 安全头 / CSP ------------------------------ */
const CSP_STRICT = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

/* /app 与接收端页需放行内联脚本 / data: worker / blob: / WebAssembly（单文件应用的 worker、WASM 与编码机制） */
const CSP_APP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' data: 'wasm-unsafe-eval'",  // wasm-unsafe-eval：允许 WebAssembly 编译而不放开 eval（编码依赖 instantiateStreaming）
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' data: blob:",  // 关键：wasm 经 fetch(data:) 加载，connect-src 必须放行 data:
  "worker-src 'self' blob: data:",
  "child-src blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
  "form-action 'self'",
].join('; ');

/* ------------------------------ 应用装配 ------------------------------ */
function createApp(ctx) {
  const { config, secrets, db } = ctx;
  const app = express();
  app.locals.db = db;
  app.locals.config = config;
  app.disable('x-powered-by');

  if (config.security.trustProxy) app.set('trust proxy', 1);

  /* ---- 请求体大小上限（防内存耗尽） ---- */
  app.use('/api/auth', express.json({ limit: config.limits.jsonBody }));
  app.use('/api/users', express.json({ limit: config.limits.batchBody }));
  app.use('/api/records', express.json({ limit: config.limits.uploadBody })); // 含传输内容备份（base64）
  app.use('/api/setup', express.json({ limit: config.limits.jsonBody }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));

  /* ---- 日志（按天轮转，仅记录请求行，不含请求体） ---- */
  const logDir = path.join(config.dataDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const accessStream = rfs.createStream('access-%DATE%.log', {
    path: logDir, interval: '1d', maxFiles: 14, maxSize: '50M', compress: 'gzip', mode: 0o600,
  });
  app.use(morgan(':remote-addr :method :url :status :res[content-length] - :response-time ms', { stream: accessStream }));
  const errStream = rfs.createStream('error-%DATE%.log', {
    path: logDir, interval: '1d', maxFiles: 30, maxSize: '20M', compress: 'gzip', mode: 0o600,
  });

  /* ---- 安全头（helmet，CSP 分级） ---- */
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
  }));
  app.use((req, res, next) => {
    const isApp = req.path === '/app' || req.path.startsWith('/receiver');
    res.setHeader('Content-Security-Policy', isApp ? CSP_APP : CSP_STRICT);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  /* ---- 会话 ---- */
  const SessionStore = makeSessionStore(session, db.db);
  app.use(session({
    store: new SessionStore(),
    secret: secrets.sessionSecret,
    name: 'rqr_sess',
    resave: false,
    saveUninitialized: false,
    genid: () => crypto.randomBytes(32).toString('hex'),
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.https.enabled,
      path: '/',
      maxAge: config.session.idleTtlMinutes * 60 * 1000,
    },
    rolling: true,
  }));

  /* ---- 限流 ---- */
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.limits.maxConnections * 2,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '请求过于频繁，请稍后再试' },
  });
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '操作过于频繁，请稍后再试' },
  });
  app.use('/api/', apiLimiter);
  app.use(['/api/auth/login', '/api/auth/register', '/api/auth/change-password', '/api/auth/change-password-forced', '/api/setup'], authLimiter);

  /* ---- CSRF（写请求强制）----
   * 预认证接口（登录/注册/初始化/验证码）尚无会话令牌，仅做 Origin 校验；
   * 其余写接口要求 X-CSRF-Token + Origin 校验。 */
  const noCsrfPaths = new Set(['/setup', '/auth/register', '/auth/login', '/captcha', '/health']);
  app.use('/api', (req, res, next) => {
    if (noCsrfPaths.has(req.path)) return next();
    return csrfProtect(req, res, next);
  });

  /* ---- API 路由 ---- */
  const auth = createAuth(ctx);
  const users = createUsersApi({ ...ctx, auth });
  const records = createRecordsApi(ctx);

  // 公开
  app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  app.post('/api/setup', auth.setup);
  app.post('/api/auth/register', auth.register);
  app.post('/api/auth/login', auth.login);
  app.post('/api/auth/logout', auth.logout);
  app.get('/api/auth/session', auth.sessionInfo);
  app.get('/api/captcha', auth.captcha);

  // 登录后可访问
  app.post('/api/auth/change-password', requireAuth, auth.changePassword);
  app.post('/api/auth/change-password-forced', requireAuth, auth.changePasswordForced);

  // 记录（本人/总管理）
  app.get('/api/records', requireAuth, records.list);
  app.post('/api/records', requireAuth, records.create);
  app.get('/api/records/:id', requireAuth, records.getOne);
  app.get('/api/records/:id/backup', requireAuth, records.downloadBackup);
  app.post('/api/records/:id/status', requireAuth, records.updateStatus);

  // 统计（本人/总管理）
  app.get('/api/stats/overview', requireAuth, records.overview);
  app.get('/api/stats/destinations', requireAuth, records.byDestination);
  app.get('/api/stats/users', requireAuth, records.byUser);
  app.get('/api/stats/daily', requireAuth, records.daily);

  // 用户管理（总管理）
  app.get('/api/users', requireAuth, requireAdmin, users.list);
  app.post('/api/users/batch', requireAuth, requireAdmin, users.batchRegister);
  app.post('/api/users/:id/approve', requireAuth, requireAdmin, users.approve);
  app.post('/api/users/:id/reset-password', requireAuth, requireAdmin, users.resetPassword);
  app.post('/api/users/:id/status', requireAuth, requireAdmin, users.setStatus);
  app.post('/api/users/:id/role', requireAuth, requireAdmin, users.setRole);

  // 审计（总管理）
  app.get('/api/audit', requireAuth, requireAdmin, (req, res) => {
    const q = String(req.query.q || '').slice(0, 64);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(config.limits.maxPageSize, Math.max(1, parseInt(req.query.pageSize, 10) || config.limits.pageSize));
    res.json(db.listAudit({ q, page, pageSize }));
  });

  // 系统信息（总管理）
  app.get('/api/system/info', requireAuth, requireAdmin, (req, res) => {
    res.json({
      version: '1.0.0',
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      destinations: config.destinations,
      userCounts: {
        total: db.listUsers({ page: 1, pageSize: 1 }).total,
      },
      recordTotal: db.overview().total,
      auditTotal: db.listAudit({ page: 1, pageSize: 1 }).total,
    });
  });

  /* ---- 页面路由 ---- */
  const bridgeScript = createBridge(ctx);

  app.get('/', (req, res) => {
    if (db.activeAdminCount() === 0) return redirect(res, '/setup');
    if (req.session && req.session.userId) {
      const user = db.getUserById(req.session.userId);
      return redirect(res, user && user.role === 'admin' ? '/dashboard' : '/app');
    }
    redirect(res, '/login');
  });

  app.get('/setup', (req, res) => {
    if (db.activeAdminCount() > 0) return redirect(res, '/login');
    res.sendFile(path.join(STATIC_DIR, 'pages', 'setup.html'));
  });

  app.get('/login', (req, res) => {
    if (req.session && req.session.userId) {
      const user = db.getUserById(req.session.userId);
      return redirect(res, user && user.role === 'admin' ? '/dashboard' : '/app');
    }
    res.sendFile(path.join(STATIC_DIR, 'pages', 'login.html'));
  });

  app.get('/register', (req, res) => {
    res.sendFile(path.join(STATIC_DIR, 'pages', 'register.html'));
  });

  // 需要登录的页面
  const authPages = ['/dashboard', '/records', '/account'];
  for (const p of authPages) {
    app.get(p, requireAuthPage, (req, res) => {
      if (req.user.must_change_password === 1 || req.session.mustChangePassword) {
        if (p !== '/account') return redirect(res, '/account?forced=1');
      }
      res.sendFile(path.join(STATIC_DIR, 'pages', p.slice(1) + '.html'));
    });
  }
  // 总管理页面
  const adminPages = ['/users', '/stats', '/audit'];
  for (const p of adminPages) {
    app.get(p, requireAuthPage, requireAdminPage, (req, res) => {
      res.sendFile(path.join(STATIC_DIR, 'pages', p.slice(1) + '.html'));
    });
  }

  // 发送工作台：单文件应用 + 桥接注入（源文件字节不变，服务时注入）
  app.get('/app', requireAuthPage, (req, res, next) => {
    try {
      if (req.user.must_change_password === 1 || req.session.mustChangePassword) {
        return redirect(res, '/account?forced=1');
      }
      let html = fs.readFileSync(SENDER_HTML, 'utf8');
      // 注入桥接脚本到文档末尾 </body> 前；若已注入则跳过
      // 注意：文件内含两处 </body>（首处在页面骨架中部），且桥接脚本须包 <script> 标签才能执行
      if (html.indexOf('__RQR_SENDER_BRIDGE__') === -1) {
        const bridgeHtml = `<script>\n${bridgeScript}\n</script>`;
        const lastBody = html.lastIndexOf('</body>');
        if (lastBody === -1) return next(new Error('发送页缺少 </body>，无法注入桥接脚本'));
        html = html.slice(0, lastBody) + bridgeHtml + html.slice(lastBody);
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err) {
      next(err);
    }
  });

  // 接收端下载页与产物
  app.get('/receiver', (req, res) => {
    res.sendFile(path.join(STATIC_DIR, 'pages', 'receiver.html'));
  });
  app.get('/receiver/real.html', (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="RaptorQR_Receiver_Real.html"');
    res.sendFile(path.join(RECEIVER_OUT, 'real.html'));
  });
  app.get('/receiver/release.html', (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="RaptorQR_Receiver_Release.html"');
    res.sendFile(path.join(RECEIVER_OUT, 'release.html'));
  });

  // 静态资源（maxAge=0：页面动态引用，避免旧 JS/CSS 缓存导致前端故障）
  app.use('/css', express.static(path.join(STATIC_DIR, 'css'), { dotfiles: 'ignore', index: false, maxAge: 0 }));
  app.use('/js', express.static(path.join(STATIC_DIR, 'js'), { dotfiles: 'ignore', index: false, maxAge: 0 }));
  app.use('/receiver/static', express.static(RECEIVER_OUT, { dotfiles: 'ignore', index: false, maxAge: 0 }));

  // 404
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
    res.status(404).send('404 Not Found');
  });

  // 统一错误处理（生产不泄漏堆栈）
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // body-parser 等中间件错误自带状态码（413/400 等）
    let status = err.status || err.statusCode;
    if (typeof status !== 'number' || status < 400 || status > 599) {
      status = err instanceof HttpError ? err.status : 500;
    }
    if (status >= 500) {
      const line = `[${new Date().toISOString()}] ${clientIP(req)} ${req.method} ${req.originalUrl}\n${err.stack || err.message}\n`;
      try { errStream.write(line); } catch (_) {}
      // eslint-disable-next-line no-console
      console.error(line);
    }
    if (res.headersSent) return next(err);
    const body = err instanceof HttpError
      ? (err.payload ? { error: err.message, ...err.payload } : { error: err.message })
      : { error: status === 413 ? '请求体过大' : (err.message && status < 500 ? err.message : '服务器内部错误') };
    res.status(status).json(body);
  });

  return app;
}

/* ------------------------------ 启动 ------------------------------ */
async function start() {
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const secrets = loadSecrets(config.dataDir);
  const db = new RqrDb(path.join(config.dataDir, 'db.sqlite'));

  // 部署引导建管：无管理员时按配置自动创建超级管理员（未配置用默认凭据并强制改密）
  try {
    const boot = await bootstrapAdmin(config, db);
    if (boot) {
      const { DEFAULT_ADMIN } = require('./config');
      // eslint-disable-next-line no-console
      console.log(boot.usingDefault
        ? `[bootstrap] 已创建默认超级管理员：${boot.user.username}（默认密码 ${DEFAULT_ADMIN.password}，首次登录须修改！请尽快登录修改）`
        : `[bootstrap] 已创建超级管理员：${boot.user.username}（来自部署配置）`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[bootstrap] 自动建管失败：', err.message);
  }

  const app = createApp({ config, secrets, db });
  const http = require('http');
  const server = config.https.enabled
    ? require('https').createServer({ key: fs.readFileSync(config.https.keyFile), cert: fs.readFileSync(config.https.certFile) }, app)
    : http.createServer(app);

  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = config.limits.maxConnections;

  // 定时清理过期会话、验证码与过期备份（每 10 分钟）
  const timer = setInterval(() => {
    try {
      db.purgeCaptchas();
      db.cleanupSessions();
      if (config.backup.enabled) {
        const cleaned = cleanupBackups({ dataDir: config.dataDir, retentionDays: config.backup.retentionDays });
        for (const id of cleaned) db.clearRecordBackup(id);
      }
    } catch (_) { /* 尽力而为 */ }
  }, 10 * 60 * 1000);
  timer.unref();

  server.listen(config.port, config.host, () => {
    // eslint-disable-next-line no-console
    console.log(`RaptorQR 发送端管理系统启动: http://${config.host}:${config.port}  (Node ${process.version})`);
  });

  // 优雅停机：停收新连接 → 关闭 server → checkpoint WAL → 关库
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`收到 ${signal}，正在优雅停机...`);
    clearInterval(timer);
    server.close(() => {
      try { db.checkpoint(); } catch (_) {}
      db.close();
      process.exit(0);
    });
    setTimeout(() => { try { db.close(); } catch (_) {} process.exit(1); }, 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { app, server, db, config, secrets };
}

if (require.main === module) {
  start();
}

module.exports = { createApp, start, CSP_APP, CSP_STRICT, SENDER_HTML };
