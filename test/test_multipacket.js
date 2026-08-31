// 真实浏览器多包帧 → 真实 decode worker → 文件逐字节还原
const fs = require('fs');
const zlib = require('zlib');
const lib = fs.readFileSync(__dirname + '/test_browser_e2e.js', 'utf8');
eval(lib.match(/function decodePNG[\s\S]*?\n}\n/)[0]);
const T = require('./test_tolerance.js');

(async () => {
  const cap = JSON.parse(fs.readFileSync(__dirname + '/fixtures/cdp_multipacket.json', 'utf8'));
  const expected = fs.readFileSync(__dirname + '/fixtures/rand_30k.bin');
  console.log('捕获帧数:', cap.frames.length, '| 期望大小:', cap.expectedSize);

  const w = await T.makeDecodeWorker();
  w.dispatch({ type: 'settings', settings: {}, fecCodec: 'auto' });

  const t0 = Date.now();
  // 顺序喂帧（含中间故意漏掉帧 3，模拟采样丢失）
  const skip = new Set([3]);
  for (let i = 0; i < cap.frames.length; i++) {
    if (skip.has(i)) { console.log('  帧 ' + i + ' 采样丢失（跳过）'); continue; }
    const img = decodePNG(cap.frames[i]);
    w.dispatch({ type: 'frame', pixels: img.data.buffer.slice(0), width: img.width, height: img.height, realtime: true });
    await new Promise(r => setTimeout(r, 30));
    const prog = w.posted.filter(m => m.type === 'progress').map(m => m.uniquePackets + '/' + m.acceptedPackets);
    console.log('  喂帧 ' + i + ' → unique/accepted: ' + prog.join(', ') || '(队列中)');
  }
  const done = await new Promise((resolve) => {
    const iv = setInterval(() => {
      const comp = w.posted.find(m => m.type === 'complete');
      if (comp) { clearInterval(iv); resolve(comp); return; }
      if (Date.now() - t0 > 60000) { clearInterval(iv); resolve(null); }
    }, 25);
  });
  if (!done) { console.log('✗ 未解出'); process.exit(1); }
  const data = Buffer.from(done.data);
  const ok = data.equals(expected);
  console.log('\nCOMPLETE: filename=' + done.filename + ' mime=' + done.mime + ' size=' + data.length + ' 期望=' + expected.length);
  console.log(ok ? '*** 多包真实传输 PASS：6 帧（漏 1 帧）→ 30000 字节逐字节还原 ***' : '✗ 内容不符');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
