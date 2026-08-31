'use strict';
/* ============================================================================
 * 接收端构建产物测试：
 * - 真实版：完整应用 + 进入接收界面 + 全部 worker 保留
 * - 发布版：仅 decode worker、codec 已混淆、渲染 Bo
 * - 发布版混淆 codec 功能验证：vm 沙箱执行 loader → CimQR 往返 render/decode 成功
 * ========================================================================== */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const build = require('../receiver/build_receiver');
const ROOT = path.join(__dirname, '..');

let real, release, script1Of;

before(() => {
  // 重新构建，确保产物与当前源码一致
  build.buildReal_placeholder || void 0;
  // 直接读取现有产物（构建由 scripts 或 npm run build:receiver 完成）
  real = fs.readFileSync(path.join(build.OUT_DIR, 'real.html'), 'utf8');
  release = fs.readFileSync(path.join(build.OUT_DIR, 'release.html'), 'utf8');
});

function extractScript1(html) {
  const s1s = html.indexOf('<script>') + '<script>'.length;
  const s1e = html.indexOf('</script>', s1s);
  return html.slice(s1s, s1e);
}

function extractScript2(html) {
  const s2s = html.indexOf('<script type="module">') + '<script type="module">'.length;
  const s2e = html.indexOf('</script>', s2s);
  return html.slice(s2s, s2e);
}

test('真实版：完整应用，初始进入接收界面，全部 worker 保留', () => {
  assert.ok(real.length > 1000000);
  assert.ok(real.includes('id="root"'));
  assert.ok(real.includes('location.hash = "receiver"'));
  assert.ok(real.includes('Er(r(Ko,{}),_r)'));
  assert.ok(!real.includes('Er(r(pa,{}),_r)'));
  const s1 = extractScript1(real);
  const re = /window\.__RQR_WORKERS\.(\w+)\s*=\s*/g;
  let m;
  const names = [];
  while ((m = re.exec(s1))) names.push(m[1]);
  assert.deepEqual(names.sort(), ['decode', 'encode', 'gif', 'qr_render'].sort());
});

test('发布版：仅 decode worker，codec 无明文，直接渲染接收端', () => {
  assert.ok(release.length > 1000000);
  assert.ok(release.includes('id="root"'));
  const s1 = extractScript1(release);
  const re = /window\.__RQR_WORKERS\.(\w+)\s*=\s*/g;
  let m;
  const names = [];
  while ((m = re.exec(s1))) names.push(m[1]);
  assert.deepEqual(names, ['decode']);
  // codec 明文特征不得出现
  for (const marker of ['CimQR — 彩色 cimbar/QR 混合编解码器', 'function renderFrame', 'function decodeFrame', 'function maybeColor']) {
    assert.ok(!release.includes(marker), `发布版泄露明文特征: ${marker}`);
  }
  // 直接渲染接收端组件
  const s2 = extractScript2(release);
  assert.ok(s2.includes('Er(r(Bo,{}),_r)'));
  assert.ok(!s2.includes('Er(r(pa,{}),_r)'));
  // decode worker 以混淆 loader 开头
  const wm = s1.match(/__RQR_WORKERS\.decode = "data:text\/javascript;base64,([^"]+)"/);
  assert.ok(wm);
  const workerSrc = Buffer.from(wm[1], 'base64').toString('utf8');
  assert.ok(workerSrc.includes('atob'));
  assert.ok(workerSrc.includes('__RQR_WASM_MAP')); // worker 其余逻辑保留
});

test('发布版混淆 codec 功能验证：loader 解码后 CimQR 往返 render/decode 一致', () => {
  const s1 = extractScript1(release);
  const wm = s1.match(/__RQR_WORKERS\.decode = "data:text\/javascript;base64,([^"]+)"/);
  const workerSrc = Buffer.from(wm[1], 'base64').toString('utf8');
  // 取出 loader（codec 解码段）：到 worker 基座代码之前
  const loaderEnd = workerSrc.indexOf('\nself.__RQR_WASM_MAP');
  assert.ok(loaderEnd > 0, '未找到 worker 基座边界');
  const loader = workerSrc.slice(0, loaderEnd);

  const sandbox = {
    self: null,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    TextDecoder, TextEncoder, Uint8Array, Uint8ClampedArray, Int32Array, Uint32Array, Float64Array,
    ArrayBuffer, DataView, Promise, Map, Set, BigInt, console, Math, Number, String, Object, Array, Date,
    setTimeout, clearTimeout, WebAssembly, Symbol, Error, RangeError, TypeError, JSON, RegExp, URL, URLSearchParams,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(loader, sandbox, { timeout: 15000 });

  const CimQR = sandbox.CimQR;
  assert.ok(CimQR, 'loader 未还原 CimQR');
  assert.equal(typeof CimQR.render, 'function');
  assert.equal(typeof CimQR.decode, 'function');

  // 往返验证：随机 payload → render → decode → 还原
  const payload = Buffer.from('RaptorQR 彩色接收端往返测试 payload-2026-' + 'x'.repeat(200), 'utf8');
  const frame = CimQR.render(payload);
  assert.ok(frame && frame.data && frame.width > 100);
  assert.equal(frame.data.length, frame.width * frame.height * 4);
  // 与原版 codec 结果比对（同一 payload 应渲染一致、解码一致）
  const orig = require(path.join(ROOT, '..', 'cimqr_codec.js'));
  const frameOrig = orig.render(payload);
  assert.equal(frame.width, frameOrig.width);
  assert.deepEqual(Array.from(frame.data), Array.from(frameOrig.data), '渲染像素应与原版一致');

  const decoded = CimQR.decode(frame.data, frame.width, frame.height);
  assert.ok(Array.isArray(decoded) && decoded.length >= 1, '应解码出至少一个包');
  const recovered = Buffer.from(decoded[0]).toString('utf8');
  assert.equal(recovered, payload.toString('utf8'), '混淆后 codec 应能完整还原 payload');
});

test('真实版可直接打开（含 root 与完整脚本）', () => {
  assert.ok(real.includes('</body>'));
  assert.ok(real.includes('</html>'));
  const s2 = extractScript2(real);
  assert.ok(s2.length > 50000);
});
