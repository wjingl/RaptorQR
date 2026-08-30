// GIF worker 彩色路径真实执行：encode worker 生成 6 包 → gif worker 生成 GIF → 校验结构
const fs = require('fs');
const T = require('./test_tolerance.js');

(async () => {
  // 1) encode: 30KB 随机 → 6 包
  const rnd = new Uint8Array(30000);
  for (let i = 0; i < rnd.length; i++) rnd[i] = (Math.random() * 256) | 0;
  const w = await (async () => {
    const vm = require('vm');
    const src = fs.readFileSync('worker_encode_color.js', 'utf8');
    const wasmMapCode = fs.readFileSync('wasm_map_extracted.js', 'utf8');
    const listeners = [], posted = [];
    const sandbox = {
      postMessage: (msg) => posted.push(msg),
      addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); },
      ImageData: class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } },
      TextEncoder, TextDecoder, Uint8Array, Uint8ClampedArray, Uint32Array, Int32Array, Float64Array,
      ArrayBuffer, DataView, Promise, Map, Set, BigInt, console, Math, Number, String, Object, Array, Date, Error,
      setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
      WebAssembly, FinalizationRegistry, Symbol, RangeError, TypeError, JSON, RegExp, URL, URLSearchParams,
      fetch: (u, o) => fetch(u, o),
      Response: typeof Response !== 'undefined' ? Response : undefined,
      Request: typeof Request !== 'undefined' ? Request : undefined,
      Headers: typeof Headers !== 'undefined' ? Headers : undefined,
      performance, crypto,
      location: { href: 'file:///worker.mjs' },
    };
    sandbox.self = sandbox; sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(wasmMapCode, sandbox);
    const mod = new vm.SourceTextModule(src, { context: sandbox, identifier: 'encode-worker.mjs' });
    await mod.link(() => { throw new Error('unexpected import'); });
    const evalPromise = mod.evaluate();
    await new Promise(r => setTimeout(r, 50));
    for (const fn of listeners.slice()) fn({ data: { type: 'wasm-assets', map: sandbox.WASM_MAP, debug: false } });
    await evalPromise;
    return { posted, dispatch: (msg) => { for (const fn of listeners.slice()) fn({ data: msg }); if (typeof sandbox.onmessage === 'function') sandbox.onmessage({ data: msg }); } };
  })();
  w.dispatch({ type: 'encode', data: rnd.buffer.slice(0), isText: false, compress: true, fecCodec: 'wasm-raptorq', symbolSize: 7229, raptorqRepairPercent: 10, filename: 't.bin', mimeType: 'application/octet-stream' });
  const encoded = await new Promise((res, rej) => {
    const iv = setInterval(() => {
      const m = w.posted.find(x => x.type === 'encoded' || x.type === 'error');
      if (m) { clearInterval(iv); m.type === 'encoded' ? res(m) : rej(new Error(m.message)); }
    }, 20);
  });
  console.log('encoded packets:', encoded.packets.length);

  // 2) gif worker generate
  const gifw = await (async () => {
    const vm = require('vm');
    const src = fs.readFileSync('worker_gif_color.js', 'utf8');
    const wasmMapCode = fs.readFileSync('wasm_map_extracted.js', 'utf8');
    const listeners = [], posted = [];
    const sandbox = {
      postMessage: (msg) => posted.push(msg),
      addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); },
      ImageData: class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } },
      TextEncoder, TextDecoder, Uint8Array, Uint8ClampedArray, Uint32Array, Int32Array, Float64Array,
      ArrayBuffer, DataView, Promise, Map, Set, BigInt, console, Math, Number, String, Object, Array, Date, Error,
      setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
      WebAssembly, FinalizationRegistry, Symbol, RangeError, TypeError, JSON, RegExp, URL, URLSearchParams,
      fetch: (u, o) => fetch(u, o),
      Response: typeof Response !== 'undefined' ? Response : undefined,
      Request: typeof Request !== 'undefined' ? Request : undefined,
      Headers: typeof Headers !== 'undefined' ? Headers : undefined,
      performance, crypto,
      location: { href: 'file:///worker.mjs' },
    };
    sandbox.self = sandbox; sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(wasmMapCode, sandbox);
    const mod = new vm.SourceTextModule(src, { context: sandbox, identifier: 'gif-worker.mjs' });
    await mod.link(() => { throw new Error('unexpected import'); });
    const evalPromise = mod.evaluate();
    await new Promise(r => setTimeout(r, 50));
    for (const fn of listeners.slice()) fn({ data: { type: 'wasm-assets', map: sandbox.WASM_MAP, debug: false } });
    await evalPromise;
    return { posted, dispatch: (msg) => { for (const fn of listeners.slice()) fn({ data: msg }); if (typeof sandbox.onmessage === 'function') sandbox.onmessage({ data: msg }); } };
  })();

  const t0 = Date.now();
  gifw.dispatch({ type: 'generate', packets: encoded.packets, packetOrder: undefined, frameDelayMs: 150, qrVersion: 10, eccLevel: 'L', qrEncoder: 'color-cimbar', parallelCount: 4 });
  const gif = await new Promise((res, rej) => {
    const iv = setInterval(() => {
      const m = gifw.posted.find(x => x.gifData || x.type === 'error');
      if (m) { clearInterval(iv); m.gifData ? res(m) : rej(new Error(m.message)); }
    }, 20);
  });
  const ms = Date.now() - t0;
  const gd = Buffer.from(gif.gifData);
  const okHeader = gd.subarray(0, 6).toString('ascii') === 'GIF89a';
  console.log('GIF: header=' + gd.subarray(0, 6).toString('ascii') + ' 尺寸=' + gif.width + 'x' + gif.height + ' 帧数=' + gif.frameCount + ' 大小=' + gd.length + 'B (' + ms + 'ms)');
  // 帧数应为 6（每包一帧）
  console.log('GIF 帧数正确:', gif.frameCount === encoded.packets.length);
  console.log('GIF 头部正确:', okHeader);
  console.log('gif worker 彩色路径:', (okHeader && gif.frameCount === encoded.packets.length && gif.width === 1088) ? 'PASS' : 'FAIL');
  process.exit(okHeader && gif.frameCount === encoded.packets.length ? 0 : 1);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
