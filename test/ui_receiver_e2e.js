// UI 级接收端全链路 E2E：真实浏览器发送端播放彩色 CimQR → 捕获真实帧 → y4m 假摄像头
// → 真实接收端 UI（#receiver / real.html）相机扫描 → 验证统计栏与数据还原。
// 覆盖用户反馈的关键场景：小规模彩色（V10 24×24 单帧 与 多帧播放循环）。
// 运行：node test/ui_receiver_e2e.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.resolve(__dirname, '..');
const SENDER_HTML = 'file:///' + path.join(ROOT, 'RaptorQR_彩色版.html').replace(/\\/g, '/');
const RECEIVER_REAL = 'file:///' + path.join(ROOT, 'send_manager', 'receiver', 'out', 'real.html').replace(/\\/g, '/');
const RECEIVER_DEPLOYED = SENDER_HTML + '#receiver';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}
function killProc(p) { try { require('child_process').spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {} }

async function launchEdge(extraArgs, url) {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'edge_ui_'));
  // 选一个未被残留进程占用的 CDP 端口
  let port = 0, proc = null;
  for (let attempt = 0; attempt < 10 && !proc; attempt++) {
    port = 9300 + Math.floor(Math.random() * 300);
    let busy = false;
    try { await httpGetJson('http://127.0.0.1:' + port + '/json/version'); busy = true; } catch (e) {}
    if (busy) continue;
    proc = spawn(EDGE, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--force-device-scale-factor=1',
      '--remote-debugging-port=' + port, '--user-data-dir=' + prof, '--window-size=1400,2400',
      '--allow-file-access-from-files', ...extraArgs, url
    ], { stdio: 'ignore' });
  }
  if (!proc) throw new Error('no free CDP port');
  let targets = null;
  for (let i = 0; i < 80; i++) {
    await sleep(300);
    try { targets = await httpGetJson('http://127.0.0.1:' + port + '/json'); if (targets && targets.length) break; } catch (e) {}
  }
  if (!targets) { killProc(proc); throw new Error('CDP never came up'); }
  const page = targets.find(t => t.type === 'page' && t.url.includes('file://'));
  if (!page) { killProc(proc); throw new Error('no page target: ' + targets.map(t => t.type + ':' + t.url).join(',')); }
  // 双重保险：页面 URL 必须是本次启动的目标（percent 解码后比较）
  const expectedFile = decodeURIComponent(url.split('#')[0].split('/').pop());
  if (!decodeURIComponent(page.url).includes(expectedFile)) { killProc(proc); throw new Error('port collision: got ' + page.url); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let mid = 0; const pending = new Map();
  ws.onclose = ev => {
    log('WS closed code=' + ev.code + ' (page ' + url.slice(0, 40) + ')');
    for (const [, rej] of pending) rej(new Error('CDP connection closed (code ' + ev.code + ')'));
    pending.clear();
  };
  ws.onerror = ev => log('WS error: ' + (ev.message || 'unknown'));
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Inspector.targetCrashed') log('PAGE CRASHED: ' + JSON.stringify(m.params).slice(0, 200));
    else if (m.method && !/^Network\.|^Log\.|^Runtime\.console/.test(m.method)) log('event: ' + m.method);
  };
  const send = (method, params) => new Promise((res, rej) => {
    const id = ++mid; pending.set(id, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result));
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  await send('Runtime.enable');
  return { proc, send, url, port };
}
async function evalPage(send, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 120000 });
  if (!r || r.exceptionDetails) throw new Error('eval failed: ' + (r && r.exceptionDetails && (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text) || 'no result'));
  return r.result.value;
}

