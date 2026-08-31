// 浏览器并行=4 彩色端到端：30KB 文件 → Parallel QR=4 → Color CimQR → 捕获 2176×2176 帧 → 保存
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
  const FILE = __dirname + '/fixtures/rand_30k.bin';
  if (!fs.existsSync(__dirname + '/fixtures/rand_30k.bin')) {
    const rnd = Buffer.alloc(30000);
    for (let i = 0; i < rnd.length; i++) rnd[i] = (Math.random() * 256) | 0;
    fs.writeFileSync(__dirname + '/fixtures/rand_30k.bin', rnd);
  }

  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const prof = fs.mkdtempSync(process.env.TEMP + '/edge_par_');
  const proc = spawn(edge, [
    '--remote-allow-origins=*',
    '--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1600,2400',
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
  await send('DOM.enable');

  // File tab 注入
  await evalJS(`(async () => {
    function findBtn(t){const b=document.querySelectorAll('button');for(const x of b)if(x.textContent.trim().startsWith(t))return x;}
    function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
    const t0 = Date.now();
    while (!findBtn('Start Live QR')) { if (Date.now() - t0 > 30000) return; await sleep(300); }
    const fb = findBtn('File'); if (fb) fb.click();
    await sleep(400);
    return !!document.querySelector('input[type=file]');
  })()`, true).then(async (hasInput) => {
    if (!hasInput) throw new Error('file input not found');
    const doc = await send('DOM.getDocument', { depth: 1 });
    const inp = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
    await send('DOM.setFileInputFiles', { nodeId: inp.nodeId, files: [FILE] });
    await sleep(400);
  });

  const result = await evalJS(`(async () => {
    const log = [];
    function findBtn(t){const b=document.querySelectorAll('button');for(const x of b)if(x.textContent.trim().startsWith(t))return x;}
    function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
    function setSelect(pred, val) {
      for (const s of document.querySelectorAll('select'))
        if (pred(s)) { s.value = val; s.dispatchEvent(new Event('change',{bubbles:true})); return true; }
      return false;
    }
    try {
      const fb0 = findBtn('File'); if (fb0) fb0.click();
      await sleep(300);
      const adv = findBtn('Advanced settings'); if (adv) adv.click();
      await sleep(300);
      // 编码器 → 彩色
      let ok1 = setSelect(s => Array.from(s.options).some(o => o.value === 'color-cimbar'), 'color-cimbar');
      log.push('color-cimbar 选择: ' + ok1);
      await sleep(300);
      // 并行 → 4（选项含 4 且不含 10..40 的 select 即并行下拉）
      const parSel = Array.from(document.querySelectorAll('select')).find(s => {
        const vals = Array.from(s.options).map(o => o.value);
        return vals.includes('1') && vals.includes('4') && vals.includes('8') && !vals.includes('10');
      });
      if (!parSel) return { ok:false, log:'parallel select not found' };
      parSel.value = '4'; parSel.dispatchEvent(new Event('change',{bubbles:true}));
      log.push('parallel=4 已选');
      await sleep(300);
      // 等文件名
      const t3 = Date.now();
      let fn = '';
      while (Date.now() - t3 < 15000) {
        fn = '';
        for (const el of document.querySelectorAll('span')) { const t = el.textContent || ''; if (/rand_30k/.test(t)) fn = t; }
        if (fn) break;
        await sleep(200);
      }
      log.push('file: ' + (fn || 'MISSING'));
      const sb = findBtn('Start Live QR');
      if (!sb) return { ok:false, log:'no start button' };
      sb.click();
      log.push('started');
      // 细粒度轮询：编码状态 + 画布绘制情况
      {
        const tP = Date.now();
        while (Date.now() - tP < 25000) {
          await sleep(1000);
          let st = '';
          for (const el of document.querySelectorAll('div,span')) { const t = el.textContent || ''; if (/Encoding|Encoded|Live QR running|Rendering/.test(t) && t.length < 140) { st = t.trim(); break; } }
          const cv2 = document.querySelector('canvas.qr-live-canvas');
          let painted = -1;
          if (cv2) { try { const d = cv2.getContext('2d').getImageData(0,0,cv2.width,cv2.height).data; painted = 0; for (let i=3;i<d.length;i+=9973) if (d[i]>0) painted++; } catch(e){} }
          log.push('t+' + ((Date.now()-tP)/1000).toFixed(0) + 's st=' + (st || '-') + ' canvas=' + (cv2 ? cv2.width+'x'+cv2.height + ' painted=' + painted : 'none'));
          if (cv2 && painted > 100) break;
        }
      }
      // 等画布
      let cv = null;
      const t1 = Date.now();
      while (!cv && Date.now() - t1 < 40000) {
        await sleep(300);
        cv = document.querySelector('canvas.qr-live-canvas');
        if (cv) { const c = cv.getContext('2d'); const d = c.getImageData(0,0,cv.width,cv.height).data; let pn=0; for (let i=3;i<d.length;i+=9973) if (d[i]>0) pn++; if (pn < 100) cv = null; }
      }
      if (!cv) return { ok:false, log, why:'no canvas' };
      log.push('canvas: ' + cv.width + 'x' + cv.height);
      // 捕获不同帧
      const fp = (c) => {
        const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        let s3 = '';
        for (let k=0;k<48;k++){ const o=((k*6553+7)%(d.length/4))*4; s3 += ((d[o]>128?1:0)|(d[o+1]>128?2:0)|(d[o+2]>128?4:0)).toString(16); }
        return s3;
      };
      const seen = new Set(), frames = [];
      const t2 = Date.now();
      while (frames.length < 6 && Date.now() - t2 < 90000) {
        await sleep(120);
        const c = document.querySelector('canvas.qr-live-canvas');
        if (!c) continue;
        const f = fp(c);
        if (!seen.has(f)) { seen.add(f); try { frames.push(c.toDataURL('image/png')); log.push('frame#' + frames.length); } catch(e) {} }
      }
      let status = '';
      for (const el of document.querySelectorAll('div,span')) { const t = el.textContent || ''; if (/Live QR running/.test(t) && t.length < 120) { status = t.trim(); break; } }
      return { ok: frames.length > 1, log, frames, status, expectedSize: 30000 };
    } catch (e) { return { ok:false, log: 'ERR ' + e.message, frames: [] }; }
  })()`, true);
  console.log('RAW:', JSON.stringify(result).slice(0, 1000));
  
  console.log('status:', result.status);
  if (result.frames && result.frames.length > 1) {
    fs.writeFileSync(__dirname + '/fixtures/cdp_parallel.json', JSON.stringify({ frames: result.frames, expectedSize: result.expectedSize }));
    console.log('saved cdp_parallel.json');
  }
  ws.close();
  require('child_process').spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
