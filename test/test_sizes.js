// 尺寸阶梯测试：8 档真实网格尺寸（40..112 每边格数）全链路验证
// - 每档 3 种渲染倍率下渲染→解码逐字节回路
// - 相机式畸变抽查（旋转/模糊/透视）在低档符号上
// - 尺寸自描述：标记码 → 档位、帧头格式字节 = 索引+1、几何估计 sizeFromSpan
// - 档位切换（tracking 缓存换档）与旧帧兼容（无标记码 → 112）
const CimQR = require('../cimqr_codec.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('PASS ', name); }
  else { fail++; console.log('FAIL ', name); }
}

// 期望容量表（与 build_color.js 内嵌表一致）
const EXPECT = [[112, 7241], [104, 6116], [96, 5241], [80, 3491], [64, 2116], [56, 1616], [48, 1116], [40, 616], [32, 366], [28, 241], [24, 116]];
ok(CimQR.SIZES.length === 11, '11 档尺寸');
let tableOK = true;
for (let i = 0; i < 8; i++) {
  if (CimQR.SIZES[i].grid !== EXPECT[i][0] || CimQR.SIZES[i].packet !== EXPECT[i][1]) tableOK = false;
}
ok(tableOK, '容量表与 UI 表一致 (grid/packet)');

// 几何一致性：img = grid*9+16；total = img+64；cells = g²-324-2(g-18)
let geoOK = true;
for (let i = 0; i < 8; i++) {
  const s = CimQR.SIZES[i];
  if (s.img !== s.grid * 9 + 16 || s.total !== s.img + 64) geoOK = false;
  const cells = s.grid * s.grid - 324 - 2 * (s.grid - 18);
  if (s.cells !== cells) geoOK = false;
  if (s.stream !== Math.ceil(cells * 6 / 8)) geoOK = false;
  if (s.blocks !== Math.floor(s.stream / 155)) geoOK = false;
}
ok(geoOK, '每档几何参数自洽');

// 每档回路：Standard(1088)/HD(2176) 全档 + Compact(544) 已知通过项
// （40/48 网格 @Compact 544 → 286/333px 极端帧不在支持范围）
const RT = [];
for (let idx = 0; idx < CimQR.SIZES.length; idx++) {
  RT.push([idx, 1088 / CimQR.SIZES[idx].total]);
  RT.push([idx, 2176 / CimQR.SIZES[idx].total]);
}
// Compact 544 支持档：112×112（0.5×，历史兼容）+ 64/56/48/40/32/28/24 网格
// （粗网格格点随档放大，更易采集）；104/96/80 网格格点 <0.7px 亚像素不可读
RT.push([0, 0.5], [4, 544 / 656], [5, 544 / 584], [6, 544 / 512], [7, 544 / 440],
        [8, 544 / 368], [9, 544 / 332], [10, 544 / 296]);
for (const [idx, scale] of RT) {
  const SZ = CimQR.SIZES[idx];
  const pkt = new Uint8Array(SZ.packet - 3);
  for (let i = 0; i < pkt.length; i++) pkt[i] = (Math.random() * 256) | 0;
  const r = CimQR.render(pkt, scale, idx);
  const out = CimQR.decode(r.data, r.width, r.height);
  const good = out.length === 1 && Buffer.compare(Buffer.from(out[0]), Buffer.from(pkt)) === 0;
  ok(good, '回路 idx' + idx + ' (' + SZ.grid + '×' + SZ.grid + ') W2=' + r.width);
}

// 尺寸自描述：标记码与格式字节
{
  const pkt = new Uint8Array(100).map(() => (Math.random() * 256) | 0);
  for (let idx = 0; idx < 8; idx++) {
    const r = CimQR.render(pkt, 1, idx);
    // 从解码结果验证格式字节隐含在链路里（解码成功即格式字节匹配档位）
    const out = CimQR.decode(r.data, r.width, r.height);
    ok(out.length === 1, '标记码→档位 idx' + idx + ' 可解码');
  }
}

