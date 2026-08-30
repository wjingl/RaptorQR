// Full end-to-end: PNG frames captured from the REAL browser app -> decode with the
// REAL patched decode worker (extracted from the shipped colorized HTML) + REAL RaptorQ WASM.
const fs = require('fs');
const zlib = require('zlib');
const vm = require('vm');

// ---------- minimal PNG decoder (8-bit, RGB/RGBA/palette, non-interlaced) ----------
function decodePNG(dataURL) {
  const raw = Buffer.from(dataURL.split(',')[1], 'base64');
  if (raw.readUInt32BE(0) !== 0x89504e47) throw new Error('not PNG');
  let pos = 8, w = 0, h = 0, colorType = 6;
  const idat = [];
  let palette = null;
  while (pos + 8 <= raw.length) {
    const len = raw.readUInt32BE(pos);
    const type = raw.toString('ascii', pos + 4, pos + 8);
    const data = raw.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error('bitDepth ' + data[8] + ' unsupported');
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 1;
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels, stride = w * bpp;
  const out = new Uint8ClampedArray(w * h * 4);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = inflated[p++];
    const line = Buffer.from(inflated.subarray(p, p + stride));
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      switch (filter) {
        case 1: line[x] = (line[x] + a) & 0xff; break;
        case 2: line[x] = (line[x] + b) & 0xff; break;
        case 3: line[x] = (line[x] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff; break;
        }
      }
    }
    prev = line;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (colorType === 6) { out[o] = line[x*4]; out[o+1] = line[x*4+1]; out[o+2] = line[x*4+2]; out[o+3] = line[x*4+3]; }
      else if (colorType === 2) { out[o] = line[x*3]; out[o+1] = line[x*3+1]; out[o+2] = line[x*3+2]; out[o+3] = 255; }
      else if (colorType === 0) { out[o] = out[o+1] = out[o+2] = line[x]; out[o+3] = 255; }
      else if (colorType === 3) { const idx = line[x]; out[o] = palette[idx*3]; out[o+1] = palette[idx*3+1]; out[o+2] = palette[idx*3+2]; out[o+3] = 255; }
    }
  }
  return { data: out, width: w, height: h };
}

// ---------- analyze a frame's structure ----------
function analyze(img) {
  const { data, width } = img;
  const pal = { green: 0, cyan: 0, yellow: 0, magenta: 0, black: 0, white: 0, other: 0 };
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if      (g > 200 && r < 90 && b < 90) pal.green++;
    else if (g > 200 && b > 200 && r < 90) pal.cyan++;
    else if (r > 200 && g > 200 && b < 90) pal.yellow++;
    else if (r > 200 && b > 200 && g < 90) pal.magenta++;
    else if (r < 40 && g < 40 && b < 40) pal.black++;
    else if (r > 215 && g > 215 && b > 215) pal.white++;
    else pal.other++;
  }
  // TL finder: sample along a line through its center (dark core -> light ring -> dark rim)
  const M = 32, CS = 9, fc = M + 3.5 * CS; // center of the 7-module finder
  const px = (x, y) => { const o = (Math.round(y) * width + Math.round(x)) * 4; return [data[o], data[o + 1], data[o + 2]]; };
  const lum = (x, y) => { const [r, g, b] = px(x, y); return 0.299 * r + 0.587 * g + 0.114 * b; };
  const finder = [];
  for (let k = 0; k < 15; k++) {
    const y = M + k * (4.5); // 0..63px = 7 modules across the finder vertically
    finder.push(lum(fc, y) > 128 ? 'L' : 'D');
  }
  return { pal, finderCross: finder.join('') };
}

// ---------- decode-worker harness ----------
async function makeDecodeWorker() {
  const src = fs.readFileSync('worker_decode_color.js', 'utf8');
  const wasmMapCode = fs.readFileSync('wasm_map_extracted.js', 'utf8');
  const listeners = [], posted = [];
  const sandbox = {
    postMessage: (msg, transfer) => posted.push(msg),
    addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); },
    ImageData: class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } },
    TextEncoder, TextDecoder, Uint8Array, Uint8ClampedArray, Uint32Array, Int32Array, Float64Array,
    ArrayBuffer, SharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined' ? SharedArrayBuffer : ArrayBuffer,
    DataView, Promise, Map, Set, BigInt, console, Math, Number, String, Object, Array, Date, Error,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    WebAssembly, FinalizationRegistry, Symbol, RangeError, TypeError, JSON, RegExp, URL, URLSearchParams,
    fetch: (u, o) => fetch(u, o),
    Response: typeof Response !== 'undefined' ? Response : undefined,
    Request: typeof Request !== 'undefined' ? Request : undefined,
    Headers: typeof Headers !== 'undefined' ? Headers : undefined,
    performance, crypto,
    location: { href: 'file:///worker.mjs' },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(wasmMapCode, sandbox);
  const WASM_MAP = sandbox.WASM_MAP;
  const mod = new vm.SourceTextModule(src, { context: sandbox, identifier: 'decode-worker.mjs' });
  await mod.link(() => { throw new Error('unexpected import'); });
  const evalPromise = mod.evaluate();
  await new Promise(r => setTimeout(r, 50));
  for (const fn of listeners.slice()) fn({ data: { type: 'wasm-assets', map: WASM_MAP, debug: false } });
  await evalPromise;
  return {
    posted,
    dispatch: (msg) => {
      for (const fn of listeners.slice()) fn({ data: msg });
      if (typeof sandbox.onmessage === 'function') sandbox.onmessage({ data: msg });
    },
  };
}

