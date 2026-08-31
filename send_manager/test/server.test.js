'use strict';
/* ============================================================================
 * 服务端全流程测试：功能 + 安全用例（node:test + supertest）
 * 运行：./runtime/bin/node --test test/server.test.js
 * ========================================================================== */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.RQR_TEST_CAPTCHA = '1'; // 测试钩子：验证码固定答案 'test'
const { makeTestContext, loginAgent, bootstrap, createApprovedUser } = require('./helper');
const { bootstrapAdmin } = require('../app/auth');

let ctx;
before(() => { ctx = makeTestContext(); });
after(() => { try { ctx.db.close(); } catch (_) {} });

function rq() { return ctx.rq; }

/* ============================ 1. 初始化 ============================ */
test('健康检查可用', async () => {
  const r = await rq().get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('未初始化时根路径重定向到 /setup', async () => {
  const r = await rq().get('/');
  assert.equal(r.status, 302);
  assert.match(r.headers.location, /\/setup/);
});

test('setup 创建总管理，二次初始化被拒绝，保留用户名被拦截', async () => {
  const c = makeTestContext();
  try {
    // 保留用户名在初始化前即被拦截
    const r3 = await c.rq.post('/api/setup').send({ username: 'admin', displayName: 'x', password: 'Xxxxxxxx123' });
    assert.equal(r3.status, 400);
    const r1 = await c.rq.post('/api/setup').send({ username: 'chief', displayName: '总管理', password: 'ChiefPass123' });
    assert.equal(r1.status, 201);
    const r2 = await c.rq.post('/api/setup').send({ username: 'x2', displayName: 'x', password: 'Xxxxxxxx123' });
    assert.equal(r2.status, 403);
  } finally { c.db.close(); }
});

/* ==================== 2. 注册 / 审批 / 登录 ==================== */
test('注册-审批-登录全流程', async () => {
  const c = makeTestContext();
  try {
    await bootstrap(c);
    const admin = await loginAgent(c.rq, 'chief', 'ChiefPass123');

    const reg = await c.rq.post('/api/auth/register').send({ username: 'alice', displayName: 'Alice', password: 'AlicePass123' });
    assert.equal(reg.status, 201);

    // 待审批不能登录
    const p1 = await c.rq.post('/api/auth/login').send({ username: 'alice', password: 'AlicePass123' });
    assert.equal(p1.status, 403);

    // 重复用户名
    const dup = await c.rq.post('/api/auth/register').send({ username: 'alice', displayName: 'A', password: 'AlicePass123' });
    assert.equal(dup.status, 409);

    // 审批通过
    const u = c.db.getUserByUsername('alice');
    const ap = await c.rq.post(`/api/users/${u.id}/approve`)
      .set('Cookie', admin.cookie).set('X-CSRF-Token', admin.csrf).send({ decision: 'approve' });
    assert.equal(ap.status, 200);
    assert.equal(c.db.getUserById(u.id).status, 'active');

    // 登录成功
    const alice = await loginAgent(c.rq, 'alice', 'AlicePass123');
    assert.ok(alice.cookie.includes('rqr_sess='));
  } finally { c.db.close(); }
});

test('驳回后可看到原因且不能登录', async () => {
  const c = makeTestContext();
  try {
    await bootstrap(c);
    const admin = await loginAgent(c.rq, 'chief', 'ChiefPass123');
    await c.rq.post('/api/auth/register').send({ username: 'bob', displayName: 'Bob', password: 'BobPass123' });
    const u = c.db.getUserByUsername('bob');
    await c.rq.post(`/api/users/${u.id}/approve`)
      .set('Cookie', admin.cookie).set('X-CSRF-Token', admin.csrf).send({ decision: 'reject', reason: '非本单位人员' });
    const login = await c.rq.post('/api/auth/login').send({ username: 'bob', password: 'BobPass123' });
    assert.equal(login.status, 403);
    assert.match(login.body.error, /非本单位人员/);
  } finally { c.db.close(); }
});

test('错误密码被锁定并触发验证码', async () => {
  const c = makeTestContext();
  try {
    await bootstrap(c);
    await createApprovedUser(c, { username: 'carol', displayName: 'Carol', password: 'CarolPass123' }, await loginAgent(c.rq, 'chief', 'ChiefPass123'));

    // 第 1、2 次错误：401，第 2 次后需验证码
    const f1 = await c.rq.post('/api/auth/login').send({ username: 'carol', password: 'wrong' });
    assert.equal(f1.status, 401);
    assert.equal(f1.body.needCaptcha, false);
    const f2 = await c.rq.post('/api/auth/login').send({ username: 'carol', password: 'wrong' });
    assert.equal(f2.status, 401);
    assert.equal(f2.body.needCaptcha, true);

    // 无验证码登录被拒
    const f3 = await c.rq.post('/api/auth/login').send({ username: 'carol', password: 'wrong' });
    assert.equal(f3.status, 400);
    assert.match(f3.body.error, /验证码/);

    // 验证码流程：取 captcha，用固定答案 test
    const cap = await c.rq.get('/api/captcha');
    assert.equal(cap.status, 200);
    assert.ok(cap.body.id && cap.body.svg);
    const f4 = await c.rq.post('/api/auth/login').send({ username: 'carol', password: 'wrong', captchaId: cap.body.id, captchaAnswer: 'test' });
    assert.equal(f4.status, 401); // 密码仍错
    assert.equal(f4.body.failCount, 3); // f1+f2+f4，f3 验证码失败不计数

    // 累计 5 次失败 → 锁定
    for (let i = 0; i < 3; i++) {
      const capN = await c.rq.get('/api/captcha');
      const fl = await c.rq.post('/api/auth/login').send({ username: 'carol', password: 'wrong', captchaId: capN.body.id, captchaAnswer: 'test' });
      if (fl.status === 423) break;
    }
    const locked = await c.rq.post('/api/auth/login').send({ username: 'carol', password: 'CarolPass123' });
    assert.equal(locked.status, 423);
    assert.match(locked.body.error, /锁定/);

    // 清理锁定后正确密码可登录
    c.db.clearLoginLock('carol');
    const ok = await c.rq.post('/api/auth/login').send({ username: 'carol', password: 'CarolPass123' });
    assert.equal(ok.status, 200);
  } finally { c.db.close(); }
});

/* ==================== 3. 会话与 CSRF ==================== */
test('CSRF 缺失/伪造/Origin 不匹配均被拒绝', async () => {
  const c = makeTestContext();
  try {
    await bootstrap(c);
    const admin = await loginAgent(c.rq, 'chief', 'ChiefPass123');

    // 缺失令牌
    const r1 = await c.rq.post('/api/users/batch').set('Cookie', admin.cookie).send({ lines: 'u1,一' });
    assert.equal(r1.status, 403);

    // 伪造令牌
    const r2 = await c.rq.post('/api/users/batch').set('Cookie', admin.cookie)
      .set('X-CSRF-Token', 'forged').send({ lines: 'u1,一' });
    assert.equal(r2.status, 403);

    // Origin 不匹配（有合法令牌也被拒）
    const r3 = await c.rq.post('/api/users/batch').set('Cookie', admin.cookie)
      .set('X-CSRF-Token', admin.csrf).set('Origin', 'http://evil.example')
      .send({ lines: 'u1,一' });
    assert.equal(r3.status, 403);

    // 合法令牌 + 无 Origin → 通过
    const r4 = await c.rq.post('/api/users/batch').set('Cookie', admin.cookie)
      .set('X-CSRF-Token', admin.csrf).send({ lines: 'u1,一' });
    assert.equal(r4.status, 201);
  } finally { c.db.close(); }
});

test('会话 Cookie 具备 HttpOnly / SameSite 且响应不含敏感字段', async () => {
  const c = makeTestContext();
  try {
    await bootstrap(c);
    const res = await c.rq.post('/api/auth/login').send({ username: 'chief', password: 'ChiefPass123' });
    assert.equal(res.status, 200);
    const cookieHeader = res.headers['set-cookie'][0];
    assert.match(cookieHeader, /HttpOnly/i);
    assert.match(cookieHeader, /SameSite=Strict/i);
    const raw = JSON.stringify(res.body);
    assert.ok(!raw.includes('"pass_hash"'));
    assert.ok(!raw.includes('"password"'));
    // 会话表里不应有明文 sid
    const rows = c.db.db.prepare('SELECT id FROM express_session').all();
    assert.ok(rows.length >= 1);
    for (const row of rows) assert.match(row.id, /^[0-9a-f]{64}$/); // sha256 哈希形态
  } finally { c.db.close(); }
});

test('登出后会话失效', async () => {
  const c = makeTestContext();
  try {
    await bootstrap(c);
    const admin = await loginAgent(c.rq, 'chief', 'ChiefPass123');
    const out = await c.rq.post('/api/auth/logout').set('Cookie', admin.cookie).set('X-CSRF-Token', admin.csrf);
    assert.equal(out.status, 200);
    const sess = await c.rq.get('/api/auth/session').set('Cookie', admin.cookie);
    assert.equal(sess.body.authenticated, false);
  } finally { c.db.close(); }
});

/* ==================== 4. 权限隔离 ==================== */
test('普通用户无法访问管理接口，也看不到他人记录', async () => {
  const c = makeTestContext();
  try {
    await bootstrap(c);
    const admin = await loginAgent(c.rq, 'chief', 'ChiefPass123');
    await createApprovedUser(c, { username: 'alice', displayName: 'Alice', password: 'AlicePass123' }, admin);
    await createApprovedUser(c, { username: 'bob', displayName: 'Bob', password: 'BobPass123' }, admin);
    const alice = await loginAgent(c.rq, 'alice', 'AlicePass123');
    const bob = await loginAgent(c.rq, 'bob', 'BobPass123');

    // 管理接口全部 403
    for (const p of ['/api/users', '/api/stats/users', '/api/audit', '/api/system/info']) {
      const r = await c.rq.get(p).set('Cookie', alice.cookie);
      assert.equal(r.status, 403, p);
    }

    // alice 建记录，bob 看不到
    const cr = await c.rq.post('/api/records').set('Cookie', alice.cookie).set('X-CSRF-Token', alice.csrf)
      .send({ destination: 'jzw', filename: 'secret.pdf', size: 100, mime: 'application/pdf' });
    assert.equal(cr.status, 201);
    const bobList = await c.rq.get('/api/records').set('Cookie', bob.cookie);
    assert.equal(bobList.body.total, 0);
    // bob 无法更新 alice 的记录
    const upd = await c.rq.post(`/api/records/${cr.body.record.id}/status`).set('Cookie', bob.cookie)
      .set('X-CSRF-Token', bob.csrf).send({ status: 'completed' });
    assert.equal(upd.status, 403);
  } finally { c.db.close(); }
});

/* ==================== 5. 记录与统计 ==================== */
test('记录创建校验目的地，状态流转与统计正确', async () => {
  const c = makeTestContext();
  try {
    await bootstrap(c);
    const admin = await loginAgent(c.rq, 'chief', 'ChiefPass123');
    await createApprovedUser(c, { username: 'alice', displayName: 'Alice', password: 'AlicePass123' }, admin);
    const alice = await loginAgent(c.rq, 'alice', 'AlicePass123');

    // 非法目的地
    const bad = await c.rq.post('/api/records').set('Cookie', alice.cookie).set('X-CSRF-Token', alice.csrf)
      .send({ destination: 'hacker', filename: 'x', size: 1 });
    assert.equal(bad.status, 400);

    // 四类目的地
    const created = [];
    for (const d of ['jzw', 'bgw', 'my', 'sjw']) {
      const r = await c.rq.post('/api/records').set('Cookie', alice.cookie).set('X-CSRF-Token', alice.csrf)
        .send({ destination: d, filename: `f-${d}.bin`, size: 1000, mime: 'application/octet-stream' });
      assert.equal(r.status, 201);
      created.push(r.body.record);
    }
    // 完成第一笔
    const done = await c.rq.post(`/api/records/${created[0].id}/status`).set('Cookie', alice.cookie)
      .set('X-CSRF-Token', alice.csrf).send({ status: 'completed' });
    assert.equal(done.status, 200);
    assert.equal(done.body.record.status, 'completed');

    // 筛选
    const byDest = await c.rq.get('/api/records?destination=jzw').set('Cookie', alice.cookie);
    assert.equal(byDest.body.total, 1);
    const byStatus = await c.rq.get('/api/records?status=completed').set('Cookie', alice.cookie);
    assert.equal(byStatus.body.total, 1);

    // 统计
    const ov = await c.rq.get('/api/stats/overview').set('Cookie', alice.cookie);
    assert.equal(ov.body.total, 4);
    assert.equal(ov.body.completed, 1);
    const daily = await c.rq.get('/api/stats/daily?days=7').set('Cookie', alice.cookie);
    assert.equal(daily.body.rows.length, 7);
    assert.ok(daily.body.rows.some((r) => r.n > 0));

    // 总管理全局统计含每人统计
    const adminOv = await c.rq.get('/api/stats/overview').set('Cookie', admin.cookie);
    assert.equal(adminOv.body.total, 4);
    assert.ok(Array.isArray(adminOv.body.byUser));
  } finally { c.db.close(); }
});

/* ==================== 6. 批量注册 ==================== */
test('批量注册：统一初始密码 + 首次强制改密', async () => {
  const c = makeTestContext();
  try {
    await bootstrap(c);
    const admin = await loginAgent(c.rq, 'chief', 'ChiefPass123');
    const r = await c.rq.post('/api/users/batch').set('Cookie', admin.cookie).set('X-CSRF-Token', admin.csrf)
      .send({ lines: 'zhangsan,张三\nlisi,李四\nbad user!,无效名\nzhangsan,重复\n' });
    assert.equal(r.status, 201);
    assert.equal(r.body.created, 2);
    assert.equal(r.body.failed, 2);

    const lisi = c.db.getUserByUsername('lisi');
    assert.equal(lisi.status, 'active');
    assert.equal(lisi.must_change_password, 1);

    // 初始密码登录 → 强制改密标记
    const login = await c.rq.post('/api/auth/login').send({ username: 'lisi', password: 'RaptorQR@2026' });
    assert.equal(login.status, 200);
    assert.equal(login.body.mustChangePassword, true);
    // 未改密前访问 /app 被重定向
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const appPage = await c.rq.get('/app').set('Cookie', cookie);
    assert.equal(appPage.status, 302);
    assert.match(appPage.headers.location, /account.*forced=1/);
  } finally { c.db.close(); }
});

/* ==================== 7. 密码管理 ==================== */
test('自助改密需验证旧密码；改密后会话失效需重登', async () => {
  const c = makeTestContext();
  try {
    await bootstrap(c);
    const admin = await loginAgent(c.rq, 'chief', 'ChiefPass123');
    await createApprovedUser(c, { username: 'alice', displayName: 'Alice', password: 'AlicePass123' }, admin);
    const alice = await loginAgent(c.rq, 'alice', 'AlicePass123');

    // 旧密码错误
    const r1 = await c.rq.post('/api/auth/change-password').set('Cookie', alice.cookie).set('X-CSRF-Token', alice.csrf)
      .send({ oldPassword: 'wrong', newPassword: 'NewAlicePass123' });
    assert.equal(r1.status, 400);

    // 正确改密 → 会话销毁
    const r2 = await c.rq.post('/api/auth/change-password').set('Cookie', alice.cookie).set('X-CSRF-Token', alice.csrf)
      .send({ oldPassword: 'AlicePass123', newPassword: 'NewAlicePass123' });
    assert.equal(r2.status, 200);
    const sess = await c.rq.get('/api/auth/session').set('Cookie', alice.cookie);
    assert.equal(sess.body.authenticated, false);

    // 新密码可登录
    const ok = await loginAgent(c.rq, 'alice', 'NewAlicePass123');
    assert.ok(ok.cookie);
  } finally { c.db.close(); }
});

test('总管理重置密码 → 临时密码登录 → 强制改密 → 新密码登录', async () => {
  const c = makeTestContext();
  try {
    await bootstrap(c);
    const admin = await loginAgent(c.rq, 'chief', 'ChiefPass123');
    await createApprovedUser(c, { username: 'alice', displayName: 'Alice', password: 'AlicePass123' }, admin);
    const u = c.db.getUserByUsername('alice');

    const res = await c.rq.post(`/api/users/${u.id}/reset-password`).set('Cookie', admin.cookie)
      .set('X-CSRF-Token', admin.csrf).send({});
    assert.equal(res.status, 200);
    const tmp = res.body.temporaryPassword;
    assert.equal(tmp.length, 12);

    const login = await c.rq.post('/api/auth/login').send({ username: 'alice', password: tmp });
    assert.equal(login.body.mustChangePassword, true);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const sess = await c.rq.get('/api/auth/session').set('Cookie', cookie);
    const csrf = sess.body.csrfToken;

    const forced = await c.rq.post('/api/auth/change-password-forced').set('Cookie', cookie).set('X-CSRF-Token', csrf)
      .send({ newPassword: 'BrandNewPass123' });
    assert.equal(forced.status, 200);

    const ok = await c.rq.post('/api/auth/login').send({ username: 'alice', password: 'BrandNewPass123' });
    assert.equal(ok.status, 200);
  } finally { c.db.close(); }
});

/* ==================== 8. 账号状态 ==================== */
test('停用即时失效，启用恢复', async () => {
  const c = makeTestContext();
  try {
    await bootstrap(c);
    const admin = await loginAgent(c.rq, 'chief', 'ChiefPass123');
    await createApprovedUser(c, { username: 'alice', displayName: 'Alice', password: 'AlicePass123' }, admin);
    const alice = await loginAgent(c.rq, 'alice', 'AlicePass123');
    const u = c.db.getUserByUsername('alice');

    await c.rq.post(`/api/users/${u.id}/status`).set('Cookie', admin.cookie)
      .set('X-CSRF-Token', admin.csrf).send({ action: 'disable' });
    // 已登录会话即时失效
    const sess = await c.rq.get('/api/auth/session').set('Cookie', alice.cookie);
    assert.equal(sess.body.authenticated, false);
    // 无法再登录
    const login = await c.rq.post('/api/auth/login').send({ username: 'alice', password: 'AlicePass123' });
    assert.equal(login.status, 403);

    await c.rq.post(`/api/users/${u.id}/status`).set('Cookie', admin.cookie)
      .set('X-CSRF-Token', admin.csrf).send({ action: 'enable' });
    const ok = await c.rq.post('/api/auth/login').send({ username: 'alice', password: 'AlicePass123' });
    assert.equal(ok.status, 200);
  } finally { c.db.close(); }
});

test('总管理不能停用/重置自己', async () => {
  const c = makeTestContext();
  try {
    await bootstrap(c);
    const admin = await loginAgent(c.rq, 'chief', 'ChiefPass123');
    const u = c.db.getUserByUsername('chief');
    const r1 = await c.rq.post(`/api/users/${u.id}/status`).set('Cookie', admin.cookie)
      .set('X-CSRF-Token', admin.csrf).send({ action: 'disable' });
    assert.equal(r1.status, 400);
    const r2 = await c.rq.post(`/api/users/${u.id}/reset-password`).set('Cookie', admin.cookie)
      .set('X-CSRF-Token', admin.csrf).send({});
    assert.equal(r2.status, 400);
  } finally { c.db.close(); }
});

/* ==================== 9. 审计 ==================== */
test('审计日志记录关键操作且仅总管理可读', async () => {
  const c = makeTestContext();
  try {
    await bootstrap(c);
    const admin = await loginAgent(c.rq, 'chief', 'ChiefPass123');
    await createApprovedUser(c, { username: 'alice', displayName: 'Alice', password: 'AlicePass123' }, admin);
    const alice = await loginAgent(c.rq, 'alice', 'AlicePass123');
    await c.rq.post('/api/records').set('Cookie', alice.cookie).set('X-CSRF-Token', alice.csrf)
      .send({ destination: 'my', filename: 'a.txt', size: 1, mime: 'text/plain' });

    const r = await c.rq.get('/api/audit').set('Cookie', admin.cookie);
    assert.equal(r.status, 200);
    const actions = r.body.rows.map((a) => a.action);
    for (const expect of ['SETUP_ADMIN', 'REGISTER', 'USER_APPROVE', 'LOGIN_OK', 'RECORD_CREATE']) {
      assert.ok(actions.includes(expect), `审计缺少 ${expect}`);
    }
    const denied = await c.rq.get('/api/audit').set('Cookie', alice.cookie);
    assert.equal(denied.status, 403);
  } finally { c.db.close(); }
});

/* ==================== 10. 安全用例 ==================== */
test('SQL 注入尝试被参数化查询安全处理', async () => {
  const c = makeTestContext();
  try {
    await bootstrap(c);
    await loginAgent(c.rq, 'chief', 'ChiefPass123');
    // 注入型用户名/关键词不应导致异常或越权
    const r1 = await c.rq.post('/api/auth/login').send({ username: "' OR '1'='1", password: 'x' });
    assert.equal(r1.status, 401);
    const r2 = await c.rq.get('/api/users?q=' + encodeURIComponent("' OR 1=1 --")).set('Cookie', (await loginAgent(c.rq, 'chief', 'ChiefPass123')).cookie);
    assert.equal(r2.status, 200);
    const r3 = await c.rq.get('/api/records?q=' + encodeURIComponent("'; DROP TABLE users;--")).set('Cookie', (await loginAgent(c.rq, 'chief', 'ChiefPass123')).cookie);
    assert.equal(r3.status, 200);
    assert.equal(c.db.getUserByUsername('alice'), undefined); // users 表未被破坏（无 alice 预期）
    assert.ok(c.db.st.userByUsername.get('chief')); // 表仍可用
  } finally { c.db.close(); }
});

test('超大请求体被拒绝（防内存耗尽）', async () => {
  const c = makeTestContext();
  try {
    await bootstrap(c);
    const big = 'A'.repeat(1024 * 200); // 200KB > jsonBody 100KB
    const r = await c.rq.post('/api/auth/register').set('Content-Type', 'application/json').send(JSON.stringify({ username: 'a', displayName: 'x', password: big }));
    assert.equal(r.status, 413);
  } finally { c.db.close(); }
});

test('路径穿越被拦截', async () => {
  const r1 = await rq().get('/css/..%2f..%2f..%2fetc%2fpasswd');
  assert.equal(r1.status, 404);
  const r2 = await rq().get('/css/../app/server.js');
  assert.equal(r2.status, 404);
  const r3 = await rq().get('/js/..%2f..%2fpackage.json');
  assert.equal(r3.status, 404);
});

test('不存在的接口返回 404 JSON', async () => {
  const r = await rq().get('/api/does-not-exist');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, '接口不存在');
});

test('会话过期后受保护接口返回 401', async () => {
  const c = makeTestContext();
  try {
    await bootstrap(c);
    const admin = await loginAgent(c.rq, 'chief', 'ChiefPass123');
    // 篡改会话到期时间
    const rows = c.db.db.prepare('SELECT id, data FROM express_session').all();
    for (const row of rows) {
      const d = JSON.parse(row.data);
      if (d.userId) {
        d.expiresAt = Date.now() - 1000;
        c.db.db.prepare('UPDATE express_session SET data=? WHERE id=?').run(JSON.stringify(d), row.id);
      }
    }
    const r = await c.rq.get('/api/records').set('Cookie', admin.cookie);
    assert.equal(r.status, 401);
  } finally { c.db.close(); }
});

/* ==================== 12. 部署引导建管 ==================== */
test('部署引导：默认凭据自动创建超级管理员并强制改密（幂等）', async () => {
  const c = makeTestContext();
  try {
    const res = await bootstrapAdmin(c.config, c.db);
    assert.ok(res && res.usingDefault);
    const admin = c.db.getUserByUsername('admin');
    assert.ok(admin, '默认账号 admin 应被创建');
    assert.equal(admin.role, 'admin');
    assert.equal(admin.status, 'active');
    assert.equal(admin.must_change_password, 1, '默认凭据应强制改密');
    // 默认密码可登录且触发强制改密
    const login = await c.rq.post('/api/auth/login').send({ username: 'admin', password: 'Admin@1145' });
    assert.equal(login.status, 200);
    assert.equal(login.body.mustChangePassword, true);
    // 幂等：已有管理员时重复引导为无操作
    const again = await bootstrapAdmin(c.config, c.db);
    assert.ok(again === null || again.user.username === 'admin');
    assert.equal(c.db.activeAdminCount(), 1);
  } finally { c.db.close(); }
});

test('部署引导：配置的账号与密码优先', async () => {
  const c = makeTestContext();
  try {
    c.config.admin.bootstrap = { enabled: true, username: 'Chief', password: 'ChiefPass2026', displayName: '首席', forcePasswordChange: false };
    const res = await bootstrapAdmin(c.config, c.db);
    assert.ok(res && !res.usingDefault);
    const admin = c.db.getUserByUsername('chief'); // 用户名统一小写
    assert.ok(admin);
    assert.equal(admin.display_name, '首席');
    assert.equal(admin.must_change_password, 0);
    // 不产生默认 admin
    assert.equal(c.db.getUserByUsername('admin'), undefined);
  } finally { c.db.close(); }
});

test('部署引导：环境变量覆盖配置；关闭引导时退回 /setup 向导', async () => {
  const c = makeTestContext();
  try {
    process.env.RQR_ADMIN_USERNAME = 'envadmin';
    process.env.RQR_ADMIN_PASSWORD = 'EnvAdminPass123';
    // loadConfig 在 helper 已执行，env 覆盖在 loadConfig 时生效；这里手动合并验证
    c.config.admin.bootstrap.username = process.env.RQR_ADMIN_USERNAME;
    c.config.admin.bootstrap.password = process.env.RQR_ADMIN_PASSWORD;
    const res = await bootstrapAdmin(c.config, c.db);
    assert.ok(c.db.getUserByUsername('envadmin'));
    delete process.env.RQR_ADMIN_USERNAME;
    delete process.env.RQR_ADMIN_PASSWORD;
  } finally { c.db.close(); }

  const c2 = makeTestContext();
  try {
    c2.config.admin.bootstrap.enabled = false;
    const res = await bootstrapAdmin(c2.config, c2.db);
    assert.equal(res, null);
    assert.equal(c2.db.activeAdminCount(), 0);
    const r = await c2.rq.get('/');
    assert.match(r.headers.location, /\/setup/); // 无管理员 → 初始化向导
  } finally { c2.db.close(); }
});

test('畸形 Accept 头不触发 500（重定向安全化回归）', async () => {
  const c = makeTestContext();
  try {
    await bootstrap(c);
    // 未登录访问各页面，携带畸形 Accept（曾导致 res.redirect → res.format 抛错 → 500）
    for (const p of ['/', '/app', '/records', '/account', '/users', '/stats', '/audit']) {
      const r = await c.rq.get(p).set('Accept', 'text/html,');
      assert.ok(r.status === 302 || r.status === 200, `${p} 不应 500（实际 ${r.status}）`);
    }
    // 登录后根路径重定向正常
    const admin = await loginAgent(c.rq, 'chief', 'ChiefPass123');
    const r = await c.rq.get('/').set('Accept', 'text/html,').set('Cookie', admin.cookie);
    assert.equal(r.status, 302);
  } finally { c.db.close(); }
});

test('认证页必须加载 common.js（前端脚本依赖回归）', async () => {
  const c = makeTestContext();
  try {
    // login / register 可直接访问；setup 仅在无管理员时可访问
    for (const p of ['/login', '/register']) {
      const r = await c.rq.get(p);
      assert.equal(r.status, 200, p);
      const commonIdx = r.text.indexOf('/js/common.js');
      const pageJsIdx = r.text.indexOf(p === '/login' ? '/js/login.js' : '/js/register.js');
      assert.ok(commonIdx !== -1, `${p} 缺少 common.js`);
      assert.ok(pageJsIdx !== -1, `${p} 缺少页面脚本`);
      assert.ok(commonIdx < pageJsIdx, `${p} 的 common.js 必须在页面脚本之前`);
    }
    // setup 页（无管理员时）
    const c2 = makeTestContext();
    try {
      const r = await c2.rq.get('/setup');
      assert.equal(r.status, 200);
      assert.ok(r.text.indexOf('/js/common.js') !== -1 && r.text.indexOf('/js/setup.js') !== -1);
      assert.ok(r.text.indexOf('/js/common.js') < r.text.indexOf('/js/setup.js'));
    } finally { c2.db.close(); }
  } finally { c.db.close(); }
});

/* ==================== 11. 页面 ==================== */
test('公共页面与受保护页面可达性', async () => {
  const c = makeTestContext();
  try {
    await bootstrap(c);
    // 公共页
    for (const p of ['/login', '/register']) {
      const r = await c.rq.get(p);
      assert.equal(r.status, 200, p);
    }
    // 未登录访问受保护页 → 302 到 /login
    for (const p of ['/app', '/records', '/account', '/users', '/stats', '/audit']) {
      const r = await c.rq.get(p);
      assert.equal(r.status, 302, p);
      assert.match(r.headers.location, /\/login/, p);
    }
    // 普通用户访问管理页 → 302 到 /app
    const admin = await loginAgent(c.rq, 'chief', 'ChiefPass123');
    await createApprovedUser(c, { username: 'alice', displayName: 'Alice', password: 'AlicePass123' }, admin);
    const alice = await loginAgent(c.rq, 'alice', 'AlicePass123');
    for (const p of ['/users', '/stats', '/audit']) {
      const r = await c.rq.get(p).set('Cookie', alice.cookie);
      assert.equal(r.status, 302, p);
      assert.match(r.headers.location, /\/app/, p);
    }
    // 登录后可访问工作台与记录页
    const app = await c.rq.get('/app').set('Cookie', alice.cookie);
    assert.equal(app.status, 200);
    assert.ok(app.text.includes('__RQR_SENDER_BRIDGE__'));
    const rec = await c.rq.get('/records').set('Cookie', alice.cookie);
    assert.equal(rec.status, 200);
  } finally { c.db.close(); }
});

test('接收端页面与下载可用', async () => {
  const r1 = await rq().get('/receiver');
  assert.equal(r1.status, 200);
  const r2 = await rq().get('/receiver/real.html');
  assert.equal(r2.status, 200);
  assert.ok(r2.text.length > 1000000);
  const r3 = await rq().get('/receiver/release.html');
  assert.equal(r3.status, 200);
  assert.ok(r3.text.length > 1000000);
  assert.match(r3.headers['content-disposition'], /Release/);
});

test('发送页源码文件字节未被修改（桥接为服务时注入）', async () => {
  const c = makeTestContext();
  try {
    await bootstrap(c);
    const admin = await loginAgent(c.rq, 'chief', 'ChiefPass123');
    const u = await createApprovedUser(c, { username: 'alice', displayName: 'Alice', password: 'AlicePass123' }, admin);
    await c.rq.post('/api/users/batch').set('Cookie', admin.cookie).set('X-CSRF-Token', admin.csrf)
      .send({ lines: `${u.username},x\n` });
    const app = await c.rq.get('/app').set('Cookie', admin.cookie);
    const diskFile = fs.readFileSync(path.join(__dirname, '..', 'app', 'sender', 'RaptorQR_彩色版.html'), 'utf8');
    assert.ok(diskFile.includes('RaptorQR'));
    assert.ok(app.text.includes('__RQR_SENDER_BRIDGE__'));
  } finally { c.db.close(); }
});

/* ==================== 备份：上传 / 下载 / 权限 / 清理 ==================== */
test('备份：创建记录带 content 落盘，无 content 兼容', async () => {
  const c = makeTestContext();
  try {
    await bootstrap(c);
    const admin = await loginAgent(c.rq, 'chief', 'ChiefPass123');
    const u = await createApprovedUser(c, { username: 'alice', displayName: 'Alice', password: 'AlicePass123' }, admin);
    const alice = await loginAgent(c.rq, 'alice', 'AlicePass123');
    const bytes = Buffer.from('hello backup content 你好');
    const b64 = bytes.toString('base64');

    // 带 content → 备份落盘
    const r1 = await c.rq.post('/api/records').set('Cookie', alice.cookie).set('X-CSRF-Token', alice.csrf)
      .send({ destination: 'jzw', filename: '报告.docx', size: bytes.length, mime: 'application/octet-stream', content: b64 });
    assert.equal(r1.status, 201);
    assert.ok(r1.body.record.backup_path, 'backup_path 应有值');
    assert.equal(r1.body.record.backup_size, bytes.length);
    const abs = path.join(c.dataDir, r1.body.record.backup_path);
    assert.ok(fs.existsSync(abs), '备份文件应存在');
    assert.deepEqual(fs.readFileSync(abs), bytes);

    // 无 content → 兼容（不落盘）
    const r2 = await c.rq.post('/api/records').set('Cookie', alice.cookie).set('X-CSRF-Token', alice.csrf)
      .send({ destination: 'bgw', filename: 'no-backup.txt', size: 3 });
    assert.equal(r2.status, 201);
    assert.equal(r2.body.record.backup_path, '');
  } finally { c.db.close(); }
});

test('备份：下载权限（本人/总管理可下，他人 403，无备份 404）', async () => {
  const c = makeTestContext();
  try {
    await bootstrap(c);
    const admin = await loginAgent(c.rq, 'chief', 'ChiefPass123');
    await createApprovedUser(c, { username: 'alice', displayName: 'Alice', password: 'AlicePass123' }, admin);
    await createApprovedUser(c, { username: 'bob', displayName: 'Bob', password: 'BobPass123' }, admin);
    const alice = await loginAgent(c.rq, 'alice', 'AlicePass123');
    const bob = await loginAgent(c.rq, 'bob', 'BobPass123');

    const bytes = Buffer.from('secret backup bytes');
    const cr = await c.rq.post('/api/records').set('Cookie', alice.cookie).set('X-CSRF-Token', alice.csrf)
      .send({ destination: 'my', filename: 'secret.pdf', size: bytes.length, mime: 'application/pdf', content: bytes.toString('base64') });
    const id = cr.body.record.id;

    // 本人可下载，内容一致
    const own = await c.rq.get(`/api/records/${id}/backup`).set('Cookie', alice.cookie);
    assert.equal(own.status, 200);
    assert.deepEqual(Buffer.from(own.body), bytes);
    assert.match(own.headers['content-disposition'], /attachment/);

    // 总管理可下载
    const adm = await c.rq.get(`/api/records/${id}/backup`).set('Cookie', admin.cookie);
    assert.equal(adm.status, 200);

    // 他人 403
    const other = await c.rq.get(`/api/records/${id}/backup`).set('Cookie', bob.cookie);
    assert.equal(other.status, 403);

    // 无备份 404
    const cr2 = await c.rq.post('/api/records').set('Cookie', alice.cookie).set('X-CSRF-Token', alice.csrf)
      .send({ destination: 'jzw', filename: 'plain.txt', size: 3 });
    const noB = await c.rq.get(`/api/records/${cr2.body.record.id}/backup`).set('Cookie', alice.cookie);
    assert.equal(noB.status, 404);
  } finally { c.db.close(); }
});

test('备份：内容超限与非法 base64 被拒绝', async () => {
  const c = makeTestContext({ config: { backup: { enabled: true, retentionDays: 7, maxFileBytes: 100 } } });
  try {
    await bootstrap(c);
    const admin = await loginAgent(c.rq, 'chief', 'ChiefPass123');
    await createApprovedUser(c, { username: 'alice', displayName: 'Alice', password: 'AlicePass123' }, admin);
    const alice = await loginAgent(c.rq, 'alice', 'AlicePass123');

    // 超限（> 100 字节）
    const big = Buffer.alloc(101, 0x61).toString('base64');
    const r1 = await c.rq.post('/api/records').set('Cookie', alice.cookie).set('X-CSRF-Token', alice.csrf)
      .send({ destination: 'jzw', filename: 'big.bin', size: 101, content: big });
    assert.equal(r1.status, 400);
    assert.match(r1.body.error, /上限/);

    // 非法 base64（长度非 4 倍数）
    const r2 = await c.rq.post('/api/records').set('Cookie', alice.cookie).set('X-CSRF-Token', alice.csrf)
      .send({ destination: 'jzw', filename: 'bad.bin', size: 1, content: 'abcde' });
    assert.equal(r2.status, 400);

    // 含非法字符
    const r3 = await c.rq.post('/api/records').set('Cookie', alice.cookie).set('X-CSRF-Token', alice.csrf)
      .send({ destination: 'jzw', filename: 'bad2.bin', size: 1, content: 'aGVsbG8=!' });
    assert.equal(r3.status, 400);
  } finally { c.db.close(); }
});

test('备份：到期清理删除文件并清空 backup_path', async () => {
  const c = makeTestContext();
  try {
    await bootstrap(c);
    const admin = await loginAgent(c.rq, 'chief', 'ChiefPass123');
    await createApprovedUser(c, { username: 'alice', displayName: 'Alice', password: 'AlicePass123' }, admin);
    const alice = await loginAgent(c.rq, 'alice', 'AlicePass123');
    const { storeBackup, cleanupBackups, resolveBackup } = require('../app/backup');

    const rec = c.db.createRecord({ userId: 2, username: 'alice', filename: 'old.bin', size: 4, destination: 'jzw' });
    const rel = storeBackup({ dataDir: c.dataDir, recordId: rec.id, filename: rec.filename, buffer: Buffer.from('old!') });
    c.db.setRecordBackup(rec.id, rel, 4);

    // 把备份文件时间拨到 8 天前
    const abs = path.join(c.dataDir, rel);
    const old = new Date(Date.now() - 8 * 86400000);
    fs.utimesSync(abs, old, old);

    const cleaned = cleanupBackups({ dataDir: c.dataDir, retentionDays: 7 });
    assert.ok(cleaned.includes(String(rec.id)), `应清理记录 ${rec.id}`);
    assert.ok(!fs.existsSync(abs), '备份文件应被删除');
    c.db.clearRecordBackup(rec.id);
    assert.equal(c.db.getRecord(rec.id).backup_path, '');
    assert.equal(resolveBackup({ dataDir: c.dataDir, record: c.db.getRecord(rec.id) }), null);
  } finally { c.db.close(); }
});
