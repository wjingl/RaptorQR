// 出货管道小尺寸闭环：qr_render worker 渲染 24×24 → decode worker 解码（非默认档位收发验证）
const fs = require('fs');
const vm = require('vm');
async function makeWorker(src, wasmMapCode) {
  const listeners = [], posted = [];
  const sandbox = {
    postMessage: (m) => posted.push(m),
    addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); },
    ImageData: class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } },
    TextEncoder, TextDecoder, Uint8Array, Uint8ClampedArray, Uint32Array, Int32Array, Float64Array,
    ArrayBuffer, DataView, Promise, Map, Set, BigInt, console, Math, Number, String, Object, Array, Date, Error,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    WebAssembly, FinalizationRegistry, Symbol, RangeError, TypeError, JSON, RegExp, URL, URLSearchParams,
    fetch: (u, o) => fetch(u, o), Response, Request, Headers, performance, crypto,
    location: { href: 'file:///worker.mjs' },
  };
  sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(wasmMapCode, sandbox);
  const mod = new vm.SourceTextModule(src, { context: sandbox, identifier: 'w.mjs' });
  await mod.link(() => { throw new Error('unexpected import'); });
  const ep = mod.evaluate();
  await new Promise(r => setTimeout(r, 100));
  for (const fn of listeners.slice()) fn({ data: { type: 'wasm-assets', map: sandbox.WASM_MAP, debug: false } });
  await ep;
  return { posted, onmessage: (m) => { for (const fn of listeners.slice()) fn(m); if (typeof sandbox.onmessage === 'function') sandbox.onmessage(m); } };
}
(async () => {
  const wasmMap = fs.readFileSync('fixtures/wasm_map_extracted.js', 'utf8');
  // 渲染 worker（出货版，cimSize 支持）
  const rw = await makeWorker(fs.readFileSync('fixtures/check_qr_render.mjs', 'utf8'), wasmMap);
  const pkt = new Uint8Array(100);
  for (let i = 0; i < pkt.length; i++) pkt[i] = (Math.random() * 256) | 0;
  const scale = 1088 / 296; // 24×24 档目标画布 1088
  rw.posted.length = 0;
  rw.onmessage({ data: { type: 'render', packet: pkt.buffer.slice(0), qrEncoder: 'color-cimbar', version: 10, ecc: 'L', scale, cimSize: 10, jobId: 1 } });
  const rres = await new Promise((resolve) => {
    const iv = setInterval(() => { const m = rw.posted.find(x => x.type === 'rendered' || x.type === 'error'); if (m) { clearInterval(iv); resolve(m); } }, 15);
    setTimeout(() => resolve(null), 20000);
  });
  if (!rres || rres.type !== 'rendered') { console.log('渲染 worker 失败:', JSON.stringify(rres)); process.exit(1); }
  const frame = new Uint8ClampedArray(rres.buffer.slice(0));
  console.log('qr_render worker 渲染 24×24: ' + rres.width + 'x' + rres.height);
  // 解码：worker 渲染帧 → codec 包级还原（RaptorQ 流解析与尺寸无关，浏览器 E2E 已覆盖）
  const CimQR = require('../cimqr_codec.js');
  const rgba = new Uint8ClampedArray(rres.buffer);
  const res = CimQR.decode(rgba, rres.width, rres.height);
  const ok = res.length === 1 && res[0].length === pkt.length && res[0].every((v, i) => v === pkt[i]);
  console.log('codec 解码 worker 渲染的 24×24 帧:', ok ? 'OK 包逐字节一致' : 'FAIL');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