// ---------- PNG decode (8-bit, non-interlaced) ----------
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not PNG');
  let pos = 8, w = 0, h = 0, colorType = 6;
  const idat = []; let palette = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos); const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 3;
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = new Uint8ClampedArray(w * h * 4);
  let prev = Buffer.alloc(stride); let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = inflated[p++];
    const line = Buffer.from(inflated.subarray(p, p + stride)); p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0, b = prev[x], c = x >= channels ? prev[x - channels] : 0;
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
    if (palette && (colorType === 3)) {
      for (let x = 0; x < w; x++) {
        const idx = line[x] * 4; const o = (y * w + x) * 4;
        out[o] = palette[idx]; out[o + 1] = palette[idx + 1]; out[o + 2] = palette[idx + 2]; out[o + 3] = 255;
      }
    } else {
      for (let x = 0; x < w; x++) {
        const s = x * channels, o = (y * w + x) * 4;
        out[o] = line[s]; out[o + 1] = channels > 1 ? line[s + 1] : line[s]; out[o + 2] = channels > 1 ? line[s + 2] : line[s]; out[o + 3] = channels > 3 ? line[s + 3] : 255;
      }
    }
    prev = line;
  }
  return { w, h, rgba: out };
}

// ---------- Part A: 发送端播放并捕获彩色帧 ----------
const SENDER_SETUP = (payload, version) => `(async () => {
  const log = [];
  function findBtn(t){ const b = document.querySelectorAll('button'); for (const x of b) if (x.textContent.trim().startsWith(t)) return x; return null; }
  function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
  function setSelect(pred, val){ for (const s of document.querySelectorAll('select')) if (pred(s)) { s.value = val; s.dispatchEvent(new Event('change', { bubbles: true })); return true; } return false; }
  const t0 = Date.now();
  while (!findBtn('Start Live QR')) { if (Date.now() - t0 > 30000) return { ok:false, log:['no app'] }; await sleep(300); }
  const tb = findBtn('Text'); if (tb) tb.click();
  await sleep(200);
  const ta = document.querySelector('textarea');
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  set.call(ta, ${JSON.stringify(payload)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(200);
  const adv = findBtn('Advanced settings'); if (adv) adv.click();
  await sleep(300);
  setSelect(s => Array.from(s.options).some(o => o.value === 'color-cimbar'), 'color-cimbar');
  await sleep(300);
  const verSel = Array.from(document.querySelectorAll('select')).find(s => Array.from(s.options).some(o => o.value === ${JSON.stringify(String(version))}));
  if (verSel) { verSel.value = ${JSON.stringify(String(version))}; verSel.dispatchEvent(new Event('change', { bubbles: true })); log.push('V' + ${JSON.stringify(String(version))} + ' selected'); }
  await sleep(400);
  let cap = '';
  for (const el of document.querySelectorAll('span')) { const t = el.textContent || ''; if (t.indexOf('B/') >= 0 && t.length < 40) { cap = t.trim(); break; } }
  log.push('容量: ' + cap);
  findBtn('Start Live QR').click();
  let cv = null;
  const t1 = Date.now();
  while (!cv && Date.now() - t1 < 30000) {
    await sleep(300);
    cv = document.querySelector('canvas.qr-live-canvas');
    if (cv) { const c = cv.getContext('2d'); const d = c.getImageData(0, 0, cv.width, cv.height).data; let pn = 0; for (let i = 3; i < d.length; i += 19973) if (d[i] > 0) pn++; if (pn < 100) cv = null; }
  }
  if (!cv) return { ok:false, log: log.concat(['live canvas missing']) };
  log.push('canvas: ' + cv.width + 'x' + cv.height);
  return { ok:true, log, w: cv.width, h: cv.height };
})()`;
const SENDER_CAPTURE = (nFrames, intervalMs) => `(async () => {
  const cv = document.querySelector('canvas.qr-live-canvas');
  if (!cv) return { ok:false, err:'canvas gone' };
  // 2176×2176 直接 toDataURL 会压垮 headless 渲染器：先下采样到 1088（设计尺寸）再编码
  const oc = document.createElement('canvas');
  oc.width = 1088; oc.height = 1088;
  const ocx = oc.getContext('2d');
  const frames = [];
  for (let i = 0; i < ${nFrames}; i++) {
    ocx.drawImage(cv, 0, 0, oc.width, oc.height);
    frames.push(oc.toDataURL('image/png'));
    await new Promise(r => setTimeout(r, ${intervalMs}));
  }
  return { ok:true, frames, w: oc.width, h: oc.height };
})()`;

