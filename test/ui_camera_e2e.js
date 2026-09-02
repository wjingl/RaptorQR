// UI 级"真实相机"全链路：真实发送帧 → 相机退化（符号占比70%+轻微模糊+噪声+白平衡）→
// y4m 假摄像头 → 接收端 UI 相机扫描 → 逐字节还原（典型手持拍摄场景）。
// 运行：node test/ui_camera_e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FIXTURE = __dirname + '/fixtures/camera_sim_frames.json';
const LOGF = path.join(ROOT, 'test', '.ui_camera_e2e.log');
function log(msg) {
  const line = '[' + new Date().toISOString().slice(11, 19) + '] ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOGF, line + '\n'); } catch (e) {}
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function httpGetJson(url) { return new Promise((res, rej) => { http.get(url, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej); }); }
function killProc(p) { try { require('child_process').spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {} }

const e2eSrc = fs.readFileSync(__dirname + '/test_browser_e2e.js', 'utf8');
eval(e2eSrc.match(/function decodePNG[\s\S]*?\n}\n/)[0]);

// ---------- 退化工具 ----------
function gaussianBlur(img, sigma) {
  const W = img.width, H = img.height, r = Math.max(1, Math.round(sigma * 2.2));
  const s = img.data, out = new Uint8ClampedArray(s.length), tmp = new Uint8ClampedArray(s.length);
  const k = []; let sum = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    for (let ch = 0; ch < 3; ch++) { let a = 0; for (let j = 0; j < k.length; j++) { const xx = x + j - r; if (xx < 0 || xx >= W) continue; a += s[(y * W + xx) * 4 + ch] * k[j]; } tmp[(y * W + x) * 4 + ch] = a; }
    tmp[(y * W + x) * 4 + 3] = 255;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    for (let ch = 0; ch < 3; ch++) { let a = 0; for (let j = 0; j < k.length; j++) { const yy = y + j - r; if (yy < 0 || yy >= H) continue; a += tmp[(yy * W + x) * 4 + ch] * k[j]; } out[(y * W + x) * 4 + ch] = a; }
    out[(y * W + x) * 4 + 3] = 255;
  }
  return { data: out, width: W, height: H };
}
function addNoise(img, amp) {
  const s = img.data, out = new Uint8ClampedArray(s.length);
  for (let i = 0; i < s.length; i += 4) {
    for (let ch = 0; ch < 3; ch++) out[i + ch] = Math.max(0, Math.min(255, s[i + ch] + (Math.random() * 2 - 1) * amp));
    out[i + 3] = 255;
  }
  return { data: out, width: img.width, height: img.height };
}
function whiteBalance(img, rAdd, gAdd, bAdd) {
  const s = img.data, out = new Uint8ClampedArray(s.length);
  for (let i = 0; i < s.length; i += 4) {
    out[i] = Math.max(0, Math.min(255, s[i] + rAdd)); out[i + 1] = Math.max(0, Math.min(255, s[i + 1] + gAdd)); out[i + 2] = Math.max(0, Math.min(255, s[i + 2] + bAdd)); out[i + 3] = 255;
  }
  return { data: out, width: img.width, height: img.height };
}
function scaleCenter(s, W, H) {
  const outW = Math.round(W * Math.max(s, 1)), outH = Math.round(H * Math.max(s, 1));
  const cx = W / 2, cy = H / 2, Cx = outW / 2, Cy = outH / 2;
  return { m: [s, 0, Cx - s * cx, 0, s, Cy - s * cy], outW, outH };
}
function transformImage(img, m, outW, outH, bgRGB) {
  const W = img.width, H = img.height, s = img.data;
  const out = new Uint8ClampedArray(outW * outH * 4);
  const det = m[0] * m[4] - m[1] * m[3];
  const inv = [m[4] / det, -m[1] / det, (m[1] * m[5] - m[2] * m[4]) / det, -m[3] / det, m[0] / det, (m[2] * m[3] - m[0] * m[5]) / det];
  for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
    const sx = inv[0] * x + inv[1] * y + inv[2], sy = inv[3] * x + inv[4] * y + inv[5];
    const o = (y * outW + x) * 4;
    if (sx < 0 || sy < 0 || sx >= W - 1 || sy >= H - 1) { out[o] = bgRGB[0]; out[o + 1] = bgRGB[1]; out[o + 2] = bgRGB[2]; out[o + 3] = 255; continue; }
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
    for (let ch = 0; ch < 3; ch++) {
      const p00 = s[(y0 * W + x0) * 4 + ch], p10 = s[(y0 * W + x0 + 1) * 4 + ch];
      const p01 = s[((y0 + 1) * W + x0) * 4 + ch], p11 = s[((y0 + 1) * W + x0 + 1) * 4 + ch];
      out[o + ch] = p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy;
    }
    out[o + 3] = 255;
  }
  return { data: out, width: outW, height: outH };
}
// 手持典型：70% 占比 + 模糊1.2 + 噪声15 + 轻微白平衡（与 camera_sim 的"典型手持"一致但更轻）
function handHeld(img) {
  const sc = scaleCenter(0.7, img.width, img.height);
  let im = transformImage(img, sc.m, sc.outW, sc.outH, [240, 240, 240]);
  im = whiteBalance(im, 15, 5, -15);
  im = gaussianBlur(im, 1.2);
  im = addNoise(im, 15);
  return im;
}

