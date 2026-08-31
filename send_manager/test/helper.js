'use strict';
/* ============================================================================
 * 测试辅助：创建隔离的应用实例（临时数据目录 + 测试配置）
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const { loadConfig } = require('../app/config');
const { loadSecrets } = require('../app/secrets');
const { RqrDb } = require('../app/db');
const { createApp } = require('../app/server');

let seq = 0;

function makeTestContext(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rqr-test-${process.pid}-${seq++}-`));
  const dataDir = path.join(dir, 'data');
  const config = loadConfig();
  config.dataDir = dataDir;
  config.port = 0;
  config.registration = { enabled: true };
  config.batchRegister = { initialPassword: 'RaptorQR@2026' };
  config.lockout = { maxFails: 5, windowMinutes: 15, lockMinutes: 15 };
  config.captcha = { enabled: true, afterFailures: 2, ttlMinutes: 5 };
  if (overrides.config) Object.assign(config, overrides.config);

  const secrets = loadSecrets(dataDir);
  const db = new RqrDb(path.join(dataDir, 'db.sqlite'));
  const app = createApp({ config, secrets, db });
  const rq = request(app);

  return { dir, dataDir, config, secrets, db, app, rq };
}

/** 登录助手：返回带 cookie 的 supertest agent 和 csrfToken */
async function loginAgent(rq, username, password) {
  const res = await rq.post('/api/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = res.headers['set-cookie'][0].split(';')[0];
  const session = await rq.get('/api/auth/session').set('Cookie', cookie);
  return { cookie, csrf: session.body.csrfToken };
}

/** 完整搭建：setup 总管理 → 注册并审批用户 */
async function bootstrap(ctx, adminUser = { username: 'chief', displayName: '总管理', password: 'ChiefPass123' }) {
  const res = await ctx.rq.post('/api/setup').send(adminUser);
  if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return adminUser;
}

async function createApprovedUser(ctx, { username, displayName, password }, admin) {
  const reg = await ctx.rq.post('/api/auth/register').send({ username, displayName, password });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status}`);
  const u = ctx.db.getUserByUsername(username);
  const ap = await ctx.rq.post(`/api/users/${u.id}/approve`)
    .set('Cookie', admin.cookie).set('X-CSRF-Token', admin.csrf).send({ decision: 'approve' });
  if (ap.status !== 200) throw new Error(`approve failed: ${ap.status}`);
  return u;
}

module.exports = { makeTestContext, loginAgent, bootstrap, createApprovedUser };