async function captureSenderFrames(payload, version, nFrames, intervalMs, batch) {
  const { proc, send, port } = await launchEdge([], SENDER_HTML);
  log('sender Edge up (port ' + port + ')');
  try {
    const res = await evalPage(send, SENDER_SETUP(payload, version));
    if (!res.ok) throw new Error('sender setup: ' + res.log.join(' | '));
    log('[sender] ' + res.log.join(' | '));
    // 分批捕获：连续 toDataURL 循环会压垮 headless 渲染器，批间留时间给 GC
    const frames = [];
    const bsz = batch || 30;
    for (let start = 0; start < nFrames; start += bsz) {
      const cap = await evalPage(send, SENDER_CAPTURE(Math.min(bsz, nFrames - start), intervalMs));
      if (!cap.ok) throw new Error('sender capture: ' + cap.err);
      frames.push(...cap.frames);
      log('[sender] captured ' + frames.length + '/' + nFrames);
      await sleep(800);
    }
    const last = await evalPage(send, `(() => { const cv = document.querySelector('canvas.qr-live-canvas'); return { ok: !!cv, w: cv ? 1088 : 0, h: cv ? 1088 : 0 }; })()`);
    return { ok: true, log: res.log, frames, w: last.w, h: last.h };
  } finally { killProc(proc); }
}

// ---------- Part B: PNG 帧序列 → y4m ----------
function buildY4m(frames, w, h, fps = 30) {
  const y4mHeader = `YUV4MPEG2 W${w} H${h} F${fps}:1 Ip A1:1 C420\n`;
  const yuv = Buffer.alloc(w * h * 3 / 2);
  const Y0 = 0, U0 = w * h, V0 = w * h * 5 / 4;
  const chunks = [Buffer.from(y4mHeader)];
  for (const dataURL of frames) {
    const { rgba } = decodePNG(Buffer.from(dataURL.split(',')[1], 'base64'));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
        yuv[Y0 + y * w + x] = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
        if ((x & 1) === 0 && (y & 1) === 0) {
          const uo = U0 + (y >> 1) * (w >> 1) + (x >> 1);
          const vo = V0 + (y >> 1) * (w >> 1) + (x >> 1);
          yuv[uo] = (-0.169 * r - 0.331 * g + 0.5 * b + 128) | 0;
          yuv[vo] = (0.5 * r - 0.419 * g - 0.081 * b + 128) | 0;
        }
      }
    }
    chunks.push(Buffer.from('FRAME\n'), yuv);
  }
  return Buffer.concat(chunks);
}

// ---------- Part C: 接收端 UI 扫描 ----------
async function runReceiver(url, y4mPath, pollMs, timeoutMs, expectedText) {
  const { proc, send, port } = await launchEdge([
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--use-file-for-fake-video-capture=' + y4mPath.replace(/\\/g, '/'),
    '--autoplay-policy=no-user-gesture-required'
  ], url);
  log('receiver Edge up (port ' + port + ')');
  try {
    const t0 = Date.now();
    let started = false;
    const timeline = [];
    while (Date.now() - t0 < timeoutMs) {
      const st = await evalPage(send, `(() => {
        const t = document.body.innerText;
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().startsWith('▶'));
        const vid = document.querySelector('video');
        const ta = document.querySelector('textarea');
        const m = {
          hasStart: !!btn,
          videoW: vid ? vid.videoWidth : 0,
          videoH: vid ? vid.videoHeight : 0,
          recText: ta ? ta.value.slice(0, 200) : '',
          recSection: t.indexOf('已恢复文本') >= 0 || t.indexOf('Recovered Text') >= 0,
          status: (t.match(/Scanning…|Complete ✓|Stopped|Camera error[^\\n]*|Worker error[^\\n]*|⚠[^\\n]*/) || [''])[0],
          stats: (t.match(/frames[\\s\\S]{0,300}/) || [''])[0].replace(/\\n+/g, ' ').slice(0, 300)
        };
        return m;
      })()`);
      if (!started && st.hasStart) {
        await evalPage(send, `(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().startsWith('▶')); if (b) b.click(); return true; })()`);
        started = true;
        log('[receiver] Start Scan clicked');
      }
      timeline.push(st);
      if (st.recSection && st.recText) break;
      if (st.status.indexOf('Camera error') >= 0) break;
      await sleep(pollMs);
    }
    const tail = timeline[timeline.length - 1] || {};
    let ok = false, textMatch = false;
    if (tail.recText) {
      const full = await evalPage(send, `(() => { const ta = document.querySelector('textarea'); return ta ? ta.value : ''; })()`);
      ok = true;
      textMatch = expectedText && full === expectedText;
      tail.recTextFull = full.slice(0, 100);
      tail.textMatch = textMatch;
    }
    return { url, started, timeline, ok, textMatch };
  } finally { killProc(proc); }
}

