const C = require('../cimqr_codec.js');
function makePacket(n) { const p = new Uint8Array(n); for (let i=0;i<n;i++) p[i]=(i*31+7)&255; return p; }
const sym = C.render(makePacket(4000));
const scale = 0.75, W = 1024, T = Math.round(1088 * scale);
const out = new Uint8ClampedArray(W * W * 4).fill(255);
const ox = Math.floor((W - T) / 2), oy = Math.floor((W - T) / 2);
for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
  const sx = x / scale, sy = y / scale;
  const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
  for (let ch = 0; ch < 3; ch++) {
    const p00 = sym.data[(y0*1088+x0)*4+ch], p10 = sym.data[(y0*1088+x0+1)*4+ch];
    const p01 = sym.data[((y0+1)*1088+x0)*4+ch], p11 = sym.data[((y0+1)*1088+x0+1)*4+ch];
    out[((oy+y)*W+(ox+x))*4+ch] = p00*(1-fx)*(1-fy)+p10*fx*(1-fy)+p01*(1-fx)*fy+p11*fx*fy;
  }
}
const gray = new Uint8Array(W * W);
for (let i = 0, o = 0; i < gray.length; i++, o += 4) gray[i] = (out[o]*299 + out[o+1]*587 + out[o+2]*114)/1000;
const d = C._detect(out, W, W);
console.log('sel:', d.sel ? d.sel.tl.x.toFixed(1)+','+d.sel.tl.y.toFixed(1)+' m='+d.sel.module.toFixed(1) : 'null');
if (!d.sel) process.exit(0);
// 手动复刻 v3 scanWindow 行向
const cx = d.sel.tl.x, cy = d.sel.tl.y, module = d.sel.module;
const thr = 120;
function scanRowWin(y, lo, hi) {
  const runsD = [], runsL = [];
  let prevDark = -1, run = 0;
  for (let p = lo; p <= hi; p++) {
    const g = gray[y*W+p];
    const dark = g < thr ? 1 : 0;
    if (prevDark === -1) { prevDark = dark; run = 1; }
    else if (dark === prevDark) run++;
    else { runsD.push(prevDark); runsL.push(run); prevDark = dark; run = 1; }
  }
  if (prevDark !== -1) { runsD.push(prevDark); runsL.push(run); }
  console.log('  y=' + y + ' runs:', runsD.map((v,i)=>v+runsL[i]).join(' '));
  return { runsD, runsL };
}
const R = 3.2 * module;
const lo = Math.max(0, Math.round(cx - R)), hi = Math.min(W-1, Math.round(cx + R));
for (let j = -1; j <= 1; j++) {
  const ry = Math.round(cy + j * module * 0.7);
  const { runsD, runsL } = scanRowWin(ry, lo, hi);
  // 找 1:1:3:1:1
  for (let i = 0; i + 4 < runsD.length; i++) {
    if (!(runsD[i] && !runsD[i+1] && runsD[i+2] && !runsD[i+3] && runsD[i+4])) continue;
    const m = runsL[i+2]/3;
    const ok = runsL[i+1] >= m*0.5 && runsL[i+1] <= m*2.5 && runsL[i+3] >= m*0.5 && runsL[i+3] <= m*2.5 &&
               runsL[i] >= m*0.5 && runsL[i] <= m*3 && runsL[i+4] >= m*0.5 && runsL[i+4] <= m*3;
    let start = 0; for (let k=0;k<i;k++) start += runsL[k];
    const c = start + runsL[i] + runsL[i+1] + m*1.5;
    console.log('    图案 @' + i + ' m=' + m.toFixed(1) + ' 中心=' + c.toFixed(1) + ' 距cx=' + Math.abs(c-cx).toFixed(1) + ' 比率ok=' + ok);
  }
}