// ---------- y4m ----------
function buildY4m(imgs, w, h, fps) {
  fps = fps || 30;
  const y4mHeader = 'YUV4MPEG2 W' + w + ' H' + h + ' F' + fps + ':1 Ip A1:1 C420\n';
  const yuv = Buffer.alloc(w * h * 3 / 2);
  const U0 = w * h, V0 = w * h * 5 / 4;
  const chunks = [Buffer.from(y4mHeader)];
  for (const img of imgs) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const r = img.data[o], g = img.data[o + 1], b = img.data[o + 2];
      yuv[y * w + x] = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
      if ((x & 1) === 0 && (y & 1) === 0) {
        const uo = U0 + (y >> 1) * (w >> 1) + (x >> 1), vo = V0 + (y >> 1) * (w >> 1) + (x >> 1);
        yuv[uo] = (-0.169 * r - 0.331 * g + 0.5 * b + 128) | 0;
        yuv[vo] = (0.5 * r - 0.419 * g - 0.081 * b + 128) | 0;
      }
    }
    chunks.push(Buffer.from('FRAME\n'), yuv);
  }
  return Buffer.concat(chunks);
}

// ---------- 接收端 UI ----------
async function launchEdge(url, extraArgs) {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'edge_uicam_'));
  let port = 0, proc = null;
  for (let attempt = 0; attempt < 10 && !proc; attempt++) {
    port = 9300 + Math.floor(Math.random() * 300);
    let busy = false;
    try { await httpGetJson('http://127.0.0.1:' + port + '/json/version'); busy = true; } catch (e) {}
    if (busy) continue;
    proc = require('child_process').spawn(EDGE, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-sync', '--force-device-scale-factor=1',
      '--remote-debugging-port=' + port, '--user-data-dir=' + prof,
      '--allow-file-access-from-files', ...extraArgs, url
    ], { stdio: 'ignore' });
  }
  if (!proc) throw new Error('no free CDP port');
  let targets = null;
  for (let i = 0; i < 80; i++) { await sleep(300); try { targets = await httpGetJson('http://127.0.0.1:' + port + '/json'); if (targets && targets.length) break; } catch (e) {} }
  const page = targets.find(t => t.type === 'page' && t.url.includes('file://'));
  if (!page) throw new Error('no file:// page: ' + (targets || []).map(t => t.type + ':' + t.url.slice(0, 40)).join(' | '));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let mid = 0; const pending = new Map();
  ws.onclose = () => { for (const [, rej] of pending) rej(new Error('CDP closed')); pending.clear(); };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise((res, rej) => { const id = ++mid; pending.set(id, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  await send('Runtime.enable');
  return { proc, send };
}
async function evalPage(send, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 120000 });
  if (!r || r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails && (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text) || 'no result'));
  return r.result.value;
}
async function runReceiver(url, y4mPath, expectedText) {
  const { proc, send } = await launchEdge(url, [
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--use-file-for-fake-video-capture=' + y4mPath.replace(/\\/g, '/'),
    '--autoplay-policy=no-user-gesture-required'
  ]);
  try {
    const t0 = Date.now();
    let started = false;
    // 等待页面就绪（body 渲染）
    for (let i = 0; i < 20; i++) {
      const ready = await evalPage(send, `(() => !!document.body && document.body.innerText.length > 0)()`);
      if (ready) break;
      await sleep(300);
    }
    let sawVideo = false;
    while (Date.now() - t0 < 60000) {
      const st = await evalPage(send, `(() => {
        const t = document.body.innerText;
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().startsWith('▶'));
        const ta = document.querySelector('textarea');
        const v = document.querySelector('video');
        return {
          hasStart: !!btn,
          recText: ta ? ta.value.slice(0, 200) : '',
          recSection: t.indexOf('已恢复文本') >= 0 || t.indexOf('Recovered Text') >= 0,
          status: (t.match(/Scanning…|Complete ✓|Camera error[^\\n]*|⚠[^\\n]*/) || [''])[0],
          vw: v ? v.videoWidth : -1,
          hasSrc: v ? !!v.srcObject : false
        };
      })()`);
      if (!started && st.hasStart) {
        const clicked = await evalPage(send, `(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().startsWith('▶')); if (b) { b.click(); return true; } return false; })()`);
        started = clicked;
        log('[receiver] click attempt: ' + clicked);
      }
      if (st.vw > 0 && st.hasSrc) sawVideo = true;
      if (!started || st.vw > 0 || st.recText) log('[receiver] t=' + (Date.now() - t0) + 'ms started=' + started + ' vw=' + st.vw + ' src=' + st.hasSrc + ' status=' + (st.status || '-'));
      if (st.recSection && st.recText) {
        const full = await evalPage(send, `(() => { const ta = document.querySelector('textarea'); return ta ? ta.value : ''; })()`);
        const ok = full === expectedText;
        log('[receiver] recovered=' + ok + ' textMatch=' + ok + ' len=' + full.length + ' in ' + (Date.now() - t0) + 'ms');
        return { ok, recovered: true, textMatch: ok };
      }
      if (st.status.indexOf('Camera error') >= 0) { log('[receiver] camera error: ' + st.status); return { ok: false, recovered: false, err: st.status }; }
      if (st.vw > 0 || !started) log('[receiver] t=' + (Date.now()-t0) + 'ms started=' + started + ' hasStart=' + st.hasStart + ' video=' + st.vw + ' status=' + (st.status||'-') + ' rec=' + st.recText.slice(0,20));
      await sleep(200);
    }
    log('[receiver] timeout 60s, no recovery; capture=' + (sawVideo ? 'ready' : 'no-frame'));
    return { ok: false, recovered: false, capture: sawVideo ? 'ready' : 'no-frame' };
  } finally { killProc(proc); }
}

