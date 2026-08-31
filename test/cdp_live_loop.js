// CDP 实测发送端：钩住 Worker 消息 + 轮询画布指纹，确认 live 循环是否真的轮换包
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const PORT = 9300 + Math.floor(Math.random() * 200);

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const prof = fs.mkdtempSync(process.env.TEMP + '/edge_cdp2_');
  const proc = spawn(edge, [
    '--remote-allow-origins=*',
    '--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1400,2400',
    '--allow-file-access-from-files',
    ('file:///' + __dirname.split(String.fromCharCode(92)).join('/') + '/../RaptorQR_彩色版.html')
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { targets = await httpGetJson(`http://127.0.0.1:${PORT}/json`); if (targets && targets.length) break; } catch (e) {}
  }
  const page = targets.find(t => t.type === 'page' && t.url.includes('file://'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let mid = 0;
  const pending = new Map();
  ws.onmessage = ev => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
  function send(method, params = {}) {
    return new Promise((res, rej) => { const id = ++mid; pending.set(id, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); ws.send(JSON.stringify({ id, method, params })); });
  }
  async function evalJS(expr, awaitPromise = true) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true, timeout: 180000 });
    if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
  await send('Runtime.enable');

  // wait app + drive UI (reuse pattern)
  const driver = `
  (async () => {
    const log = [];
    function findBtn(t){const b=document.querySelectorAll('button');for(const x of b)if(x.textContent.trim().startsWith(t))return x;return null;}
    function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
    // hook Worker: log render requests/completions
    const Orig = window.Worker;
    const msgs = [];
    window.Worker = function(url, opts){
      const w = new Orig(url, opts);
      let tag = '';
      try { tag = atob(String(url).split(',')[1] || '').slice(0, 60).replace(/[^ -~]/g, ''); } catch(e) {}
      w.addEventListener('message', e => {
        const t = e.data && e.data.type;
        if (t === 'rendered' || t === 'render-error' || t === 'error') msgs.push(t + ':' + JSON.stringify({job: e.data.jobId, w: e.data.width, h: e.data.height, err: e.data.message}).slice(0, 160));
      });
      const p = w.postMessage.bind(w);
      w.postMessage = function(m){
        if (m && m.type === 'render') msgs.push('->render job=' + m.jobId + ' enc=' + m.qrEncoder + ' plen=' + (m.packet ? m.packet.byteLength : 0));
        return p(m);
      };
      return w;
    };
    try {
      const t0 = Date.now();
      while (!findBtn('Start Live QR')) { if (Date.now() - t0 > 30000) return { ok:false, log:'no app', msgs }; await sleep(300); }
      const tb = findBtn('Text'); if (tb) tb.click();
      await sleep(200);
      const ta = document.querySelector('textarea');
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      set.call(ta, 'E2E-live-loop-test-0123456789-abcdefghij-'.repeat(60));
      ta.dispatchEvent(new Event('input',{bubbles:true}));
      await sleep(200);
      const adv = findBtn('Advanced settings'); if (adv) adv.click();
      await sleep(300);
      let sel = null;
      for (const s2 of document.querySelectorAll('select')) for (const o of s2.options) if (o.value === 'color-cimbar') { sel = s2; break; }
      sel.value = 'color-cimbar'; sel.dispatchEvent(new Event('change',{bubbles:true}));
      await sleep(300);
      findBtn('Start Live QR').click();
      // wait painted
      let cv = null;
      const t1 = Date.now();
      while (!cv && Date.now() - t1 < 30000) {
        await sleep(300);
        cv = document.querySelector('canvas.qr-live-canvas');
        if (cv) { const c = cv.getContext('2d'); const d = c.getImageData(0,0,cv.width,cv.height).data; let pn=0; for (let i=3;i<d.length;i+=9973) if (d[i]>0) pn++; if (pn < 100) cv = null; }
      }
      if (!cv) return { ok:false, log:'no canvas', msgs };
      // fingerprint poll 5s
      const fp = (c) => {
        const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        let s3 = '';
        for (let k=0;k<48;k++){ const o=((k*6553+7)%(d.length/4))*4; s3 += ((d[o]>128?1:0)|(d[o+1]>128?2:0)|(d[o+2]>128?4:0)).toString(16); }
        return s3;
      };
      const seen = new Set();
      const t2 = Date.now();
      while (Date.now() - t2 < 5000) {
        await sleep(80);
        seen.add(fp(cv));
      }
      return { ok: true, distinctFrames: seen.size, samples: seen.size, msgs: msgs.slice(0, 40), msgCount: msgs.length };
    } catch (e) { return { ok:false, log: e.message, msgs }; }
  })()
  `;
  const result = await evalJS(driver, true);
  console.log('distinct canvas frames in 5s:', result.distinctFrames);
  console.log('worker msgs (' + result.msgCount + '):');
  for (const m of result.msgs.slice(0, 40)) console.log('  ' + m);
  ws.close();
  require('child_process').spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
