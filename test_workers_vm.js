// 用 vm.SourceTextModule 执行修补后的 worker，验证彩色模式真实运行
const fs = require('fs');
const vm = require('vm');
const path = require('path');

async function runWorker(file) {
  const listeners = [];
  const posted = [];
  const sandbox = {
    postMessage: (msg) => posted.push(msg),
    addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); },
    ImageData: class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } },
    TextEncoder, TextDecoder, Uint8Array, Uint8ClampedArray, Uint32Array, Int32Array, Float64Array,
    ArrayBuffer, DataView, Promise, Map, Set, BigInt, console, Math, Number, String, Object, Array, Date,
    setTimeout, clearTimeout, WebAssembly, FinalizationRegistry, Symbol, Error, RangeError, TypeError, JSON, RegExp, URL, URLSearchParams,
    location: { href: 'file:///worker.mjs' },
  };
  sandbox.self = sandbox; // 真实 worker 中 self === globalThis
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const env = {
    postMessage: sandbox.postMessage,
    addEventListener: sandbox.addEventListener,
    __listeners: listeners,
    __posted: posted,
    get onmessage() { return sandbox.onmessage; },
    set onmessage(v) { sandbox.onmessage = v; },
  };
  const code = fs.readFileSync(file, 'utf8');
  const mod = new vm.SourceTextModule(code, { context: sandbox, identifier: file });
  await mod.link(() => { throw new Error("unexpected import in worker: " + file); });
  const evalPromise = mod.evaluate(); // 顶层 await 挂起等待 wasm-assets
  // 发送 wasm-assets 引导
  await new Promise(r => setTimeout(r, 30));
  for (const fn of listeners.slice()) fn({ data: { type: 'wasm-assets', map: {}, debug: false } });
  await evalPromise;
  return env;
}

(async () => {
  // ===== 1. qr_render worker：彩色渲染 =====
  const renderEnv = await runWorker('check_qr_render.mjs');
  console.log('qr_render onmessage:', typeof renderEnv.onmessage);
  const packet = new Uint8Array(3000);
  for (let i = 0; i < packet.length; i++) packet[i] = (i * 31) & 255;
  const buf = packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength);
  renderEnv.__posted.length = 0;
  renderEnv.onmessage({ data: { type: 'render', packet: buf, version: 20, ecc: 'L', scale: 3, qrEncoder: 'color-cimbar', jobId: 1 } });
  await new Promise(r => setTimeout(r, 300));
  const rendered = renderEnv.__posted.find(m => m.type === 'rendered');
  console.log('render:', rendered ? `${rendered.width}x${rendered.height}, ${rendered.buffer.byteLength} bytes` : 'NONE', rendered ? '' : JSON.stringify(renderEnv.__posted));
  if (!rendered) { console.log('RENDER FAILED'); process.exit(1); }

  // ===== 2. 用 codec 验证渲染帧可解码回原包 =====
  const CimQR = require('./cimqr_codec.js');
  const rgba = new Uint8ClampedArray(rendered.buffer);
  const res = CimQR.decode(rgba, rendered.width, rendered.height);
  const ok = res.length === 1 && res[0].length === packet.length && res[0].every((v, i) => v === packet[i]);
  console.log('codec decode of worker-rendered tile:', ok ? 'ROUND-TRIP OK' : 'FAIL');

  // ===== 3. decode worker：彩色帧处理 =====
  const decodeEnv = await runWorker('check_decode.mjs');
  decodeEnv.__posted.length = 0;
  decodeEnv.onmessage({ data: { type: 'settings', settings: { binarizer: 'LocalAverage', maxSymbols: 'auto', tryDownscale: true, downscaleFactor: 3 }, fecCodec: 'wasm-raptorq' } });
  const fakeImageData = new sandbox.ImageData(rgba, rendered.width, rendered.height);
  decodeEnv.onmessage({ data: { type: 'frame', imageData: fakeImageData } });
  await new Promise(r => setTimeout(r, 800));
  const msgs = decodeEnv.__posted.filter(m => m.type === 'progress' || m.type === 'complete' || m.type === 'error');
  console.log('decode worker msgs:', msgs.map(m => m.type + (m.type === 'error' ? ': ' + m.message : m.type === 'progress' ? ' (status=' + m.status + ')' : '')).join(' | '));

  console.log(ok ? '\nWORKER EXECUTION VERIFIED' : '\nROUND TRIP FAILED');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('TEST ERROR:', e.message); console.error(e.stack); process.exit(1); });
