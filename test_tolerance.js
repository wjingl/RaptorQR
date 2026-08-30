// Fault tolerance on the REAL browser-captured frame (v2):
// - transforms are camera-realistic: never crop the symbol core (canvas expands instead)
// - decode via REAL decode worker + REAL RaptorQ WASM (same as shipped pipeline)
const fs = require("fs");
const zlib = require("zlib");
const lib = fs.readFileSync('test_browser_e2e.js', 'utf8');
eval(lib.match(/function decodePNG[\s\S]*?\n}\n/)[0]);

// ---------- bilinear affine transform on an output canvas (samples via inverse) ----------
function transformImage(img, m, outW, outH, bgRGB = [255, 255, 255]) {
  const W = img.width, H = img.height;
  outW = outW || W; outH = outH || H;
  const src = img.data;
  const out = new Uint8ClampedArray(outW * outH * 4);
  const det = m[0] * m[4] - m[1] * m[3];
  const inv = [m[4] / det, -m[1] / det, (m[1] * m[5] - m[2] * m[4]) / det, -m[3] / det, m[0] / det, (m[2] * m[3] - m[0] * m[5]) / det];
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const sx = inv[0] * x + inv[1] * y + inv[2];
      const sy = inv[3] * x + inv[4] * y + inv[5];
      const o = (y * outW + x) * 4;
      if (sx < 0 || sy < 0 || sx >= W - 1 || sy >= H - 1) {
        out[o] = bgRGB[0]; out[o + 1] = bgRGB[1]; out[o + 2] = bgRGB[2]; out[o + 3] = 255;
        continue;
      }
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const fx = sx - x0, fy = sy - y0;
      for (let ch = 0; ch < 3; ch++) {
        const p00 = src[(y0 * W + x0) * 4 + ch], p10 = src[(y0 * W + x0 + 1) * 4 + ch];
        const p01 = src[((y0 + 1) * W + x0) * 4 + ch], p11 = src[((y0 + 1) * W + x0 + 1) * 4 + ch];
        out[o + ch] = p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width: outW, height: outH };
}
// scale about center; for s>1 the canvas grows so nothing is cropped (camera seeing symbol smaller)
function scaleCenter(s, W, H) {
  const outW = Math.round(W * Math.max(s, 1)), outH = Math.round(H * Math.max(s, 1));
  const cx = W / 2, cy = H / 2, Cx = outW / 2, Cy = outH / 2;
  return { m: [s, 0, Cx - s * cx, 0, s, Cy - s * cy], outW, outH };
}
// rotation + scale about center; canvas = rotated bounding box (whole symbol stays visible)
function rotateScale(rotDeg, scale, W, H) {
  const a = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const outW = Math.ceil(Math.abs(cos) * W + Math.abs(sin) * H);
  const outH = Math.ceil(Math.abs(sin) * W + Math.abs(cos) * H);
  const cx = W / 2, cy = H / 2, Cx = outW / 2, Cy = outH / 2;
  const cs = cos * scale, sn = sin * scale;
  return { m: [cs, sn, Cx - cs * cx - sn * cy, -sn, cs, Cy + sn * cx - cs * cy], outW, outH };
}
// translation on an expanded canvas (like the symbol moving within the camera frame)
function shiftPad(tx, ty, W, H) {
  const outW = W + Math.abs(tx), outH = H + Math.abs(ty);
  return { m: [1, 0, Math.max(0, tx), 0, 1, Math.max(0, ty)], outW, outH };
}
function boxBlur(img, r) {
  const W = img.width, H = img.height;
  const s = img.data, out = new Uint8ClampedArray(s.length);
  const tmp = new Uint8ClampedArray(s.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a = [0, 0, 0], n = 0;
    for (let k = -r; k <= r; k++) {
      const xx = x + k; if (xx < 0 || xx >= W) continue;
      const o = (y * W + xx) * 4; a[0] += s[o]; a[1] += s[o + 1]; a[2] += s[o + 2]; n++;
    }
    const o = (y * W + x) * 4; tmp[o] = a[0] / n; tmp[o + 1] = a[1] / n; tmp[o + 2] = a[2] / n; tmp[o + 3] = 255;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a = [0, 0, 0], n = 0;
    for (let k = -r; k <= r; k++) {
      const yy = y + k; if (yy < 0 || yy >= H) continue;
      const o = (yy * W + x) * 4; a[0] += tmp[o]; a[1] += tmp[o + 1]; a[2] += tmp[o + 2]; n++;
    }
    const o = (y * W + x) * 4; out[o] = a[0] / n; out[o + 1] = a[1] / n; out[o + 2] = a[2] / n; out[o + 3] = 255;
  }
  return { data: out, width: W, height: H };
}
function adjust(img, mul, add) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = Math.max(0, Math.min(255, d[i] * mul + add));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] * mul + add));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] * mul + add));
  }
  return img;
}
// mild perspective: dst corners pulled inward by dx (whole symbol shrinks inside frame, no crop)
function perspective(img, dx) {
  const W = img.width, H = img.height;
  const src = img.data, out = new Uint8ClampedArray(W * H * 4);
  const S = [[0, 0], [W, 0], [W, H], [0, H]];
  const D = [[dx, dx * 0.6], [W - dx, dx * 0.6], [W - dx * 0.4, H - dx * 0.6], [dx * 0.4, H - dx * 0.6]];
  const h = solveH(D, S); // dst -> src
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const wgt = h[6] * x + h[7] * y + 1;
    const sx = (h[0] * x + h[1] * y + h[2]) / wgt;
    const sy = (h[3] * x + h[4] * y + h[5]) / wgt;
    const o = (y * W + x) * 4;
    if (sx < 0 || sy < 0 || sx >= W - 1 || sy >= H - 1) { out[o] = 255; out[o + 1] = 255; out[o + 2] = 255; out[o + 3] = 255; continue; }
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
    for (let ch = 0; ch < 3; ch++) {
      const p00 = src[(y0 * W + x0) * 4 + ch], p10 = src[(y0 * W + x0 + 1) * 4 + ch];
      const p01 = src[((y0 + 1) * W + x0) * 4 + ch], p11 = src[((y0 + 1) * W + x0 + 1) * 4 + ch];
      out[o + ch] = p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy;
    }
    out[o + 3] = 255;
  }
  return { data: out, width: W, height: H };
}
function solveH(S, D) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = S[i], [X, Y] = D[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  const n = 8, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]).concat(1);
}

