// 真实相机模拟：对小网格（V10 24×24）彩色码施加真实相机退化组合
// （符号占比/失焦模糊/传感器噪声/自动曝光/白平衡偏移/手持旋转/透视），
// 逐级定位接收端解析断点：maybeColor 门控 → finder 检测 → 彩色解码 → 逐字节还原。
// 最后用"最接近真实拍摄"的退化组合生成 y4m，走接收端 UI 全链路验证。
// 运行：node test/camera_sim.js   （首次运行会从真实发送端捕获帧并存为 fixture）
const { spawn } = require('child_process');
console.error('[CAM] module loaded');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FIXTURE = __dirname + '/fixtures/camera_sim_frames.json';
const LOGF = path.join(ROOT, 'test', '.camera_sim.log');
function log(msg) {
  const line = '[' + new Date().toISOString().slice(11, 19) + '] ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOGF, line + '\n'); } catch (e) {}
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function httpGetJson(url) { return new Promise((res, rej) => { http.get(url, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej); }); }
function killProc(p) { try { require('child_process').spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {} }

// ---------- PNG decode ----------
const e2eSrc = fs.readFileSync(__dirname + '/test_browser_e2e.js', 'utf8');
eval(e2eSrc.match(/function decodePNG[\s\S]*?\n}\n/)[0]);

// ---------- 图像退化工具（自包含，不依赖浏览器） ----------
function gaussianBlur(img, sigma) {
  const W = img.width, H = img.height, s = img.data;
  const r = Math.max(1, Math.round(sigma * 2.2));
  const out = new Uint8ClampedArray(s.length), tmp = new Uint8ClampedArray(s.length);
  const k = []; let sum = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    for (let ch = 0; ch < 3; ch++) {
      let a = 0;
      for (let j = 0; j < k.length; j++) {
        const xx = x + j - r; if (xx < 0 || xx >= W) continue;
        a += s[(y * W + xx) * 4 + ch] * k[j];
      }
      tmp[(y * W + x) * 4 + ch] = a;
    }
    const o = (y * W + x) * 4; tmp[o + 3] = 255;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    for (let ch = 0; ch < 3; ch++) {
      let a = 0;
      for (let j = 0; j < k.length; j++) {
        const yy = y + j - r; if (yy < 0 || yy >= H) continue;
        a += tmp[(yy * W + x) * 4 + ch] * k[j];
      }
      out[(y * W + x) * 4 + ch] = a;
    }
    const o = (y * W + x) * 4; out[o + 3] = 255;
  }
  return { data: out, width: W, height: H };
}
// 固定伪随机数：同一退化场景在不同机器/运行间可复现，便于比较单码识别率。
let rngState = 0x4d595df4;
function seedRandom(seed) { rngState = (seed >>> 0) || 1; }
function rand() { rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0; return rngState / 0x100000000; }
function addNoise(img, amp) {
  const s = img.data, out = new Uint8ClampedArray(s.length);
  for (let i = 0; i < s.length; i += 4) {
    for (let ch = 0; ch < 3; ch++) {
      const n = (rand() * 2 - 1) * amp;
      out[i + ch] = Math.max(0, Math.min(255, s[i + ch] + n));
    }
    out[i + 3] = 255;
  }
  return { data: out, width: img.width, height: img.height };
}
function exposure(img, gain, bias) {
  const s = img.data, out = new Uint8ClampedArray(s.length);
  for (let i = 0; i < s.length; i += 4) {
    for (let ch = 0; ch < 3; ch++) out[i + ch] = Math.max(0, Math.min(255, s[i + ch] * gain + bias));
    out[i + 3] = 255;
  }
  return { data: out, width: img.width, height: img.height };
}
function localIllumination(img, ax, ay, centerGain) {
  const s = img.data, out = new Uint8ClampedArray(s.length), W = img.width, H = img.height;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const nx = x / Math.max(1, W - 1) - 0.5, ny = y / Math.max(1, H - 1) - 0.5;
    const gain = centerGain + ax * nx + ay * ny;
    const o = (y * W + x) * 4;
    for (let ch = 0; ch < 3; ch++) out[o + ch] = Math.max(0, Math.min(255, s[o + ch] * gain));
    out[o + 3] = 255;
  }
  return { data: out, width: W, height: H };
}
function glareSpot(img, cx, cy, rx, ry, strength) {
  const s = img.data, out = new Uint8ClampedArray(s), W = img.width, H = img.height;
  for (let y = Math.max(0, Math.floor(cy - ry)); y < Math.min(H, Math.ceil(cy + ry)); y++) for (let x = Math.max(0, Math.floor(cx - rx)); x < Math.min(W, Math.ceil(cx + rx)); x++) {
    const dx = (x - cx) / Math.max(1, rx), dy = (y - cy) / Math.max(1, ry), a = Math.max(0, 1 - dx * dx - dy * dy) * strength;
    if (a <= 0) continue;
    const o = (y * W + x) * 4;
    for (let ch = 0; ch < 3; ch++) out[o + ch] = Math.max(0, Math.min(255, s[o + ch] * (1 - a) + 255 * a));
  }
  return { data: out, width: W, height: H };
}
function whiteBalance(img, rAdd, gAdd, bAdd) {
  const s = img.data, out = new Uint8ClampedArray(s.length);
  for (let i = 0; i < s.length; i += 4) {
    out[i] = Math.max(0, Math.min(255, s[i] + rAdd));
    out[i + 1] = Math.max(0, Math.min(255, s[i + 1] + gAdd));
    out[i + 2] = Math.max(0, Math.min(255, s[i + 2] + bAdd));
    out[i + 3] = 255;
  }
  return { data: out, width: img.width, height: img.height };
}
// 符号缩小居中（模拟拍摄距离远：符号只占画面一部分，画布外扩不裁切）
function scaleCenter(s, W, H) {
  const outW = Math.round(W * Math.max(s, 1)), outH = Math.round(H * Math.max(s, 1));
  const cx = W / 2, cy = H / 2, Cx = outW / 2, Cy = outH / 2;
  return { m: [s, 0, Cx - s * cx, 0, s, Cy - s * cy], outW, outH };
}
// 双线性仿射变换（逆映射采样，越界填背景色）
function transformImage(img, m, outW, outH, bgRGB) {
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
// 整帧降采样（模拟相机离得远/分辨率低：符号在帧内整体变小）
function downsample(img, factor) {
  const W = Math.round(img.width / factor), H = Math.round(img.height / factor);
  const s = img.data, out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx0 = Math.floor(x * factor), sy0 = Math.floor(y * factor);
    const sx1 = Math.min(img.width - 1, Math.ceil((x + 1) * factor));
    const sy1 = Math.min(img.height - 1, Math.ceil((y + 1) * factor));
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) {
      const o = (yy * img.width + xx) * 4;
      r += s[o]; g += s[o + 1]; b += s[o + 2]; n++;
    }
    const o = (y * W + x) * 4;
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
  }
  return { data: out, width: W, height: H };
}
// 旋转（画布为旋转外接框，符号完整可见）
function rotateScale(rotDeg, scale, W, H) {
  const a = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const outW = Math.ceil(Math.abs(cos) * W + Math.abs(sin) * H);
  const outH = Math.ceil(Math.abs(sin) * W + Math.abs(cos) * H);
  const cx = W / 2, cy = H / 2, Cx = outW / 2, Cy = outH / 2;
  const cs = cos * scale, sn = sin * scale;
  return { m: [cs, sn, Cx - cs * cx - sn * cy, -sn, cs, Cy + sn * cx - cs * cy], outW, outH };
}
// 透视（4 角向中心/一侧拉）
function perspective(img, pull) {
  const W = img.width, H = img.height;
  const s = img.data, out = new Uint8ClampedArray(W * H * 4);
  const dx = pull;
  const dst = [0, 0, W - 1, 0, W - 1, H - 1, 0, H - 1];
  const src = [dx, 0, W - 1 - dx, 0, W - 1, H - 1, dx, H - 1];
  // 解 8 参数投影（简化：仿射不够，用双线性插值直接对每个输出像素求原坐标）
  const A = [
    [src[0], src[1], 1, 0, 0, 0, -dst[0] * src[0], -dst[0] * src[1]],
    [0, 0, 0, src[0], src[1], 1, -dst[1] * src[0], -dst[1] * src[1]],
    [src[2], src[3], 1, 0, 0, 0, -dst[2] * src[2], -dst[2] * src[3]],
    [0, 0, 0, src[2], src[3], 1, -dst[3] * src[2], -dst[3] * src[3]],
    [src[4], src[5], 1, 0, 0, 0, -dst[4] * src[4], -dst[4] * src[5]],
    [0, 0, 0, src[4], src[5], 1, -dst[5] * src[4], -dst[5] * src[5]],
    [src[6], src[7], 1, 0, 0, 0, -dst[6] * src[6], -dst[6] * src[7]],
    [0, 0, 0, src[6], src[7], 1, -dst[7] * src[6], -dst[7] * src[7]],
  ];
  const b = [dst[0], dst[1], dst[2], dst[3], dst[4], dst[5], dst[6], dst[7]];
  const M = gaussElim(A, b);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const den = M[6] * x + M[7] * y + 1;
      const sx = (M[0] * x + M[1] * y + M[2]) / den;
      const sy = (M[3] * x + M[4] * y + M[5]) / den;
      const o = (y * W + x) * 4;
      if (sx < 0 || sy < 0 || sx >= W - 1 || sy >= H - 1) { out[o] = 255; out[o + 1] = 255; out[o + 2] = 255; out[o + 3] = 255; continue; }
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      for (let ch = 0; ch < 3; ch++) {
        const p00 = s[(y0 * W + x0) * 4 + ch], p10 = s[(y0 * W + x0 + 1) * 4 + ch];
        const p01 = s[((y0 + 1) * W + x0) * 4 + ch], p11 = s[((y0 + 1) * W + x0 + 1) * 4 + ch];
        out[o + ch] = p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width: W, height: H };
}
function gaussElim(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
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
  return M.map((row, i) => row[n] / row[i]);
}

