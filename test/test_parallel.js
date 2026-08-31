// 并行=4 彩色端到端：真实浏览器 2176×2176 帧 → 真实 decode worker → 文件逐字节还原
const fs = require('fs');
const zlib = require('zlib');
const lib = fs.readFileSync(__dirname + '/test_browser_e2e.js', 'utf8');
eval(lib.match(/function decodePNG[\s\S]*?\n}\n/)[0]);
const T = require('./test_tolerance.js');

(async () => {
  const cap = JSON.parse(fs.readFileSync(__dirname + '/fixtures/cdp_parallel.json', 'utf8'));
  const expected = fs.readFileSync(__dirname + '/fixtures/rand_30k.bin');
  console.log('并行帧数:', cap.frames.length, '(每帧 4 个彩色符号, 2176×2176)');

  const w = await T.makeDecodeWorker();
  w.dispatch({ type: 'settings', settings: {}, fecCodec: 'auto' });

  const t0 = Date.now();
  let totalUnique = 0;
  for (let i = 0; i < cap.frames.length; i++) {
    const img = decodePNG(cap.frames[i]);
    w.dispatch({ type: 'frame', pixels: img.data.buffer.slice(0), width: img.width, height: img.height, realtime: true });
    await new Promise(r => setTimeout(r, 400)); // 等 worker 处理完该帧
    const progs = w.posted.filter(m => m.type === 'progress');
    const p = progs[progs.length - 1];
    totalUnique = p.uniquePackets;
    console.log(`帧${i}: uniquePackets=${p.uniquePackets} dup=${p.duplicatePackets} accepted=${p.acceptedPackets} needed=${p.neededPackets}`);
  }
  const done = await new Promise((resolve) => {
    const iv = setInterval(() => {
      const comp = w.posted.find(m => m.type === 'complete');
      if (comp) { clearInterval(iv); resolve(comp); return; }
      if (Date.now() - t0 > 90000) { clearInterval(iv); resolve(null); }
    }, 25);
  });
  if (!done) { console.log('✗ 未解出（unique=' + totalUnique + '）'); process.exit(1); }
  const data = Buffer.from(done.data);
  let d = -1;
  for (let i = 0; i < Math.min(data.length, expected.length); i++) if (data[i] !== expected[i]) { d = i; break; }
  console.log('首个差异 @', d, '/', expected.length);
  if (d >= 0) {
    console.log('期望:', [...expected.subarray(d, d + 16)].join(','));
    console.log('实际:', [...data.subarray(d, d + 16)].join(','));
  }
  const ok = data.equals(expected);
  console.log('\nCOMPLETE: filename=' + done.filename + ' size=' + data.length + ' 期望=' + expected.length);
  console.log(ok ? '*** 并行=4 彩色传输 PASS：2 帧（8 符号）→ 30000 字节逐字节还原 ***' : '✗ 内容不符');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
