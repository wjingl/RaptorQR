// 彩色 CimQR 压力/物理边界测试。
// 这些场景不属于现实手机基线；允许 expected_boundary，但禁止错误接受。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'camera_sim_frames.json');
const sim = require('./camera_sim');
const e2eSrc = fs.readFileSync(__dirname + '/test_browser_e2e.js', 'utf8');
const pngFn = e2eSrc.match(/function decodePNG[\s\S]*?\n}\n/);
if (!pngFn) throw new Error('decodePNG helper not found');
const pngBox = {};
vm.runInNewContext(pngFn[0] + '\npngBox.decodePNG=decodePNG;', { pngBox, Buffer, zlib: require('zlib'), Uint8Array, Uint8ClampedArray, DataView, Uint16Array, Uint32Array, Math });
const decodePNG = pngBox.decodePNG;
const vmMod = async () => {
  const src = fs.readFileSync(__dirname + '/fixtures/check_decode.mjs', 'utf8');
  const wasm = fs.readFileSync(__dirname + '/fixtures/wasm_map_extracted.js', 'utf8');
  const listeners = [], posted = [];
  const sandbox = { postMessage: m => posted.push(m), addEventListener: (t, f) => t === 'message' && listeners.push(f), ImageData: class { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } }, TextEncoder, TextDecoder, Uint8Array, Uint8ClampedArray, Uint32Array, Int32Array, Float64Array, ArrayBuffer, DataView, Promise, Map, Set, BigInt, console, Math, Number, String, Object, Array, Date, Error, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, WebAssembly, FinalizationRegistry, Symbol, RangeError, TypeError, JSON, RegExp, URL, URLSearchParams, fetch, Response, Request, Headers, performance, crypto, location: { href: 'file:///worker.mjs' } };
  sandbox.self = sandbox; sandbox.globalThis = sandbox; vm.createContext(sandbox); vm.runInContext(wasm, sandbox);
  const mod = new vm.SourceTextModule(src, { context: sandbox, identifier: 'camera-stress-decode.mjs' });
  await mod.link(() => { throw new Error('unexpected import'); });
  const evalPromise = mod.evaluate();
  await new Promise(r => setTimeout(r, 50));
  for (const f of listeners.slice()) f({ data: { type: 'wasm-assets', map: sandbox.WASM_MAP, debug: false } });
  await evalPromise;
  return { posted, dispatch: m => { for (const f of listeners.slice()) f({ data: m }); if (typeof sandbox.onmessage === 'function') sandbox.onmessage({ data: m }); } };
};
(async () => {
  if (!fs.existsSync(FIXTURE)) throw new Error('missing camera fixture; run camera_sim.js once');
  const j = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')); const base = decodePNG(j.frames[1]); const W = base.width, H = base.height;
  const scenarios = [
    { id: 'S01', name: '符号占50%', policy: 'expected_boundary', make: () => { const s = sim.scaleCenter(0.5, W, H); return sim.transformImage(base, s.m, s.outW, s.outH, [240, 240, 240]); } },
    { id: 'S02', name: '重度失焦σ2', policy: 'expected_boundary', make: () => sim.gaussianBlur(base, 2) },
    { id: 'S03', name: '重度失焦σ3', policy: 'expected_boundary', make: () => sim.gaussianBlur(base, 3) },
    { id: 'S04', name: '强噪声±30', policy: 'expected_boundary', make: () => sim.addNoise(base, 30) },
    { id: 'S05', name: '50%+重模糊+强噪声', policy: 'expected_boundary', make: () => { const s = sim.scaleCenter(0.5, W, H); let im = sim.transformImage(base, s.m, s.outW, s.outH, [240, 240, 240]); return sim.addNoise(sim.gaussianBlur(im, 2), 30); } },
    { id: 'S06', name: '极端透视8%', policy: 'expected_boundary', make: () => sim.perspective(base, Math.round(W * 0.08)) },
    { id: 'S07', name: '过曝×1.5+20', policy: 'must_not_false_accept', make: () => sim.exposure(base, 1.5, 20) },
    { id: 'S08', name: '局部高光', policy: 'threshold', make: () => sim.glareSpot(base, W * 0.52, H * 0.48, W * 0.18, H * 0.10, 0.85) },
  ];
  const codec = require(path.join(ROOT, 'cimqr_codec.js')); const worker = await vmMod(); const rows = [];
  for (const s of scenarios) {
    const img = s.make(); const maybeColor = codec.maybeColor(img.data, img.width, img.height); const det = codec._detect(img.data, img.width, img.height); const packets = codec.decode(img.data, img.width, img.height) || []; const info = codec.info();
    worker.dispatch({ type: 'reset' }); worker.posted.length = 0; worker.dispatch({ type: 'settings', settings: { binarizer: 'LocalAverage', maxSymbols: 'auto', tryDownscale: true, downscaleFactor: 3 }, fecCodec: 'auto' });
    worker.dispatch({ type: 'frame', pixels: img.data.buffer.slice(0), width: img.width, height: img.height, realtime: false }); await new Promise(r => setTimeout(r, 150));
    const events = worker.posted.filter(m => m.type === 'single-code'); const code = events[events.length - 1]; const prog = worker.posted.filter(m => m.type === 'progress').pop() || {};
    const accepted = prog.acceptedPackets || 0, unique = prog.uniquePackets || 0; const falseAccept = accepted > 0 && packets.length === 0; const ok = !falseAccept;
    const row = { id: s.id, name: s.name, policy: s.policy, ok, stage: packets.length ? 'single-code-ok' : (code?.info?.stage || (det.sel ? info.stage : (maybeColor ? 'no-anchor' : 'no-color-signal'))), maybeColor, finders: det.cands.length, selected: det.sel ? 3 : 0, packets: packets.length, accepted, unique, needed: prog.neededPackets || 0, info: code?.info || info };
    rows.push(row); console.log(JSON.stringify(row));
  }
  const bad = rows.filter(r => !r.ok); console.log('压力测试：' + (rows.length - bad.length) + '/' + rows.length + '（expected_boundary 允许物理失败，但禁止错误接受）'); process.exitCode = bad.length ? 2 : 0;
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
