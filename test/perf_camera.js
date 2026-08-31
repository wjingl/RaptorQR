// 真实场景性能：模拟相机流（双线性，符号占比 75%），含帧间复用（tracking）效果
const C = require('../cimqr_codec.js');
function makePacket(n) { const p = new Uint8Array(n); for (let i=0;i<n;i++) p[i]=(i*31+7)&255; return p; }
const sym = C.render(makePacket(4000));
function cam(scale, shift) {
  const W = 1024, T = Math.round(1088 * scale);
  const out = new Uint8ClampedArray(W * W * 4).fill(255);
  const ox = Math.floor((W - T) / 2) + (shift || 0), oy = Math.floor((W - T) / 2);
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    const sx = x / scale, sy = y / scale;
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
    for (let ch = 0; ch < 3; ch++) {
      const p00 = sym.data[(y0*1088+x0)*4+ch], p10 = sym.data[(y0*1088+x0+1)*4+ch];
      const p01 = sym.data[((y0+1)*1088+x0)*4+ch], p11 = sym.data[((y0+1)*1088+x0+1)*4+ch];
      out[((oy+y)*W+(ox+x))*4+ch] = p00*(1-fx)*(1-fy)+p10*fx*(1-fy)+p01*(1-fx)*fy+p11*fx*fy;
    }
  }
  return { data: out, width: W, height: W };
}
// 连续帧模拟：静止（tracking 命中）+ 每 10 帧平移 2px（tracking 失配→全检测）
const f = cam(0.75);
let total = 0, okFrames = 0, trackHits = 0;
const N = 30;
for (let i = 0; i < N; i++) {
  const shift = i % 10 === 0 ? 2 : 0;
  const fr = i === 0 ? f : cam(0.75, shift);
  const t0 = performance.now();
  const r = C.decode(fr.data, fr.width, fr.height);
  const ms = performance.now() - t0;
  total += ms;
  if (r.length) okFrames++;
  if (ms < 60 && i > 0) trackHits++;
}
console.log('30 帧相机流 (75% 符号, 每10帧抖动2px):');
console.log('  平均 ' + (total / N).toFixed(1) + 'ms/帧, 解出 ' + okFrames + '/' + N + ' 帧');
console.log('  快速帧(≤60ms, 含 tracking) ' + trackHits + ' 帧');
console.log('  等效吞吐 ' + Math.round(1000 / (total / N)) + ' 帧/s');