// ---------- main ----------
(async () => {
  const cap = JSON.parse(fs.readFileSync('cdp_capture.json', 'utf8'));
  console.log('captured frames:', cap.frames.length, '| app status:', cap.appStatus || '(n/a)');
  const img = decodePNG(cap.frames[0]);
  const info = analyze(img);
  console.log('frame:', info.size || (img.width + 'x' + img.height));
  console.log('palette counts:', JSON.stringify(info.pal));
  console.log('TL finder cross-section (expect D L DDD L D):', info.finderCross);

  console.log('\nbooting REAL patched decode worker (vm + real WASM_MAP)...');
  const w = await makeDecodeWorker();
  w.dispatch({ type: 'settings', settings: { binarizer: 'LocalAverage', maxSymbols: 'auto', tryDownscale: true, downscaleFactor: 3 }, fecCodec: 'auto' });

  // NOTE: the app trims text input before encoding (beautified_2.js: `const P = n.trim()`),
  // so the expected payload is the TRIMMED text.
  const rawText = ('CimQR-COLOR-E2E-验证|' + 'The quick brown fox jumps over the lazy dog. 0123456789 ').repeat(420);
  const expectedText = rawText.trim();

  const t0 = Date.now();
  w.dispatch({ type: 'frame', pixels: img.data.buffer.slice(0), width: img.width, height: img.height, realtime: false });
  const done = await new Promise((resolve, reject) => {
    const iv = setInterval(() => {
      const comp = w.posted.find(m => m.type === 'complete');
      if (comp) { clearInterval(iv); resolve(comp); return; }
      const err = w.posted.find(m => m.type === 'error');
      if (err && Date.now() - t0 > 5000) { clearInterval(iv); reject(new Error('worker error: ' + err.message)); }
      if (Date.now() - t0 > 120000) { clearInterval(iv); reject(new Error('timeout; msgs: ' + w.posted.map(m => m.type).join(','))); }
    }, 25);
  });
  const wall = Date.now() - t0;
  const prog = w.posted.filter(m => m.type === 'progress');
  if (prog.length) {
    const p = prog[prog.length - 1];
    console.log('progress: frames=' + p.totalFrames + ' uniquePackets=' + p.uniquePackets + ' solved=' + p.solvedGenerations + '/' + p.totalGenerations + ' accepted=' + p.acceptedPackets);
  }
  if (done.isText) {
    const ok = done.text === expectedText;
    if (!ok) {
      // find first divergence
      let d = -1;
      for (let i = 0; i < Math.min(done.text.length, expectedText.length); i++) {
        if (done.text[i] !== expectedText[i]) { d = i; break; }
      }
      console.log('first divergence at char', d, 'of', expectedText.length);
      if (d >= 0) {
        console.log('expected:', JSON.stringify(expectedText.slice(d - 20, d + 20)));
        console.log('recovered:', JSON.stringify(done.text.slice(d - 20, d + 20)));
      } else {
        console.log('recovered is a strict prefix of expected; missing tail:', JSON.stringify(expectedText.slice(done.text.length)));
      }
    }
    console.log('COMPLETE: isText, recovered ' + done.text.length + ' chars (expected ' + expectedText.length + ')');
    console.log('head:', JSON.stringify(done.text.slice(0, 64)));
    console.log('tail:', JSON.stringify(done.text.slice(-64)));
    console.log('wall time (worker cold start incl.):', wall, 'ms');
    console.log(ok ? '\n*** E2E PASS: 真实浏览器帧 -> 真实 decode worker -> 文本逐字节还原 ***' : '\n*** E2E TEXT MISMATCH ***');
    process.exit(ok ? 0 : 1);
  } else {
    console.log('COMPLETE: binary, ' + done.data.byteLength + ' bytes, filename:', done.filename);
    const ok = Buffer.from(done.data).toString('utf8') === expectedText;
    console.log(ok ? '\n*** E2E PASS (binary) ***' : '\n*** E2E BINARY MISMATCH ***');
    process.exit(ok ? 0 : 1);
  }
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