// ---------- 发送端帧捕获（真实浏览器，复用 UI E2E 驱动） ----------
const PAYLOAD = 'RaptorQR-CAM-SIM-SMALL-GRID-0123456789-|'.repeat(9); // 6 包 → 6 帧循环
async function launchEdge(url) {
  console.error('[CAM] launchEdge start');
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'edge_cam_'));
  console.error('[CAM] prof=' + prof);
  let port = 0, proc = null;
  for (let attempt = 0; attempt < 10 && !proc; attempt++) {
    port = 9300 + Math.floor(Math.random() * 300);
    let busy = false;
    try { await httpGetJson('http://127.0.0.1:' + port + '/json/version'); busy = true; } catch (e) {}
    if (busy) continue;
    console.error('[CAM] spawning on port ' + port);
    proc = spawn(EDGE, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-sync', '--disable-background-networking', '--disable-component-update',
      '--force-device-scale-factor=1',
      '--remote-debugging-port=' + port, '--user-data-dir=' + prof,
      '--allow-file-access-from-files', url
    ], { stdio: 'ignore' });
  }
  if (!proc) throw new Error('no free CDP port');
  let targets = null;
  for (let i = 0; i < 80; i++) { await sleep(300); try { targets = await httpGetJson('http://127.0.0.1:' + port + '/json'); if (targets && targets.length) break; } catch (e) {} }
  console.error('[CAM] cdp up, page=' + (targets||[]).map(t=>t.type).join(','));
  const page = targets.find(t => t.type === 'page' && t.url.includes('file://'));
  if (!page) throw new Error('no file:// page: ' + (targets || []).map(t => t.type + ':' + t.url.slice(0, 40)).join(' | '));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let mid = 0; const pending = new Map();
  ws.onclose = ev => { for (const [, rej] of pending) rej(new Error('CDP closed (code ' + ev.code + ')')); pending.clear(); };
  ws.onerror = ev => console.error('[CAM] ws error: ' + (ev.message || '?'));
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise((res, rej) => { const id = ++mid; pending.set(id, m => { if (m.error) { rej(new Error(JSON.stringify(m.error))); return; } if (m.result === undefined) { console.error('[CAM] no-result msg for ' + method + ': ' + JSON.stringify(m).slice(0, 300)); rej(new Error('no result for ' + method)); return; } res(m.result); }); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  await send('Runtime.enable');
  console.error('[CAM] runtime enabled');
  return { proc, send };
}
async function evalPage(send, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 120000 });
  if (!r || r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails && (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text) || 'no result'));
  return r.result.value;
}
async function captureFrames() {
  if (fs.existsSync(FIXTURE)) {
    const j = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    log('reuse fixture: ' + j.frames.length + ' frames');
    return j;
  }
  const url = 'file:///' + path.join(ROOT, 'RaptorQR_彩色版.html').replace(/\\/g, '/');
  const { proc, send } = await launchEdge(url);
  try {
    const res = await evalPage(send, `(async () => {
      const log = [];
      function findBtn(t){ const b = document.querySelectorAll('button'); for (const x of b) if (x.textContent.trim().startsWith(t)) return x; return null; }
      function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
      function setSelect(pred, val){ for (const s of document.querySelectorAll('select')) if (pred(s)) { s.value = val; s.dispatchEvent(new Event('change', { bubbles: true })); return true; } return false; }
      const t0 = Date.now();
      while (!findBtn('Start Live QR')) {
        if (Date.now() - t0 > 40000) return { ok:false, log: log.concat(['no Start Live QR; buttons=' + Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim().slice(0, 12)).join(',') + '; title=' + document.title + '; body=' + document.body.innerText.slice(0, 120).replace(/\\n/g, '|')]) };
        await sleep(300);
      }
      log.push('app ready');
      findBtn('Text').click(); await sleep(200);
      const ta = document.querySelector('textarea');
      if (!ta) return { ok:false, log: log.concat(['no textarea']) };
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(PAYLOAD)});
      ta.dispatchEvent(new Event('input', { bubbles: true })); await sleep(200);
      const adv = findBtn('Advanced settings'); if (adv) adv.click();
      await sleep(300);
      const colorSet = setSelect(s => Array.from(s.options).some(o => o.value === 'color-cimbar'), 'color-cimbar');
      log.push('colorSel=' + colorSet);
      await sleep(300);
      const verSel = Array.from(document.querySelectorAll('select')).find(s => Array.from(s.options).some(o => o.value === '10'));
      if (verSel) { verSel.value = '10'; verSel.dispatchEvent(new Event('change', { bubbles: true })); log.push('V10'); }
      else log.push('no V10 select');
      await sleep(400);
      findBtn('Start Live QR').click();
      let cv = null; const t1 = Date.now();
      while (!cv && Date.now() - t1 < 30000) { await sleep(300); cv = document.querySelector('canvas.qr-live-canvas'); }
      if (!cv) return { ok:false, log: log.concat(['live canvas missing; status=' + (document.body.innerText.match(/Live QR[^\\n]*/) || [''])[0]]) };
      log.push('canvas ' + cv.width + 'x' + cv.height);
      return { ok:true, log, w: 1088, h: 1088 };
    })()`);
    if (!res.ok) throw new Error('sender setup failed: ' + JSON.stringify(res).slice(0, 300));
    const frames = [];
    for (let start = 0; start < 120; start += 30) {
      const cap = await evalPage(send, `(async () => {
        const cv = document.querySelector('canvas.qr-live-canvas');
        if (!cv) return { ok:false };
        const oc = document.createElement('canvas'); oc.width = 1088; oc.height = 1088;
        const ocx = oc.getContext('2d');
        const f = [];
        for (let i = 0; i < 30; i++) {
          ocx.drawImage(cv, 0, 0, oc.width, oc.height);
          f.push(oc.toDataURL('image/png'));
          await new Promise(r => setTimeout(r, 60));
        }
        return { ok:true, frames: f };
      })()`);
      if (!cap.ok) throw new Error('capture batch failed');
      frames.push(...cap.frames);
      log('captured ' + frames.length + '/120');
      await sleep(800);
    }
    const out = { w: res.w, h: res.h, frames };
    fs.writeFileSync(FIXTURE, JSON.stringify(out));
    log('captured ' + frames.length + ' frames @' + res.w + 'x' + res.h);
    return out;
  } finally { killProc(proc); }
}