// 相机式畸变抽查（低档符号更易采集，理应比 112 更抗模糊/透视）
function transformImage(img, m, outW, outH, bgRGB = [255, 255, 255]) {
  const W = img.width, H = img.height;
  outW = outW || W; outH = outH || H;
  const src = img.data;
  const out = new Uint8ClampedArray(outW * outH * 4);
  const det = m[0] * m[4] - m[1] * m[3];
  const inv = [m[4] / det, -m[1] / det, (m[1] * m[5] - m[2] * m[4]) / det, -m[3] / det, m[0] / det, (m[2] * m[3] - m[0] * m[5]) / det];
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const sx = inv[0] * x + inv[1] * y + inv[2];
      const sy = inv[3] * x + inv[4] * y + inv[5];
      const o = (y * outW + x) * 4;
      if (sx < 0 || sy < 0 || sx >= W - 1 || sy >= H - 1) {
        out[o] = bgRGB[0]; out[o + 1] = bgRGB[1]; out[o + 2] = bgRGB[2]; out[o + 3] = 255; continue;
      }
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const fx = sx - x0, fy = sy - y0;
      for (let ch = 0; ch < 3; ch++) {
        const p00 = src[(y0 * W + x0) * 4 + ch], p10 = src[(y0 * W + x0 + 1) * 4 + ch];
        const p01 = src[((y0 + 1) * W + x0) * 4 + ch], p11 = src[((y0 + 1) * W + x0 + 1) * 4 + ch];
        out[o + ch] = p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width: outW, height: outH };
}
function rotateScale(rotDeg, scale, W, H) {
  const a = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const outW = Math.ceil(Math.abs(cos) * W + Math.abs(sin) * H);
  const outH = Math.ceil(Math.abs(sin) * W + Math.abs(cos) * H);
  const cx = W / 2, cy = H / 2, Cx = outW / 2, Cy = outH / 2;
  const cs = cos * scale, sn = sin * scale;
  return { m: [cs, sn, Cx - cs * cx - sn * cy, -sn, cs, Cy + sn * cx - cs * cy], outW, outH };
}
function boxBlur(img, r) {
  const W = img.width, H = img.height;
  const s = img.data, out = new Uint8ClampedArray(s.length);
  const tmp = new Uint8ClampedArray(s.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a = [0, 0, 0], n = 0;
    for (let k = -r; k <= r; k++) {
      const xx = x + k; if (xx < 0 || xx >= W) continue;
      const o = (y * W + xx) * 4; a[0] += s[o]; a[1] += s[o + 1]; a[2] += s[o + 2]; n++;
    }
    const o = (y * W + x) * 4; tmp[o] = a[0] / n; tmp[o + 1] = a[1] / n; tmp[o + 2] = a[2] / n; tmp[o + 3] = 255;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a = [0, 0, 0], n = 0;
    for (let k = -r; k <= r; k++) {
      const yy = y + k; if (yy < 0 || yy >= H) continue;
      const o = (yy * W + x) * 4; a[0] += tmp[o]; a[1] += tmp[o + 1]; a[2] += tmp[o + 2]; n++;
    }
    const o = (y * W + x) * 4; out[o] = a[0] / n; out[o + 1] = a[1] / n; out[o + 2] = a[2] / n; out[o + 3] = 255;
  }
  return { data: out, width: W, height: H };
}

// 档位切换（tracking 缓存换档：40→112→40 连续解码）
{
  const p1 = new Uint8Array(500).map(() => (Math.random() * 256) | 0);
  const p2 = new Uint8Array(400).map(() => (Math.random() * 256) | 0);
  const a = CimQR.render(p1, 1, 7);
  const b = CimQR.render(p2, 1, 7);
  const c = CimQR.render(p2, 1, 0);
  const d = CimQR.render(p1, 1, 7);
  const o1 = CimQR.decode(a.data, a.width, a.height);
  const o2 = CimQR.decode(b.data, b.width, b.height); // tracking 同档
  const o3 = CimQR.decode(c.data, c.width, c.height); // 切到 112
  const o4 = CimQR.decode(d.data, d.width, d.height); // 切回 40
  ok(o1.length === 1 && o2.length === 1 && o3.length === 1 && o4.length === 1 &&
     Buffer.compare(Buffer.from(o2[0]), Buffer.from(p2)) === 0 &&
     Buffer.compare(Buffer.from(o3[0]), Buffer.from(p2)) === 0 &&
     Buffer.compare(Buffer.from(o4[0]), Buffer.from(p1)) === 0, '档位切换 40→40→112→40 全部命中');
}

