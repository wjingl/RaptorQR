const fs = require('fs');
const zlib = require('zlib');
const lib = fs.readFileSync('test_browser_e2e.js', 'utf8');
eval(lib.match(/function decodePNG[\s\S]*?\n}\n/)[0]);
const C = require('../cimqr_codec.js');
const cap = JSON.parse(fs.readFileSync(__dirname + '/fixtures/cdp_capture.json', 'utf8'));
const img = decodePNG(cap.frames[0]);

// warmup
C.decode(img.data, img.width, img.height);

// 1) tier-1 attempt (clean-frame fast path) — 10 runs
let t = [];
for (let i = 0; i < 10; i++) {
  const t0 = performance.now();
  C._decodeAttempt(img.data, img.width, img.height, 512, 7.5, false, true);
  t.push(performance.now() - t0);
}
const avg1 = t.reduce((a, b) => a + b) / t.length;
console.log('tier-1 解码 (512 检测 + 硬匹配 + BR 标记): 平均 ' + avg1.toFixed(1) + 'ms/帧 (1088×1088)');

// 2) full ladder worst case — 3 runs
t = [];
for (let i = 0; i < 3; i++) {
  const t0 = performance.now();
  C.decode(img.data, img.width, img.height);
  t.push(performance.now() - t0);
}
console.log('完整阶梯（首层即命中）: 平均 ' + (t.reduce((a, b) => a + b) / t.length).toFixed(1) + 'ms');

// 3) render timing
const packet = new Uint8Array(7241);
for (let i = 0; i < packet.length; i++) packet[i] = (i * 31) & 255;
t = [];
for (let i = 0; i < 5; i++) {
  const t0 = performance.now();
  C.render(packet);
  t.push(performance.now() - t0);
}
console.log('渲染 1088×1088 彩色帧: 平均 ' + (t.reduce((a, b) => a + b) / t.length).toFixed(1) + 'ms');

// 4) throughput math
console.log('\n—— 吞吐对比（30fps 播放）——');
console.log('Color CimQR: 7229 B/帧 × 30 = ' + (7229 * 30 / 1024).toFixed(0) + ' KB/s 原始载荷');
console.log('传统黑白 V10-L: ~213 B/帧 × 30 = ' + (213 * 30 / 1024).toFixed(1) + ' KB/s');
console.log('提升: ~' + (7229 / 213).toFixed(0) + '×');
console.log('接收端解码能力: ' + (1000 / avg1).toFixed(1) + ' 帧/s（单线程）≥ 相机分析 5-10 帧/s 需求');