// ---------- decode worker harness ----------
async function makeDecodeWorker() {
  const src = fs.readFileSync('worker_decode_color.js', 'utf8');
  const vm = require('vm');
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
  const mod = new vm.SourceTextModule(src, { context: sandbox, identifier: 'decode-worker.mjs' });
  await mod.link(() => { throw new Error('unexpected import'); });
  const evalPromise = mod.evaluate();
  await new Promise(r => setTimeout(r, 50));
  for (const fn of listeners.slice()) fn({ data: { type: 'wasm-assets', map: sandbox.WASM_MAP, debug: false } });
  await evalPromise;
  return {
    posted,
    dispatch: (msg) => { for (const fn of listeners.slice()) fn({ data: msg }); if (typeof sandbox.onmessage === 'function') sandbox.onmessage({ data: msg }); },
  };
}

async function main() {
  const cap = JSON.parse(fs.readFileSync('cdp_capture.json', 'utf8'));
  const base = decodePNG(cap.frames[0]);
  const rawText = ('CimQR-COLOR-E2E-验证|' + 'The quick brown fox jumps over the lazy dog. 0123456789 ').repeat(420);
  const expected = rawText.trim();
  const W = base.width, H = base.height;

  console.log('booting REAL decode worker once for all variants...');
  const w = await makeDecodeWorker();
  w.dispatch({ type: 'settings', settings: { binarizer: 'LocalAverage', maxSymbols: 'auto', tryDownscale: true, downscaleFactor: 3 }, fecCodec: 'auto' });

  const variants = [
    ['clean (as captured)', () => ({ ...base, data: new Uint8ClampedArray(base.data) })],
    ['rotate 2°', () => { const r = rotateScale(2, 1, W, H); return transformImage(base, r.m, r.outW, r.outH); }],
    ['rotate 5° + scale 0.8', () => { const r = rotateScale(5, 0.8, W, H); return transformImage(base, r.m, r.outW, r.outH); }],
    ['scale 0.7', () => { const r = scaleCenter(0.7, W, H); return transformImage(base, r.m, r.outW, r.outH); }],
    ['scale 1.25 (canvas 1360)', () => { const r = scaleCenter(1.25, W, H); return transformImage(base, r.m, r.outW, r.outH); }],
    ['shift +80,+60 (canvas 1168×1148)', () => { const r = shiftPad(80, 60, W, H); return transformImage(base, r.m, r.outW, r.outH); }],
    ['blur r=2', () => boxBlur({ ...base, data: new Uint8ClampedArray(base.data) }, 2)],
    ['blur r=3', () => boxBlur({ ...base, data: new Uint8ClampedArray(base.data) }, 3)],
    ['brightness ×0.7', () => adjust({ ...base, data: new Uint8ClampedArray(base.data) }, 0.7, 0)],
    ['brightness ×1.3 +20', () => adjust({ ...base, data: new Uint8ClampedArray(base.data) }, 1.3, 20)],
    ['perspective ~4% pull', () => perspective({ ...base, data: new Uint8ClampedArray(base.data) }, 45)],
  ];

  let pass = 0;
  const times = [];
  for (const [name, fn] of variants) {
    const img = fn();
    w.dispatch({ type: 'reset' });
    w.posted.length = 0;
    const t0 = Date.now();
    w.dispatch({ type: 'frame', pixels: img.data.buffer.slice(0), width: img.width, height: img.height, realtime: false });
    const result = await new Promise((resolve) => {
      const iv = setInterval(() => {
        const comp = w.posted.find(m => m.type === 'complete');
        if (comp) { clearInterval(iv); resolve(comp); return; }
        if (Date.now() - t0 > 90000) { clearInterval(iv); resolve(null); }
      }, 20);
    });
    const ms = Date.now() - t0;
    if (!result) { console.log('✗ ' + name + ' — 未解出（90s 超时）'); continue; }
    const ok = result.isText && result.text === expected;
    times.push(ms);
    if (ok) { pass++; console.log('✓ ' + name + ' — 文本精确还原 (' + ms + 'ms)'); }
    else console.log('△ ' + name + ' — complete 但内容不符 (' + ms + 'ms)');
  }
  console.log('\n容错结果: ' + pass + '/' + variants.length + ' 通过');
  if (times.length) console.log('平均 ' + (times.reduce((a, b) => a + b, 0) / times.length).toFixed(0) + 'ms/帧');
  process.exit(pass === variants.length ? 0 : 2);
}
if (require.main === module) main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
module.exports = { transformImage, scaleCenter, rotateScale, shiftPad, boxBlur, adjust, perspective, solveH, makeDecodeWorker, decodePNG: null };
