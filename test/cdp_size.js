// 验证彩色 QR SIZE 低容量档：V10 → 1448 B/frame，实际编码用小包
const { spawn } = require('child_process');
const http = require('http');
const PORT = 9300 + Math.floor(Math.random() * 200);
function httpGetJson(url) { return new Promise((res, rej) => { http.get(url, r => { let b=''; r.on('data',d=>b+=d); r.on('end',()=>{try{res(JSON.parse(b))}catch(e){rej(e)}}); }).on('error', rej); }); }
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
(async () => {
  const prof = require('fs').mkdtempSync(process.env.TEMP + '/edge_sz_');
  const proc = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=${prof}`,
    '--allow-file-access-from-files',
    ('file:///' + __dirname.split(String.fromCharCode(92)).join('/') + '/../RaptorQR_彩色版.html')
  ], { stdio: 'ignore' });
  let targets;
  for (let i=0;i<60;i++){ await sleep(400); try { targets = await httpGetJson(`http://127.0.0.1:${PORT}/json`); if (targets && targets.length) break; } catch(e){} }
  const page = targets.find(t=>t.type==='page'&&t.url.includes('file://'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
  let mid=0; const pending=new Map();
  ws.onmessage=ev=>{const m=JSON.parse(ev.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
  const send=(method,params={})=>new Promise((res,rej)=>{const id=++mid;pending.set(id,m=>m.error?rej(new Error(JSON.stringify(m.error))):res(m.result));ws.send(JSON.stringify({id,method,params}));});
  await send('Runtime.enable');
  const r = await send('Runtime.evaluate',{expression:`(async () => {
    const log = [];
    function findBtn(t){const b=document.querySelectorAll('button');for(const x of b)if(x.textContent.trim().startsWith(t))return x;}
    function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
    function setSelect(pred, val){for (const s of document.querySelectorAll('select')) if (pred(s)) { s.value=val; s.dispatchEvent(new Event('change',{bubbles:true})); return true; } return false;}
    try {
      const t0 = Date.now();
      while (!findBtn('Start Live QR')) { if (Date.now()-t0>30000) return {ok:false, log:'no app'}; await sleep(300); }
      const tb = findBtn('Text'); if (tb) tb.click();
      await sleep(200);
      const ta = document.querySelector('textarea');
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      set.call(ta, 'LOW-CAPACITY-TEST-'.repeat(20));
      ta.dispatchEvent(new Event('input',{bubbles:true}));
      await sleep(200);
      const adv = findBtn('Advanced settings'); if (adv) adv.click();
      await sleep(300);
      setSelect(s => Array.from(s.options).some(o => o.value === 'color-cimbar'), 'color-cimbar');
      await sleep(300);
      const verSel = Array.from(document.querySelectorAll('select')).find(s => Array.from(s.options).some(o => o.value === '10'));
      if (verSel) { verSel.value = '10'; verSel.dispatchEvent(new Event('change',{bubbles:true})); log.push('V10 selected'); }
      await sleep(300);
      let cap = '';
      for (const el of document.querySelectorAll('span')) { const t = el.textContent || ''; if (t.indexOf('B/') >= 0 && t.length < 40) { cap = t.trim(); break; } }
      log.push('容量显示: ' + cap);
      const parSel = Array.from(document.querySelectorAll('select')).find(s => { const v = Array.from(s.options).map(o=>o.value); return v.includes('1')&&v.includes('8')&&!v.includes('10'); });
      if (parSel) { parSel.value='1'; parSel.dispatchEvent(new Event('change',{bubbles:true})); }
      await sleep(300);
      findBtn('Start Live QR').click();
      let cv = null;
      const t1 = Date.now();
      while (!cv && Date.now()-t1 < 30000) {
        await sleep(300);
        cv = document.querySelector('canvas.qr-live-canvas');
        if (cv) { const c = cv.getContext('2d'); const d = c.getImageData(0,0,cv.width,cv.height).data; let pn=0; for (let i=3;i<d.length;i+=19973) if (d[i]>0) pn++; if (pn<100) cv=null; }
      }
      if (!cv) return {ok:false, log};
      let st = '';
      for (const el of document.querySelectorAll('div,span')) { const t = el.textContent || ''; if (/Live QR running/.test(t) && t.length < 120) { st = t.trim(); break; } }
      log.push('状态: ' + st);
      return { ok: true, log, canvas: cv.width + 'x' + cv.height };
    } catch (e) { return {ok:false, log:'ERR ' + e.message}; }
  })()`, awaitPromise:true, returnByValue:true, timeout:120000});
  console.log(JSON.stringify((r && r.result && r.result.value) || r || { err: 1 }));
  require('child_process').spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  process.exit(0);
})().catch(e=>{console.error('FATAL:',e.message);process.exit(1);});
