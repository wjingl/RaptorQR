// Real-browser functional test via CDP (Chrome DevTools Protocol), real time.
// Drives the ACTUAL app UI: Text -> paste -> Advanced -> Color CimQR -> Start Live QR,
// then captures live canvas frames (PNG dataURLs) + palette stats into a JSON file.
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const TARGET = process.argv[2] === 'orig' ? 'RaptorQR_离线单文件版.html' : 'RaptorQR_彩色版.html';
const OUT_JSON = process.argv[2] === 'orig' ? 'cdp_orig_result.json' : 'cdp_capture.json';
const PORT = 9300 + Math.floor(Math.random() * 200);
const PROFILE = process.envTEMP || 'C:/Temp';

// ~33KB text -> several packets at 7229 B/frame
const TEXT = ('CimQR-COLOR-E2E-验证|' + 'The quick brown fox jumps over the lazy dog. 0123456789 ').repeat(420);

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const prof = fs.mkdtempSync(process.env.TEMP + '/edge_cdp_');
  const proc = spawn(edge, [
    '--remote-allow-origins=*',
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1400,2400',
    '--allow-file-access-from-files',
    'file:///' + process.cwd().replace(/\\/g, '/') + '/' + encodeURIComponent(TARGET).replace(/%E5%BD%A9%E8%89%B2%E7%89%88/g, encodeURIComponent('彩色版'))
  ], { stdio: 'ignore' });

  // wait for CDP
  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { targets = await httpGetJson(`http://127.0.0.1:${PORT}/json`); if (targets && targets.length) break; } catch (e) {}
  }
  if (!targets) { console.error('CDP never came up'); process.exit(1); }
  const page = targets.find(t => t.type === 'page' && t.url.includes('file://'));
  if (!page) { console.error('no page target', targets.map(t => t.type + ':' + t.url)); process.exit(1); }
  console.log('page target:', page.url.slice(0, 80));

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let mid = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  function send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++mid;
      pending.set(id, m => m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result));
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evalJS(expr, awaitPromise = true) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true, timeout: 180000 });
    if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails).slice(0, 500));
    return r.result.value;
  }

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable').catch(() => {});
  const consoleMsgs = [];
  send('Runtime.consoleAPICalled').catch(() => {});
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      const t = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
      if (m.params.type === 'error' || m.params.type === 'warning') consoleMsgs.push(m.params.type + ': ' + t.slice(0, 300));
    }
    if (m.method === 'Runtime.exceptionThrown') consoleMsgs.push('exception: ' + String(m.params.exceptionDetails?.exception?.description || '').slice(0, 300));
  });

  // wait for app render
  const t0 = Date.now();
  while (!(await evalJS(`!!(function(){var b=document.querySelectorAll('button');for(var i=0;i<b.length;i++)if(b[i].textContent.trim().startsWith('Start Live QR'))return b[i];})()`, false))) {
    if (Date.now() - t0 > 30000) throw new Error('app never rendered');
    await sleep(500);
  }
  console.log('app rendered, driving UI...');
  await sleep(300);

  // findBtns helper expression
  const driver = `
  (async () => {
    const TEXT = ${JSON.stringify(TEXT)};
    const IS_COLOR = ${process.argv[2] === 'orig' ? 'false' : 'true'};
    const log = [];
    function findBtn(t){const b=document.querySelectorAll('button');for(const x of b)if(x.textContent.trim().startsWith(t))return x;return null;}
    function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
    try {
      const tb = findBtn('Text'); if (tb) { tb.click(); log.push('text-tab'); }
      await sleep(200);
      const ta = document.querySelector('textarea');
      if (!ta) throw new Error('no textarea');
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      set.call(ta, TEXT); ta.dispatchEvent(new Event('input',{bubbles:true}));
      log.push('text set: ' + ta.value.length + ' chars');
      await sleep(200);
      const adv = findBtn('Advanced settings');
      if (adv) { adv.click(); log.push('advanced opened'); }
      await sleep(300);
      if (IS_COLOR) {
        let sel = null;
        for (const s of document.querySelectorAll('select'))
          for (const o of s.options) if (o.value === 'color-cimbar') { sel = s; break; }
        if (!sel) throw new Error('color-cimbar option not found');
        sel.value = 'color-cimbar';
        sel.dispatchEvent(new Event('change',{bubbles:true}));
        log.push('color-cimbar selected');
        await sleep(300);
      }
      const start = findBtn('Start Live QR');
      if (!start) throw new Error('start button not found');
      start.click();
      log.push('start clicked');
      // wait for canvas painted
      let cv = null, waited = 0;
      while (waited < 45000) {
        await sleep(500); waited += 500;
        cv = document.querySelector('canvas.qr-live-canvas');
        if (cv) {
          try {
            const ctx = cv.getContext('2d');
            const d = ctx.getImageData(0,0,cv.width,cv.height).data;
            let painted = 0;
            for (let i=3;i<d.length;i+=9973) if (d[i]>0) painted++;
            if (painted > 100) break;
          } catch(e) {}
          cv = null;
        }
      }
      if (!cv) { log.push('TIMEOUT no canvas'); return { ok:false, log, consoleMsgs: [] }; }
      log.push('canvas live: ' + cv.width + 'x' + cv.height);
      // measure RAF rate over 1s
      const rafCount = await new Promise(res => { let n = 0; const s0 = performance.now(); function f(){ n++; if (performance.now() - s0 < 1000) requestAnimationFrame(f); else res(n); } requestAnimationFrame(f); });
      log.push('raf/s = ' + rafCount);
      // status line
      let statusLine = '';
      for (const el of document.querySelectorAll('div,span')) {
        const t = el.textContent || '';
        if (/Live QR running|Encoded .* packets/.test(t) && t.length < 160) { statusLine = t.trim(); break; }
      }
      log.push('status: ' + statusLine);
      // capture distinct frames via cheap pixel fingerprint, fast poll
      const seen = new Set(), frames = [];
      const ctx = cv.getContext('2d');
      const capT0 = Date.now();
      let polls = 0;
      while (frames.length < 16 && Date.now() - capT0 < 90000) {
        await sleep(80); polls++;
        const c = document.querySelector('canvas.qr-live-canvas');
        if (!c) continue;
        let d;
        try { d = ctx.getImageData(0, 0, c.width, c.height).data; } catch (e) { continue; }
        // fingerprint: 64 sampled pixels
        let fp = '';
        for (let k = 0; k < 64; k++) {
          const o = (k * 6553 + 7) % (d.length / 4) * 4;
          fp += ((d[o] > 128 ? 1 : 0) | (d[o+1] > 128 ? 2 : 0) | (d[o+2] > 128 ? 4 : 0)).toString(16);
        }
        if (!seen.has(fp)) {
          seen.add(fp);
          try {
            const url = c.toDataURL('image/png');
            frames.push(url);
            log.push('frame#' + frames.length + ' fp=' + fp.slice(0,16) + ' pnglen=' + url.length);
          } catch (e) {}
        }
      }
      log.push('polls=' + polls + ' distinct=' + frames.length);
      // palette analysis on current canvas
      let palette = null;
      {
        const c = document.querySelector('canvas.qr-live-canvas');
        const ctx = c.getContext('2d');
        const d = ctx.getImageData(0,0,c.width,c.height).data;
        palette = { green:0, cyan:0, yellow:0, magenta:0, black:0, white:0, other:0 };
        for (let i=0;i<d.length;i+=4) {
          const r=d[i],g=d[i+1],b=d[i+2];
          if      (g>200 && r<90  && b<90 ) palette.green++;
          else if (g>200 && b>200 && r<90 ) palette.cyan++;
          else if (r>200 && g>200 && b<90 ) palette.yellow++;
          else if (r>200 && b>200 && g<90 ) palette.magenta++;
          else if (r<40  && g<40  && b<40 ) palette.black++;
          else if (r>215 && g>215 && b>215) palette.white++;
          else palette.other++;
        }
      }
      // status text
      let statusText = '';
      for (const el of document.querySelectorAll('div,span')) {
        const t = el.textContent || '';
        if (/packet|Encoding|fps/.test(t) && t.length < 160 && !t.includes('B/frameV')) { statusText = t.trim(); break; }
      }
      return { ok: frames.length > 0, log, frames, palette, statusText, consoleMsgs: [] };
    } catch (e) {
      return { ok:false, log, error: e.message };
    }
  })()
  `;
  const result = await evalJS(driver, true);
  result.consoleMsgs = consoleMsgs;
  fs.writeFileSync(OUT_JSON, JSON.stringify(result));
  console.log('ok:', result.ok);
  console.log('log:', (result.log || []).join('\n  '));
  if (result.palette) console.log('palette:', JSON.stringify(result.palette));
  if (result.error) console.log('ERROR:', result.error);
  console.log('console messages:', consoleMsgs.slice(0, 12));
  console.log('saved ->', OUT_JSON, 'frames:', (result.frames || []).length);

  ws.close();
  require('child_process').spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