// ---------- main ----------
async function warmUpFakeVideo() {
  // Edge fake video capture 首个实例可能拿不到视频流（headless 环境怪癖，非产品问题）；
  // 预热一个实例后立即终止，让后续实例稳定。
  try {
    const { proc } = await launchEdge('file:///W:/0_proj/QR_tran/send_manager/receiver/out/real.html', [
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--use-file-for-fake-video-capture=' + path.join(os.tmpdir(), 'ui_camera_e2e.y4m').replace(/\\/g, '/'),
      '--autoplay-policy=no-user-gesture-required'
    ]);
    await sleep(3000);
    killProc(proc);
    log('[warmup] done');
  } catch (e) { log('[warmup] skipped: ' + e.message); }
}
(async () => {
  const j = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  // 用非空帧构建退化视频：帧1、帧3 交替 ×4（模拟播放循环）
  const frames = [1, 3];
  const deg = frames.map(idx => handHeld(decodePNG(j.frames[idx])));
  const w = deg[0].width, h = deg[0].height;
  log('退化帧: ' + w + 'x' + h + '（70% 占比+白平衡偏暖+模糊1.2+噪声15）');
  const imgs = [];  for (let rep = 0; rep < 75; rep++) for (const d of deg) imgs.push(d);
  const y4m = buildY4m(imgs, w, h, 10); // 10fps → 150帧=15s 播放窗口，覆盖慢启动
  const y4mPath = path.join(os.tmpdir(), 'ui_camera_e2e.y4m');
  fs.writeFileSync(y4mPath, y4m);
  log('[y4m] ' + (y4m.length / 1048576).toFixed(1) + 'MB, ' + imgs.length + ' frames @10fps=' + (imgs.length / 10).toFixed(1) + 's');

  const expected = 'RaptorQR-CAM-SIM-SMALL-GRID-0123456789-|'.repeat(9);
  await warmUpFakeVideo();
  for (const recv of [
    { name: 'release.html (发布接收端)', url: 'file:///' + path.join(ROOT, 'send_manager', 'receiver', 'out', 'release.html').replace(/\\/g, '/') },
    { name: 'real.html (真实接收端)', url: 'file:///' + path.join(ROOT, 'send_manager', 'receiver', 'out', 'real.html').replace(/\\/g, '/') },
  ]) {
    log('===== ' + recv.name + ' =====');
    const r = await runReceiver(recv.url, y4mPath, expected);
    log('[receiver] ' + recv.name + ' → ok=' + r.ok + ' recovered=' + r.recovered + (r.err ? ' err=' + r.err : ''));
    if (!r.ok) process.exitCode = 1;
  }
  log('===== DONE =====');
})().catch(e => { log('FATAL: ' + (e && e.stack ? e.stack : e)); process.exitCode = 1; });