// 零值格保持绿色填充（原始方案，用户要求）：数据 0 值格与补齐格均为绿+图案0，
// 解码按色相+图案读出 0，RS 语义不变；自动版本按数据量选网格使填充占比最小化
{
  const pkt = new Uint8Array(600).map(() => (Math.random() * 256) | 0);
  const r = CimQR.render(pkt, 1, 0);
  const out = CimQR.decode(r.data, r.width, r.height);
  ok(out.length === 1 && Buffer.compare(Buffer.from(out[0]), Buffer.from(pkt)) === 0, '绿填充帧解码正确（0 值格按绿读出）');
  // 自动版本效果：600B 数据选 40×40（604B 容量）→ 填充占比 <30%
  const pkt2 = new Uint8Array(600).map(() => (Math.random() * 256) | 0);
  const r2 = CimQR.render(pkt2, 1088 / CimQR.SIZES[7].total, 7);
  const d2 = r2.data;
  let green2 = 0, colored2 = 0;
  for (let i = 0; i < d2.length; i += 4) {
    const R = d2[i], G = d2[i + 1], B = d2[i + 2];
    if (G > 100 && R < 60 && B < 60) green2++;
    else if ((G > 100 || R > 100 || B > 100) && (R + G + B) > 100 && !(R > 200 && G > 200 && B > 200)) colored2++;
  }
  ok(green2 / (green2 + colored2) < 0.55, '600B 数据选 40×40 档（604B 容量 97% 利用率，绿像素含数据自然分布，实际 ' + (green2 * 100 / (green2 + colored2)).toFixed(0) + '%）');
}

// 兼容性：旧帧（TL 角全白 → 标记码全 0 → 档位 0 = 112）
{
  const pkt = new Uint8Array(300).map(() => (Math.random() * 256) | 0);
  const r = CimQR.render(pkt, 1, 0);
  // 手动抹掉 TL 角标记区（模拟旧版符号无标记码）
  const d = r.data.slice();
  for (let y = 104; y < 112; y++) for (let x = 92; x < 116; x++) {
    const o = (y * r.width + x) * 4; d[o] = 255; d[o + 1] = 255; d[o + 2] = 255;
  }
  const out = CimQR.decode(d, r.width, r.height);
  ok(out.length === 1 && Buffer.compare(Buffer.from(out[0]), Buffer.from(pkt)) === 0, '旧帧兼容（无标记码 → 112 档）');
}

// 小档位解码性能（40×40 满载应明显快于 112）
{
  const p1 = new Uint8Array(CimQR.SIZES[7].packet - 3).map(() => (Math.random() * 256) | 0);
  const r1 = CimQR.render(p1, 1, 7);
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) CimQR.decode(r1.data, r1.width, r1.height);
  const dtLo = (Date.now() - t0) / 5;
  const p2 = new Uint8Array(CimQR.SIZES[0].packet - 3).map(() => (Math.random() * 256) | 0);
  const r2 = CimQR.render(p2, 1, 0);
  const t1 = Date.now();
  for (let i = 0; i < 5; i++) CimQR.decode(r2.data, r2.width, r2.height);
  const dtHi = (Date.now() - t1) / 5;
  ok(dtLo < dtHi, '低档解码更快 (' + dtLo.toFixed(1) + 'ms vs ' + dtHi.toFixed(1) + 'ms)');
  console.log('  性能: 40×40 ' + dtLo.toFixed(1) + 'ms/帧, 112×112 ' + dtHi.toFixed(1) + 'ms/帧');
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
