'use strict';
/* ============================================================================
 * 验证码：@depup/svg-captcha（维护 fork）
 * - 答案不落明文：sha256(答案 + captchaSalt) 存库
 * - 一次性使用 + 过期；比对用 timingSafeEqual
 * ========================================================================== */
const crypto = require('crypto');
const svgCaptcha = require('@depup/svg-captcha');

function sha256hex(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex');
}

function createCaptcha(db, secrets, config) {
  const c = svgCaptcha.create({
    size: 4,
    noise: 2,
    color: true,
    background: '#0d1117',
    ignoreChars: '0o1ilI',
    fontSize: 46,
  });
  // 测试钩子：仅当环境变量 RQR_TEST_CAPTCHA=1 时使用固定答案（生产环境不设置）
  const text = process.env.RQR_TEST_CAPTCHA === '1' ? 'test' : c.text;
  const id = crypto.randomBytes(16).toString('hex');
  const answerHash = sha256hex(text.toLowerCase() + secrets.captchaSalt);
  db.saveCaptcha(id, answerHash, config.captcha.ttlMinutes);
  return { id, svg: c.data };
}

function verifyCaptcha(db, secrets, id, answer) {
  if (!id || !answer) return false;
  const row = db.getCaptcha(id);
  if (!row) return false;
  db.consumeCaptcha(id); // 一次性：无论成败均消耗，防重放
  if (new Date(row.expires_at).getTime() < Date.now()) return false;
  const expected = Buffer.from(row.answer_hash, 'hex');
  const actual = Buffer.from(sha256hex(String(answer).toLowerCase() + secrets.captchaSalt), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

module.exports = { createCaptcha, verifyCaptcha };
