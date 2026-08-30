// 功能测试：修补后的 worker（qr_render/decode/gif）在 Node 中的彩色模式回路
const CimQR = require('./cimqr_codec.js');

function makeWorkerEnv() {
  const listeners = [];
  const posted = [];
  const env = {
    self: null,
    posted,
    addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); },
    dispatch: (data) => listeners.forEach((fn) => fn({ data })),
    postMessage: (msg) => posted.push(msg),
  };
  return env;
}

// 加载 worker 模块（模拟 worker 全局环境）
async function loadWorkerModule(file) {
  const env = makeWorkerEnv();
  const code = require('fs').readFileSync(file, 'utf8');
  // 用 vm 在独立上下文执行，提供 self/postMessage/addEventListener/ImageData/import.meta
  const vm = require('vm');
  const ctx = {
    self: env,
    postMessage: env.postMessage,
    addEventListener: env.addEventListener,
    ImageData: class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } },
    TextEncoder, TextDecoder, Uint8Array, Uint8ClampedArray, Uint32Array, Int32Array, Float64Array,
    ArrayBuffer, DataView, Promise, Map, Set, BigInt, console, Math, Number, String, Object, Array, Date, URL,
    setTimeout, clearTimeout, WebAssembly, FinalizationRegistry,
  };
  ctx.globalThis = ctx;
  // import.meta.url 需要
  const wrapped = `(async () => { const module = { meta: { url: 'file:///worker.mjs' } }; const importMeta = { url: 'file:///worker.mjs' }; with (ctx) { ... } })()`;
  // 直接执行：worker 源码用顶层 await，需要用 vm.SourceTextModule 或 eval with await
  // 简化：把顶层 await 包进 async 函数执行
  const asyncCode = `(async function(){ ${code} }).call(this)`;
  const sandbox = vm.createContext(ctx);
  try {
    await vm.runInContext(asyncCode, sandbox, { filename: file });
  } catch (e) {
    // 顶层 await 在 vm 中不支持 → 尝试替换顶层 await 为 Promise
    throw e;
  }
  return env;
}

async function main() {
  // 1) 加载 qr_render worker，测试彩色渲染
  const renderEnv = await loadWorkerModule('check_qr_render.mjs');
  renderEnv.dispatch({ type: 'wasm-assets', map: {}, debug: false });
  await new Promise(r => setTimeout(r, 50));
  console.log('qr_render onmessage set:', typeof renderEnv.self.onmessage === 'function');
  // 渲染一个 3000 字节的包
  const packet = new Uint8Array(3000);
  for (let i = 0; i < packet.length; i++) packet[i] = (i * 31) & 255;
  const buf = packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength);
  renderEnv.dispatch({ type: 'render', packet: buf, version: 20, ecc: 'L', scale: 3, qrEncoder: 'color-cimbar', jobId: 1 });
  await new Promise(r => setTimeout(r, 300));
  const rendered = renderEnv.posted.find(m => m.type === 'rendered');
  console.log('rendered:', rendered ? `${rendered.width}x${rendered.height}` : 'NONE');
  if (!rendered) { console.log('render error:', JSON.stringify(renderEnv.posted)); process.exit(1); }
  // 拿到渲染结果 RGBA
  const rgba = new Uint8ClampedArray(rendered.buffer);
  const W = rendered.width, H = rendered.height;
  console.log('tile bytes:', rgba.length);

  // 2) 用 codec 直接验证渲染的帧可解码
  const res = CimQR.decode(rgba, W, H);
  console.log('codec decode of rendered tile:', res.length, res[0] ? 'len=' + res[0].length + ' match=' + res[0].every((v, i) => v === packet[i]) : '');

  // 3) 加载 decode worker，测试帧处理（彩色）
  const decodeEnv = await loadWorkerModule('check_decode.mjs');
  decodeEnv.dispatch({ type: 'wasm-assets', map: {}, debug: false });
  await new Promise(r => setTimeout(r, 50));
  decodeEnv.dispatch({ type: 'settings', settings: { binarizer: 'LocalAverage', maxSymbols: 'auto', tryDownscale: true, downscaleFactor: 3 }, fecCodec: 'wasm-raptorq' });
  await new Promise(r => setTimeout(r, 30));
  decodeEnv.posted.length = 0;
  decodeEnv.dispatch({ type: 'frame', imageData: new (class { constructor(){ this.data = rgba; this.width = W; this.height = H; } })() });
  await new Promise(r => setTimeout(r, 500));
  const decodeMsgs = decodeEnv.posted.filter(m => m.type === 'progress' || m.type === 'complete' || m.type === 'error');
  console.log('decode worker messages:', decodeMsgs.map(m => m.type + (m.type === 'error' ? ': ' + m.message : '')).join(' | '));
}

main().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
