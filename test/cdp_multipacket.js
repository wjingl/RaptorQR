// 真实浏览器多包传输：文件模式（30KB 随机 → 6 包）→ 捕获全部轮换帧 → 保存 JSON
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
  // 随机 30KB 文件
  const FILE = __dirname + '/fixtures/rand_30k.bin';
  const rnd = Buffer.alloc(30000);
  for (let i = 0; i < rnd.length; i++) rnd[i] = (Math.random() * 256) | 0;
  fs.writeFileSync(__dirname + '/fixtures/rand_30k.bin', rnd);

  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const prof = fs.mkdtempSync(process.env.TEMP + '/edge_cdp3_');
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
    return new Promise((res, rej) => { const id = ++mid; pending.set(id, m => m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)); ws.send(JSON.stringify({ id, method, params })); });
  }
  async function evalJS(expr, awaitPromise = true) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true, timeout: 180000 });
    if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
  await send('Runtime.enable');
  await send('Page.enable');
  await send('DOM.enable');

  // 等 File 标签渲染出文件输入框
  await evalJS(`(async () => {
    function findBtn(t){const b=document.querySelectorAll('button');for(const x of b)if(x.textContent.trim().startsWith(t))return x;}
    function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
    const t0 = Date.now();
    while (!findBtn('Start Live QR')) { if (Date.now() - t0 > 30000) return; await sleep(300); }
    const fb = findBtn('File'); if (fb) fb.click();
    await sleep(500);
    return !!document.querySelector('input[type=file]');
  })()`, true).then(async (hasInput) => {
    if (!hasInput) throw new Error('file input not found');
    const doc = await send('DOM.getDocument', { depth: 1 });
    const inp = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
    await send('DOM.setFileInputFiles', { nodeId: inp.nodeId, files: [FILE] });
    console.log('file injected via CDP');
    await sleep(400);
  });

  const result = await evalJS(`(async () => {
    const log = [];
    function findBtn(t){const b=document.querySelectorAll('button');for(const x of b)if(x.textContent.trim().startsWith(t))return x;return null;}
    function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
    try {
      const t0 = Date.now();
      while (!findBtn('Start Live QR')) { if (Date.now() - t0 > 30000) return { ok:false, log:'no app' }; await sleep(300); }
      // File tab（文件已由 CDP 注入）
      const fb = findBtn('File'); if (fb) fb.click(); else return { ok:false, log:'no File tab' };
      await sleep(300);
      // 等待文件名显示（注入生效）
      const t3 = Date.now();
      while (Date.now() - t3 < 10000) {
        let fn = '';
        for (const el of document.querySelectorAll('span')) { const t = el.textContent || ''; if (/rand_30k/.test(t)) fn = t; }
        if (fn) break;
        await sleep(200);
      }
      log.push('file picked');
      const adv = findBtn('Advanced settings'); if (adv) adv.click();
      await sleep(300);
      let sel = null;
      for (const s2 of document.querySelectorAll('select')) for (const o of s2.options) if (o.value === 'color-cimbar') { sel = s2; break; }
      if (!sel) return { ok:false, log:'no color option' };
      sel.value = 'color-cimbar'; sel.dispatchEvent(new Event('change',{bubbles:true}));
      await sleep(300);
      findBtn('Start Live QR').click();
      log.push('started');
      { const tP = Date.now(); while (Date.now() - tP < 15000) { await sleep(1000); let st=''; for (const el of document.querySelectorAll('div,span')) { const t=el.textContent||''; if (/Encoding|Encoded|Live QR running|Rendering|Please/.test(t) && t.length<140) { st=t.trim(); break; } } const cv2=document.querySelector('canvas.qr-live-canvas'); log.push('t+'+((Date.now()-tP)/1000).toFixed(0)+'s st='+(st||'-')+' canvas='+(cv2?cv2.width+'x'+cv2.height:'none')); if (cv2 && cv2.width) break; } }
      // wait painted
      let cv = null;
      const t1 = Date.now();
      while (!cv && Date.now() - t1 < 40000) {
        await sleep(300);
        cv = document.querySelector('canvas.qr-live-canvas');
        if (cv) { const c = cv.getContext('2d'); const d = c.getImageData(0,0,cv.width,cv.height).data; let pn=0; for (let i=3;i<d.length;i+=9973) if (d[i]>0) pn++; if (pn < 100) cv = null; }
      }
      if (!cv) return { ok:false, log, why:'no canvas' };
      log.push('canvas live');
      // 捕获不同帧（轮询 60ms，去重）
      const fp = (c) => {
        const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        let s3 = '';
        for (let k=0;k<40;k++){ const o=((k*6553+7)%(d.length/4))*4; s3 += ((d[o]>128?1:0)|(d[o+1]>128?2:0)|(d[o+2]>128?4:0)).toString(16); }
        return s3;
      };
      const seen = new Set(), frames = [];
      const t2 = Date.now();
      while (frames.length < 14 && Date.now() - t2 < 60000) {
        await sleep(60);
        const c = document.querySelector('canvas.qr-live-canvas');
        if (!c) continue;
        const f = fp(c);
        if (!seen.has(f)) {
          seen.add(f);
          try { frames.push(c.toDataURL('image/png')); log.push('frame#' + frames.length); } catch(e) {}
        }
      }
      // 状态行
      let status = '';
      for (const el of document.querySelectorAll('div,span')) { const t = el.textContent || ''; if (/Live QR running/.test(t) && t.length < 120) { status = t.trim(); break; } }
      return { ok: frames.length > 1, log, frames, status, expectedSize: ${rnd.length} };
    } catch (e) { return { ok:false, log: 'ERR ' + e.message, frames: [] }; }
  })()`, true);
  console.log('ok:', result.ok, '| frames:', (result.frames || []).length, '| status:', result.status || '');
  console.log('log:', result.log.join(' | '));
  if (result.frames && result.frames.length > 1) {
    fs.writeFileSync(__dirname + '/fixtures/cdp_multipacket.json', JSON.stringify({ frames: result.frames, expectedSize: result.expectedSize }));
    console.log('saved cdp_multipacket.json');
  }
  ws.close();
  require('child_process').spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