// ---------- decode worker（vm 沙箱，出货产物） ----------
async function makeDecodeWorker() {
  const vm = require('vm');
  const src = fs.readFileSync(__dirname + '/fixtures/check_decode.mjs', 'utf8');
  const wasmMapCode = fs.readFileSync(__dirname + '/fixtures/wasm_map_extracted.js', 'utf8');
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

// ---------- 阶段分析：maybeColor / finder 检测（直接调 codec） ----------
function frameHasSignal(img) {
  const d = img.data, step = Math.max(8, Math.floor(Math.max(img.width, img.height) / 96));
  let signal = 0;
  for (let y = 0; y < img.height; y += step) for (let x = 0; x < img.width; x += step) {
    const o = (y * img.width + x) * 4, r = d[o], g = d[o + 1], b = d[o + 2];
    if (Math.min(r, g, b) < 238 || Math.max(r, g, b) - Math.min(r, g, b) > 18) signal++;
  }
  return signal >= 12;
}
function stageAnalysis(img) {
  const codec = require(path.join(ROOT, 'cimqr_codec.js'));
  const maybeColor = codec.maybeColor(img.data, img.width, img.height);
  const det = codec._detect(img.data, img.width, img.height);
  const packets = codec.decode(img.data, img.width, img.height) || [];
  const info = typeof codec.info === 'function' ? codec.info() : {};
  let stage = info.stage || 'unknown';
  if (packets.length) stage = 'single-code-ok';
  else if (det.sel && det.cands.length >= 3) stage = 'single-code-sampling';
  else if (det.cands.length >= 3) stage = 'located';
  else if (maybeColor) stage = 'no-anchor';
  else stage = 'no-color-signal';
  return {
    maybeColor,
    finders: det.cands.length,
    selected: det.sel ? 3 : 0,
    packets: packets.length,
    stage,
    info,
    sizes: packets.map(p => p && p.meta && p.meta.size).filter(Boolean).join(','),
  };
}

// ---------- 主流程 ----------
if (require.main === module) (async () => {
  console.error('[CAM] IIFE start');
  const codec = require(path.join(ROOT, 'cimqr_codec.js'));
  console.error('[CAM] codec loaded');
  const cap = await captureFrames();
  const base = decodePNG(cap.frames[0]);
  log('base frame ' + base.width + 'x' + base.height);
  const W = base.width, H = base.height;

  // 去重：按粗哈希找出循环中的不同帧
  const distinct = [];
  const seen = new Set();
  for (const dataURL of cap.frames) {
    const img = decodePNG(dataURL);
    let h = 0;
    for (let y = 0; y < img.height; y += 32) for (let x = 0; x < img.width; x += 32) {
      const o = (y * img.width + x) * 4;
      h = ((h * 31) + ((img.data[o] >> 4) & 3) + ((img.data[o + 1] >> 4) & 3) * 3 + ((img.data[o + 2] >> 4) & 3) * 9) >>> 0;
    }
    if (!seen.has(h)) { seen.add(h); distinct.push({ img, h }); }
    if (distinct.length >= 12) break;
  }
  log('distinct frames: ' + distinct.length);

  // 现实拍屏基线：11 项均为轻度、可工作的手机场景；每项固定 seed，结果可复现。
  // 重度模糊/强噪声/50%远景不在这里验收，单独由 camera_stress.js 负责。
  const combos = [
    { id: 'B01', name: '正对屏幕·正常光', class: 'realistic', acceptance: 'must_pass', seed: 101, fn: i => ({ img: distinct[i].img, note: '数字对照组（synthetic-camera）' }) },
    { id: 'B02', name: '符号占80%', class: 'realistic', acceptance: 'must_pass', seed: 102, fn: i => { const s = scaleCenter(0.8, W, H); return { img: transformImage(distinct[i].img, s.m, s.outW, s.outH, [240, 240, 240]), note: '正常距离' }; } },
    { id: 'B03', name: '符号占70%', class: 'realistic', acceptance: 'must_pass', seed: 103, fn: i => { const s = scaleCenter(0.7, W, H); return { img: transformImage(distinct[i].img, s.m, s.outW, s.outH, [240, 240, 240]), note: '稍远距离' }; } },
    { id: 'B04', name: '低分辨率·占60%', class: 'realistic', acceptance: 'must_pass', seed: 104, fn: i => { const s = scaleCenter(0.6, W, H); let im = transformImage(distinct[i].img, s.m, s.outW, s.outH, [240, 240, 240]); return { img: downsample(im, 1.25), note: '低分辨率/数字变焦' }; } },
    { id: 'B05', name: '偏移构图', class: 'realistic', acceptance: 'must_pass', seed: 105, fn: i => { const s = scaleCenter(0.7, W, H); const m = s.m.slice(); m[2] += 70; m[5] -= 45; return { img: transformImage(distinct[i].img, m, s.outW, s.outH, [240, 240, 240]), note: '码不居中' }; } },
    { id: 'B06', name: '手持旋转3°', class: 'realistic', acceptance: 'must_pass', seed: 106, fn: i => { const r = rotateScale(3, 0.7, W, H); return { img: transformImage(distinct[i].img, r.m, r.outW, r.outH, [240, 240, 240]), note: '轻微歪斜' }; } },
    { id: 'B07', name: '轻度斜拍·1.5%', class: 'realistic', acceptance: 'must_pass', seed: 107, fn: i => { const s = scaleCenter(0.7, W, H); let im = transformImage(distinct[i].img, s.m, s.outW, s.outH, [240, 240, 240]); im = perspective(im, Math.round(im.width * 0.015)); return { img: im, note: '轻度透视' }; } },
    { id: 'B08', name: '轻度失焦', class: 'realistic', acceptance: 'must_pass', seed: 108, fn: i => { const s = scaleCenter(0.7, W, H); let im = transformImage(distinct[i].img, s.m, s.outW, s.outH, [240, 240, 240]); return { img: gaussianBlur(im, 0.4), note: '轻度失焦（σ0.4，手机可工作范围）' }; } },
    { id: 'B09', name: '低照度噪声', class: 'realistic', acceptance: 'must_pass', seed: 109, fn: i => { const s = scaleCenter(0.7, W, H); let im = transformImage(distinct[i].img, s.m, s.outW, s.outH, [240, 240, 240]); im = exposure(im, 0.75, 0); im = addNoise(im, 12); return { img: im, note: '低照度传感器噪声' }; } },
    { id: 'B10', name: '暖光·欠曝·渐变', class: 'realistic', acceptance: 'must_pass', seed: 110, fn: i => { const s = scaleCenter(0.7, W, H); let im = transformImage(distinct[i].img, s.m, s.outW, s.outH, [240, 240, 240]); im = whiteBalance(im, 20, 8, -18); im = exposure(im, 0.85, 0); im = localIllumination(im, 0.16, -0.10, 1); return { img: im, note: '暖光与屏幕亮度不均' }; } },
    { id: 'B11', name: '综合手持·轻反光', class: 'realistic', acceptance: 'must_pass', seed: 111, fn: i => { const r = rotateScale(2.5, 0.7, W, H); let im = transformImage(distinct[i].img, r.m, r.outW, r.outH, [240, 240, 240]); im = localIllumination(im, 0.12, 0.08, 1); im = glareSpot(im, im.width * 0.64, im.height * 0.40, im.width * 0.12, im.height * 0.07, 0.30); im = whiteBalance(im, 14, 5, -12); im = gaussianBlur(im, 0.8); im = addNoise(im, 10); return { img: im, note: '轻微反光/光照不均/手持' }; } },
  ];

  log('boot decode worker…');
  const w = await makeDecodeWorker();
  w.dispatch({ type: 'settings', settings: { binarizer: 'LocalAverage', maxSymbols: 'auto', tryDownscale: true, downscaleFactor: 3 }, fecCodec: 'auto' });

  const results = [];
  for (const combo of combos) {
    const { id, name, seed, fn } = combo;
    seedRandom(seed);
    // 阶段分析（第一帧）
    // 选择第一张真正含结构/颜色信号的帧作为阶段代表，避免启动空白帧污染诊断。
    let representative = 0;
    for (let ri = 0; ri < distinct.length; ri++) { const probe = fn(ri); if (frameHasSignal(probe.img)) { representative = ri; break; } }
    const s0 = fn(representative);
    const st = stageAnalysis(s0.img);
    // worker 全循环：每帧投 2 遍（模拟播放循环重复）
    w.dispatch({ type: 'reset' });
    w.posted.length = 0;
    const t0 = Date.now();
    for (let rep = 0; rep < 2; rep++) {
      for (let i = 0; i < distinct.length; i++) {
        const s = fn(i);
        // 采集层只筛掉真正的空白帧；有信号的帧全部交给 worker，颜色门控不能决定
        // 是否尝试 CimQR，否则暗光/失焦彩色帧会在解析前被旁路。
        if (!frameHasSignal(s.img)) continue;
        w.dispatch({ type: 'frame', pixels: s.img.data.buffer.slice(0), width: s.img.width, height: s.img.height, realtime: false });
      }
    }
    const result = await new Promise((resolve) => {
      const iv = setInterval(() => {
        const comp = w.posted.find(m => m.type === 'complete');
        if (comp) { clearInterval(iv); resolve(comp); return; }
        if (Date.now() - t0 > 180000) { clearInterval(iv); resolve(null); }
      }, 20);
    });
    const ms = Date.now() - t0;
    const prog = w.posted.filter(m => m.type === 'progress').pop() || {};
    const codeEvents = w.posted.filter(m => m.type === 'single-code');
    const lastCode = codeEvents.length ? codeEvents[codeEvents.length - 1] : null;
    const ok = result && result.isText && result.text === PAYLOAD;
    const unique = prog.uniquePackets ?? 0, needed = prog.neededPackets ?? 0;
    const failureStage = ok ? 'complete' : (unique > 0 ? 'fec-collecting' : (lastCode?.info?.stage || st.stage));
    const codeInfo = lastCode?.info || st.info || {};
    results.push({ id, name, class: combo.class, acceptance: combo.acceptance, seed, note: s0.note, ok, stage: failureStage, codeType: lastCode?.color ? 'color-cimbar' : (codeInfo.format === 'qr-standard' ? 'qr-standard' : 'unknown'), maybeColor: st.maybeColor, finders: st.finders, selected: st.selected, packets: st.packets, grid: codeInfo.grid || null, symbolSize: codeInfo.symbolSize || null, informationDensity: codeInfo.informationDensity || null, timingScore: codeInfo.timingScore ?? null, info: codeInfo, framesWithQR: prog.framesWithQR ?? 0, unique, accepted: prog.acceptedPackets ?? 0, needed });
    log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + id + ' ' + name + ' — ' + s0.note + ' | type=' + (lastCode?.color ? 'color-cimbar' : 'qr-standard/unknown') + ' stage=' + failureStage + ' grid=' + (codeInfo.grid || '?') + 'px=' + (codeInfo.symbolSize || '?') + ' B/码=' + (codeInfo.informationDensity || '?') + ' timing=' + (codeInfo.timingScore ?? '?') + ' anchors=' + (codeInfo.finderCount ?? st.finders) + ' symbols=' + (codeInfo.symbolsPerFrame ?? codeInfo.symbols ?? 0) + ' unique=' + unique + '/' + (needed || '?') + ' ' + ms + 'ms');
  }

  log('===== SUMMARY =====');
  for (const r of results) log(JSON.stringify(r));
  const pass = results.filter(r => r.ok).length;
  log('现实基线通过 ' + pass + '/' + results.length);
  for (const r of results) log('阶段 ' + r.id + ': ' + r.stage + ' | anchors=' + r.finders + ' | packets=' + r.packets + ' | unique=' + r.unique + '/' + (r.needed || '?'));
  // synthetic-camera 现实基线必须全通过；压力边界由 camera_stress.js 单独验收。
  process.exitCode = pass === results.length ? 0 : 2;
})().catch(e => { log('FATAL: ' + (e && e.stack ? e.stack : e)); process.exitCode = 1; });

module.exports = { gaussianBlur, addNoise, exposure, whiteBalance, localIllumination, glareSpot, scaleCenter, transformImage, downsample, rotateScale, perspective, seedRandom, rand, frameHasSignal, stageAnalysis };