// ---------- main ----------
const LOGF = path.join(os.tmpdir(), 'ui_receiver_e2e.log');
function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOGF, line + '\n'); } catch (e) {}
}
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rqr_ui_'));
  const results = [];
  const cases = [
    { name: 'V10 小网格·单帧 (104B)', payload: 'RaptorQR-UI-E2E-SMALL-GRID-COLOR-0123456789-|'.repeat(1), version: 10, nFrames: 40, intervalMs: 80 },
    { name: 'V10 小网格·多帧循环 (6帧)', payload: 'RaptorQR-UI-E2E-MULTIFRAME-SMALL-GRID-0123456789-|'.repeat(9), version: 10, nFrames: 100, intervalMs: 80 },
  ];
  for (const c of cases) {
    log('===== ' + c.name + ' =====');
    try {
      const cap = await captureSenderFrames(c.payload, c.version, c.nFrames, c.intervalMs, 30);
      if (!cap.ok) { results.push({ name: c.name, ok: false, err: 'capture failed' }); continue; }
      const y4m = buildY4m(cap.frames, cap.w, cap.h);
      const y4mPath = path.join(tmp, c.name.replace(/[^\w]+/g, '_') + '.y4m');
      fs.writeFileSync(y4mPath, y4m);
      log('[y4m] ' + (y4m.length / 1048576).toFixed(1) + 'MB, ' + cap.frames.length + ' frames ' + cap.w + 'x' + cap.h + ' @30fps = ' + (cap.frames.length / 30).toFixed(1) + 's');

      for (const recv of [
        { name: 'real.html (接收端产物)', url: RECEIVER_REAL },
        { name: '部署版 #receiver', url: RECEIVER_DEPLOYED },
      ]) {
        log('[receiver] ' + recv.name + ' …');
        const r = await runReceiver(recv.url, y4mPath, 200, 30000, c.payload);
        const tail = r.timeline[r.timeline.length - 1] || {};
        const anyQR = r.timeline.some(s => /\bframes\s*[1-9]/.test(s.stats));
        const anyUnique = r.timeline.some(s => /unique\s*[1-9]/.test(s.stats));
        const ok = !!(r.ok && r.textMatch);
        log('[receiver] anyQR=' + anyQR + ' anyUnique=' + anyUnique + ' ok=' + ok + ' (recovered=' + r.ok + ' textMatch=' + r.textMatch + ') status=' + tail.status + ' recText=' + (tail.recText || '-').slice(0, 60) + ' stats=' + tail.stats);
        results.push({ name: c.name, recv: recv.name, ok, anyQR, anyUnique, recovered: r.ok, textMatch: r.textMatch, status: tail.status, recText: (tail.recText || '').slice(0, 60), statsTail: tail.stats });
      }
    } catch (e) {
      log('CASE ERROR: ' + e.message);
      results.push({ name: c.name, ok: false, err: e.message });
    }
  }
  log('===== SUMMARY =====');
  let allOk = true;
  for (const r of results) {
    log(JSON.stringify(r));
    if (!r.ok) allOk = false;
  }
  log(allOk ? "ALL PASS" : "SOME FAILED");
  process.exitCode = allOk ? 0 : 1;
})().catch(e => { log("FATAL: " + (e && e.stack ? e.stack : e)); process.exitCode = 1; });
