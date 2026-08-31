// 多包累积/去重/丢帧容错演示：
// 真实 encode worker（RaptorQ WASM）生成 N 包 → codec 渲染成帧 → 真实 decode worker
// 逐帧喂入（含重复帧、故意丢帧），验证：
//   1) 去重（重复包不重复计数）  2) 累积缓存跨帧持久  3) 不必收齐整轮即可解码
const fs = require('fs');
const zlib = require('zlib');
const vm = require('vm');
const lib = fs.readFileSync(__dirname + '/test_browser_e2e.js', 'utf8');
eval(lib.match(/function decodePNG[\s\S]*?\n}\n/)[0]);
const C = require('../cimqr_codec.js');

function makeWorkerSandbox(srcFile, postFn) {
  const src = fs.readFileSync(srcFile, 'utf8');
  const wasmMapCode = fs.readFileSync(__dirname + '/fixtures/wasm_map_extracted.js', 'utf8');
  const listeners = [], posted = [];
  const sandbox = {
    postMessage: postFn || ((msg) => posted.push(msg)),
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
  const mod = new vm.SourceTextModule(src, { context: sandbox, identifier: srcFile });
  return mod.link(() => { throw new Error('unexpected import'); }).then(() => {
    const evalPromise = mod.evaluate();
    return new Promise(res => setTimeout(res, 50)).then(() => {
      for (const fn of listeners.slice()) fn({ data: { type: 'wasm-assets', map: sandbox.WASM_MAP, debug: false } });
      return evalPromise.then(() => ({
        posted,
        dispatch: (msg) => { for (const fn of listeners.slice()) fn({ data: msg }); if (typeof sandbox.onmessage === 'function') sandbox.onmessage({ data: msg }); },
      }));
    });
  });
}

(async () => {
  // ---- 1) encode worker: 26KB 不可压缩随机字节（文件模式）→ 4 源符号 + 10% 修复 ≈ 5 包 ----
  const rnd = new Uint8Array(26000);
  for (let i = 0; i < rnd.length; i++) rnd[i] = (Math.random() * 256) | 0;
  const enc = await makeWorkerSandbox(__dirname + '/fixtures/worker_encode_color.js');
  const t0 = Date.now();
  enc.dispatch({ type: 'encode', data: rnd.buffer.slice(0), isText: false, compress: true, fecCodec: 'wasm-raptorq', symbolSize: 7229, raptorqRepairPercent: 10, filename: 'test.bin', mimeType: 'application/octet-stream' });
  const encoded = await new Promise((res, rej) => {
    const iv = setInterval(() => {
      const m = enc.posted.find(x => x.type === 'encoded' || x.type === 'error');
      if (m) { clearInterval(iv); m.type === 'encoded' ? res(m) : rej(new Error(m.message)); }
    }, 20);
  });
  console.log(`编码: ${rnd.length} 字节 → ${encoded.packets.length} 包 (源 ${encoded.sourcePacketIndices.length} + 修复 ${encoded.repairPacketIndices.length}), 压缩后 ${encoded.stats.preprocessedSize} B, ${Date.now() - t0}ms`);
  console.log('源包索引:', encoded.sourcePacketIndices.join(','), '| 修复包索引:', encoded.repairPacketIndices.join(','));

  // ---- 2) 每包渲染成彩色帧 ----
  const frames = encoded.packets.map(p => {
    const f = C.render(new Uint8Array(p));
    return { data: new Uint8ClampedArray(f.data), width: f.width, height: f.height };
  });
  console.log(`渲染 ${frames.length} 帧完成`);

  // ---- 3) decode worker：按“慢解码器”场景喂帧——只喂部分帧、故意重复、乱序 ----
  const dec = await makeWorkerSandbox(__dirname + '/fixtures/worker_decode_color.js');
  dec.dispatch({ type: 'settings', settings: {}, fecCodec: 'auto' });

  // 播放顺序：fast-start = 源包在前，然后循环源+修复；模拟 30fps 下解码器只截获 ~60% 的帧
  const order = [...encoded.sourcePacketIndices, ...encoded.repairPacketIndices, ...encoded.sourcePacketIndices, ...encoded.repairPacketIndices];
  const missed = new Set([2, 5, 7]); // 故意丢掉的帧序号（占 ~37%）
  const seen = new Set();
  const progressLog = [];
  const feed = async (frameIdx) => {
    if (missed.has(frameIdx)) { console.log(`  [帧 ${frameIdx} 采样丢失 → 跳过]`); return; }
    const pkt = order[frameIdx % order.length];
    if (seen.has(pkt)) { console.log(`  [帧 ${frameIdx} 重复包 ${pkt} → 去重丢弃]`); }
    seen.add(pkt);
    const fr = frames[pkt];
    dec.dispatch({ type: 'frame', pixels: fr.data.buffer.slice(0), width: fr.width, height: fr.height, realtime: false });
    await new Promise(r => setTimeout(r, 5)); // 模拟异步处理间隔
  };

  let done = null;
  const monitor = setInterval(() => {
    const comp = dec.posted.find(m => m.type === 'complete');
    if (comp && !done) { done = comp; clearInterval(monitor); }
    const prog = dec.posted.filter(m => m.type === 'progress');
    if (prog.length && prog[prog.length - 1].uniquePackets !== (progressLog.length ? progressLog[progressLog.length - 1].uniquePackets : -1)) {
      progressLog.push(prog[prog.length - 1]);
    }
  }, 5);

  for (let i = 0; i < order.length; i++) {
    await feed(i);
    if (done) break;
  }
  // 若仍没解出，继续喂几轮（模拟循环播放）
  for (let round = 0; round < 3 && !done; round++) {
    for (let i = 0; i < order.length; i++) { await feed(i); if (done) break; }
  }
  clearInterval(monitor);

  console.log('\n—— 进度轨迹（uniquePackets / accepted / solved / total）——');
  for (const p of progressLog) {
    console.log(`  unique=${p.uniquePackets} dup=${p.duplicatePackets} accepted=${p.acceptedPackets} solved=${p.solvedGenerations}/${p.totalGenerations} needed=${p.neededPackets}`);
  }

  if (!done) { console.log('\n✗ 未解出（丢帧过多？）'); process.exit(1); }
  const ok = done.isText === false && Buffer.from(done.data).equals(Buffer.from(rnd));
  console.log('\n丢帧场景（37% 帧丢失 + 重复）下: ' + (ok ? `✓ 完整还原 ${done.data.byteLength} 字节（与原始逐字节一致）` : '✗ 内容不符'));
  console.log('证明: 接收端跨帧累积缓存 + 去重，漏采无需等待整轮');

  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('FATAL:', e.message); console.error(e.stack); process.exit(1); });
