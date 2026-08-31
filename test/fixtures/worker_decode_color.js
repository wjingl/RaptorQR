/* ============================================================================
 * CimQR — 彩色 cimbar/QR 混合编解码器（RaptorQR 彩色化核心）
 *
 * 设计要点（借鉴 libcimbar/sz3 与标准 QR）：
 *  1) 固定识别位置（沿用现有黑白的 QR 定位）：三个角寻像图形 1:1:3:1:1
 *     + 分隔带 + 顶部/左侧时序图形，全部为黑白高对比图形；
 *  2) 彩色数据区（cimbar 风格）：8×8 子图案（16 符号 = 4bit）+ 4 色
 *     （2bit）= 6bit/格，非纯色设计（每格是图案而非纯色块），抗模糊；
 *  3) 布局：112×112 网格（格 8px、间距 9px、偏移 8px），四角各 7×7 保留区
 *     （含寻像图形/时序），数据格 12152 个 → 9114 字节/帧；
 *  4) 纠错：GF(256) 本原多项式 0x187 的 RS(155,125,30)，58 个码字，
 *     数据按 155 分块、2 分区交织（抗局部损坏）；
 *  5) 帧内封装：[2B 长度][2B magic 0x51 0x43][1B 格式 0x01][4B 保留]
 *     + 传输包（RaptorQ 包裹包，长度 ≤7241），与现有协议完全兼容。
 *
 * 运行环境：浏览器/Worker/Node 通用（无依赖、无 import）。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CimQR = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- 常量 ----------
  var CELL = 8;        // 格子像素尺寸
  var PITCH = 9;       // 格子中心间距
  var OFFSET = 8;      // 网格起始偏移
  var GRID = 112;      // 每边格数
  var IMG = 1024;      // 符号像素尺寸
  var CP = 7;          // 四角保留区（格）
  var DATA_CELLS = 12032; // 数据格总数
  var HDR_CELLS = 12;  // 帧头占用格数（=9 字节）
  var RS_N = 155, RS_K = 125, RS_PARITY = 30;
  var COLOR_BITS = 2, SYMBOL_BITS = 4, BITS_PER_CELL = 6;
  var MAX_PACKET = 7241; // 单帧可承载的包裹包字节数（9B 帧头 + 7232 数据 → 58×125）
  var MAGIC = [0x51, 0x43]; // "QC"
  var FORMAT = 0x01;

  // 16 个 8×8 符号图案（行序 MSB→LSB，1=彩色点 0=背景）——取自 libcimbar 位图
  var PATTERNS = [
    0xfffefcf8f0e0c080n, 0x80c0e0f0f8fcfeffn, 0xff7f3f1f0f070301n, 0x0103070f1f3f7fffn,
    0x181818ffff181818n, 0x66e7e70000e7e766n, 0x3c7ee7c3c3e77e3cn, 0x18183c3c7e7effffn,
    0xc0f0fcfffffcf0c0n, 0xfffcf00000f0fcffn, 0xff3f0f00000f3fffn, 0xe7e7e7e7c3c38181n,
    0x8181c3c3e7e7e7e7n, 0x0000c3e77e3c1800n, 0x0c1c387070381c0cn, 0x1e1e38381c1c7878n
  ];

  // 4 色（暗底：黑色背景上亮色）——与 cimbar 色板一致
  var COLORS = [
    [0, 255, 0],     // 0 绿
    [0, 255, 255],   // 1 青
    [255, 255, 0],   // 2 黄
    [255, 0, 255]    // 3 品红
  ];

  // ---------- GF(256)（本原多项式 0x187）----------
  var gf = (function () {
    var exp = new Uint8Array(512), log = new Uint8Array(256), i, x = 1;
    for (i = 0; i < 255; i++) { exp[i] = x; log[x] = i; x <<= 1; if (x & 0x100) x ^= 0x187; }
    for (i = 255; i < 512; i++) exp[i] = exp[i - 255];
    return {
      exp: exp, log: log,
      mul: function (a, b) { return (a === 0 || b === 0) ? 0 : exp[log[a] + log[b]]; },
      div: function (a, b) { return a === 0 ? 0 : exp[(log[a] - log[b] + 255) % 255]; },
      pow: function (a, n) { return a === 0 ? 0 : exp[(log[a] * n) % 255]; },
      inv: function (a) { return exp[(255 - log[a]) % 255]; }
    };
  })();

  // RS 生成多项式 g(x) = Π(x - α^i)（i=1..parity，GF 中减法=加法）
  // 采用"翻转"系数表示：gen[j] 为 x^j 系数，gen[0]=1（首项），gen[parity]=常数项
  function gfPolyMul(p, q) {
    var res = new Array(p.length + q.length - 1).fill(0), i, j;
    for (i = 0; i < p.length; i++)
      for (j = 0; j < q.length; j++) res[i + j] ^= gf.mul(p[i], q[j]);
    return res;
  }
  function gfPolyScale(p, x) {
    var res = new Array(p.length), i;
    for (i = 0; i < p.length; i++) res[i] = gf.mul(p[i], x);
    return res;
  }
  function gfPolyAdd(p, q) {
    // 与 reedsolo 一致：多项式以"高次在前"存储，相加需右对齐（常数项对齐）
    var n = Math.max(p.length, q.length), res = new Array(n).fill(0), i;
    var offP = n - p.length, offQ = n - q.length;
    for (i = 0; i < p.length; i++) res[offP + i] = p[i];
    for (i = 0; i < q.length; i++) res[offQ + i] ^= q[i];
    return res;
  }
  function gfPolyEval(p, x) {
    var y = p[0], i;
    for (i = 1; i < p.length; i++) y = gf.mul(y, x) ^ p[i];
    return y;
  }
  var genPoly = (function () {
    var g = [1], i, r;
    for (i = 0; i < RS_PARITY; i++) {
      r = gf.pow(2, i + 1); // 根 α^(i+1)
      g = gfPolyMul(g, [1, r]); // (1 + r·x)
    }
    return g;
  })();

  // RS 编码：k 字节数据 → n 字节码字（系统码，前 k 为原数据）。
  // 与 reedsolo/教程一致：gen = Π(1+α^i·x) 直接取 gen[j]；合成除法会污染
  // info 的数据区，只取尾部 ECC，最终码字 = 原始数据 || ECC。
  function rsEncode(data) {
    var info = new Uint8Array(RS_N);
    info.set(data, 0);
    var i, j, coef;
    for (i = 0; i < RS_K; i++) {
      coef = info[i];
      if (coef !== 0) {
        for (j = 1; j <= RS_PARITY; j++) info[i + j] ^= gf.mul(genPoly[j], coef);
      }
    }
    var out = new Uint8Array(RS_N);
    out.set(data, 0);
    out.set(info.subarray(RS_K), RS_K);
    return out;
  }

  // 伴随式（reedsolo 约定，含前置 0 的移位形式）：[0, S_0..S_29]，
  // S_j 用 Horner 求值（p[0] 视为最高次，与编码约定一致）
  function calcSyndromes(code) {
    var syn = [0], i, j, s, x;
    for (i = 0; i < RS_PARITY; i++) {
      s = 0;
      x = gf.pow(2, i + 1);
      for (j = 0; j < RS_N; j++) s = gf.mul(s, x) ^ code[j];
      syn.push(s);
    }
    return syn;
  }

  // Berlekamp–Massey（reedsolo 形式；入参为去掉前置 0 的 forney 伴随式）
  function findErrorLocator(synd) {
    var syndShift = synd.length - RS_PARITY, errLoc = [1], oldLoc = [1], i, j, delta, newLoc;
    for (i = 0; i < RS_PARITY; i++) {
      var K = i + syndShift;
      delta = synd[K];
      for (j = 1; j < errLoc.length; j++) delta ^= gf.mul(errLoc[errLoc.length - 1 - j], synd[K - j]);
      oldLoc.push(0);
      if (delta !== 0) {
        if (oldLoc.length > errLoc.length) {
          newLoc = gfPolyScale(oldLoc, delta);
          oldLoc = gfPolyScale(errLoc, gf.inv(delta));
          errLoc = newLoc;
        }
        errLoc = gfPolyAdd(errLoc, gfPolyScale(oldLoc, delta));
      }
    }
    while (errLoc.length && errLoc[0] === 0) errLoc.shift(); // drop leading 0s
    if ((errLoc.length - 1) * 2 > RS_PARITY) return null;    // 超出纠错能力
    return errLoc;
  }

  function findErrors(errLoc, nmess) {
    var errPos = [], i;
    for (i = 0; i < nmess; i++) if (gfPolyEval(errLoc, gf.pow(2, i)) === 0) errPos.push(nmess - 1 - i);
    return errPos;
  }

  // 由错误位置构建 errata 定位多项式 Π(1 - α^pos·x)
  function findErrataLocator(coefPos) {
    var eLoc = [1], i;
    for (i = 0; i < coefPos.length; i++) eLoc = gfPolyMul(eLoc, gfPolyAdd([1], [gf.pow(2, coefPos[i]), 0]));
    return eLoc;
  }

  // 错误求值多项式 Omega = (Synd * ErrLoc) mod x^(nsym+1)
  function findErrorEvaluator(synd, errLoc, nsym) {
    var prod = gfPolyMul(synd, errLoc);
    return prod.slice(Math.max(0, prod.length - (nsym + 1)));
  }

  // Forney：由伴随式（含前置 0 的完整形式）与错误位置计算修正值
  function correctErrata(msg, synd, errPos) {
    var coefPos = [], i, j;
    for (i = 0; i < errPos.length; i++) coefPos.push(msg.length - 1 - errPos[i]);
    var errLoc = findErrataLocator(coefPos);
    var errEval = findErrorEvaluator(synd.slice().reverse(), errLoc, errLoc.length - 1).slice().reverse();
    var X = [], E = new Array(msg.length).fill(0);
    for (i = 0; i < coefPos.length; i++) X.push(gf.pow(2, coefPos[i]));
    for (i = 0; i < X.length; i++) {
      var Xi = X[i], XiInv = gf.inv(Xi);
      var errLocPrime = 1;
      for (j = 0; j < X.length; j++) if (j !== i) errLocPrime = gf.mul(errLocPrime, (1 ^ gf.mul(XiInv, X[j])));
      var y = gfPolyEval(errEval.slice().reverse(), XiInv);
      y = gf.mul(gf.pow(Xi, 0), y); // fcr=1 → α^(1-1) = α^0 = 1
      E[errPos[i]] = gf.div(y, errLocPrime);
    }
    for (i = 0; i < msg.length; i++) msg[i] ^= E[i];
    return msg;
  }

  // RS 解码：n 字节码字 → k 字节数据（可纠 ≤15 个错误），失败返回 null
  function rsDecode(code) {
    var synd = calcSyndromes(code), i, allZero = true;
    for (i = 1; i <= RS_PARITY; i++) if (synd[i]) { allZero = false; break; }
    if (allZero) return code.slice(0, RS_K);
    var fsynd = synd.slice(1); // 去掉前置 0（无擦除时 forney 伴随式即为此）
    var errLoc = findErrorLocator(fsynd);
    if (!errLoc) return null;
    var errPos = findErrors(errLoc.slice().reverse(), RS_N);
    if (errPos.length !== errLoc.length - 1) return null;
    var out = code.slice();
    correctErrata(out, synd, errPos);
    // 再验伴随式，防止误纠
    var synd2 = calcSyndromes(out);
    for (i = 1; i <= RS_PARITY; i++) if (synd2[i]) return null;
    return out.slice(0, RS_K);
  }

  // ---------- 格位置与交织 ----------
  // 数据格列表（行主序）：跳过四角块（7×7×4）与时序带（r=6/c=6）
  // → 112² - 196 - 196 = 12152 格
  var cellPos = (function () {
    // 四角保留区按寻像图形实际占格对齐：finder 覆盖符号 32..88 = 格 2..8
    // （旧版排除格 0..6 与 finder 右下重叠，低倍率 floor 量化下错误格超 RS 容量）
    var list = [], c, r;
    for (r = 0; r < GRID; r++) {
      for (c = 0; c < GRID; c++) {
        var corner = (c <= 8 && r <= 8) ||
                     (c >= GRID - 9 && r <= 8) ||
                     (c <= 8 && r >= GRID - 9) ||
                     (c >= GRID - 9 && r >= GRID - 9);
        var timing = (r === CP - 1 && c >= CP) || (c === CP - 1 && r >= CP);
        if (!corner && !timing) list.push(c + r * GRID);
      }
    }
    if (list.length !== DATA_CELLS) throw new Error("cellPos length mismatch: " + list.length + " vs " + DATA_CELLS);
    return list;
  })();

  // 交织排列：把流位置 k 映射到数据格列表下标 perm[k]
  var perm = (function () {
    var N = DATA_CELLS, parts = 2, chunks = RS_N;
    var p = [], partSize = Math.floor(N / parts), part, chunk, i;
    for (part = 0; part < parts; part++) {
      var base = part * partSize;
      var count = (part === parts - 1) ? N - base : partSize;
      for (chunk = 0; chunk < chunks; chunk++)
        for (i = chunk; i < count; i += chunks) p.push(base + i);
    }
    for (i = parts * partSize; i < N; i++) p.push(i);
    if (p.length !== N) throw new Error("perm length mismatch");
    var seen = new Uint8Array(N), k;
    for (k = 0; k < N; k++) { if (seen[p[k]]) throw new Error("perm not injective"); seen[p[k]] = 1; }
    return p;
  })();

  var invPerm = (function () {
    var inv = new Uint32Array(DATA_CELLS), i;
    for (i = 0; i < DATA_CELLS; i++) inv[perm[i]] = i;
    return inv;
  })();

  // ---------- 位流 ----------
  function BitWriter() { this.bits = []; this.acc = 0; this.n = 0; }
  BitWriter.prototype.write = function (val, nbits) {
    // MSB-first 写入
    for (var i = nbits - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((val >> i) & 1);
      if (++this.n === 8) { this.bits.push(this.acc); this.acc = 0; this.n = 0; }
    }
  };
  BitWriter.prototype.finish = function () {
    if (this.n > 0) { this.bits.push(this.acc << (8 - this.n)); this.n = 0; }
    return this.bits;
  };
  function BitReader(bytes) {
    this.bytes = bytes; this.pos = 0;
  }
  BitReader.prototype.read = function (nbits) {
    var val = 0;
    for (var i = 0; i < nbits; i++) {
      var bitPos = this.pos++;
      var b = this.bytes[bitPos >> 3];
      val = (val << 1) | ((b >> (7 - (bitPos & 7))) & 1);
    }
    return val;
  };

  // ---------- 渲染 ----------
  // 预生成 64 张 8×8 瓦片（16 图案 × 4 色）RGBA
  var tileCache = (function () {
    var tiles = [], s, cl, x, y;
    for (cl = 0; cl < 4; cl++) {
      var col = COLORS[cl], arr = [];
      for (s = 0; s < 16; s++) {
        var t = new Uint8ClampedArray(8 * 8 * 4);
        for (y = 0; y < 8; y++) {
          var rowMask = Number((PATTERNS[s] >> BigInt(56 - y * 8)) & BigInt(0xff));
          for (x = 0; x < 8; x++) {
            var o = (y * 8 + x) * 4;
            if (rowMask & (0x80 >> x)) { t[o] = col[0]; t[o + 1] = col[1]; t[o + 2] = col[2]; }
            t[o + 3] = 255;
          }
        }
        arr.push(t);
      }
      tiles.push(arr);
    }
    return tiles;
  })();

  function drawFinder(buf, x0, y0, stride, R) {
    // 7×7 寻像图形，每模块 8px（×R 缩放）
    R = R || 1;
    for (var y = 0; y < 7; y++) {
      for (var x = 0; x < 7; x++) {
        var dark = (y === 0 || y === 6 || x === 0 || x === 6) || (y >= 2 && y <= 4 && x >= 2 && x <= 4);
        var v = dark ? 0 : 255;
        for (var py = 0; py < 8 * R; py++)
          for (var px = 0; px < 8 * R; px++) {
            var o = ((y0 + y * 8 * R + py) * stride + (x0 + x * 8 * R + px)) * 4;
            buf[o] = v; buf[o + 1] = v; buf[o + 2] = v; buf[o + 3] = 255;
          }
      }
    }
  }

  function drawSolid(buf, x0, y0, w, h, v, stride) {
    for (var y = 0; y < h; y++)
      for (var x = 0; x < w; x++) {
        var o = ((y0 + y) * stride + (x0 + x)) * 4;
        buf[o] = v; buf[o + 1] = v; buf[o + 2] = v; buf[o + 3] = 255;
      }
  }

  // 白色静区（QR 4 模块 quiet zone），保证寻像图形外边框不与外界深色合并
  var MARGIN = 32, RENDER_IMG = IMG + 2 * MARGIN;
  var CimQR_POP8 = null;

  function renderFrame(packet, scale) {
    var R = scale || 1; // 渲染倍率：1=1088px，0.5=544px（紧凑），2=2176px（高清）
    var W2 = Math.round(RENDER_IMG * R);
    var buf = new Uint8ClampedArray(W2 * W2 * 4);
    var x, y, o;
    // 背景白（静区）
    for (o = 0; o < buf.length; o += 4) { buf[o] = 255; buf[o + 1] = 255; buf[o + 2] = 255; buf[o + 3] = 255; }
    var M = Math.round(MARGIN * R);

    // 三个寻像图形
    drawFinder(buf, M, M, W2, R);                                      // TL
    drawFinder(buf, M + Math.floor((IMG - 64) * R), M, W2, R);         // TR
    drawFinder(buf, M, M + Math.floor((IMG - 64) * R), W2, R);         // BL
    // 分隔带（白）
    drawSolid(buf, M + Math.floor(56 * R), M, Math.floor(8 * R), Math.floor(64 * R), 255, W2);
    drawSolid(buf, M, M + Math.floor(56 * R), Math.floor(64 * R), Math.floor(8 * R), 255, W2);
    drawSolid(buf, M + Math.floor(952 * R), M, Math.floor(8 * R), Math.floor(64 * R), 255, W2);
    drawSolid(buf, M + Math.floor(960 * R), M + Math.floor(56 * R), Math.floor(64 * R), Math.floor(8 * R), 255, W2);
    drawSolid(buf, M, M + Math.floor(952 * R), Math.floor(64 * R), Math.floor(8 * R), 255, W2);
    drawSolid(buf, M + Math.floor(56 * R), M + Math.floor(960 * R), Math.floor(8 * R), Math.floor(64 * R), 255, W2);

    // 时序图形（顶部 y=56..64，x=64..952；左侧 x=56..64，y=64..952）黑白交替
    for (var k = 0; k < 111; k++) {
      var dk = (k % 2 === 0);
      if (64 + k * 8 < 952) drawSolid(buf, M + Math.floor((64 + k * 8) * R), M + Math.floor(56 * R), Math.floor(8 * R), Math.floor(8 * R), dk ? 0 : 255, W2);
      if (64 + k * 8 < 952) drawSolid(buf, M + Math.floor(56 * R), M + Math.floor((64 + k * 8) * R), Math.floor(8 * R), Math.floor(8 * R), dk ? 0 : 255, W2);
    }
    // BR 辅助标记（QR 对齐图案 5×5，不影响数据格——该区域被排除）
    {
      var bx = Math.floor(952 * R), by = Math.floor(952 * R);
      for (y = 0; y < 5; y++)
        for (x = 0; x < 5; x++) {
          var bd = (y === 0 || y === 4 || x === 0 || x === 4) || (y === 2 && x === 2);
          var bv = bd ? 0 : 255;
          drawSolid(buf, M + bx + Math.floor(x * 8 * R), M + by + Math.floor(y * 8 * R), Math.floor(8 * R), Math.floor(8 * R), bv, W2);
        }
    }

    // 数据流：帧头 + 包裹包 → RS → 交织 → 6bit/格
    var hdr = new Uint8Array(9);
    hdr[0] = packet.length & 255; hdr[1] = (packet.length >> 8) & 255;
    hdr[2] = MAGIC[0]; hdr[3] = MAGIC[1]; hdr[4] = FORMAT;
    // [5..8] 保留 0
    var rsData = new Uint8Array(58 * RS_K);
    rsData.set(hdr, 0);
    rsData.set(packet, 9);
    // 逐块 RS 编码
    var coded = new Uint8Array(58 * RS_N);
    for (var blk = 0; blk < 58; blk++) {
      var cw = rsEncode(rsData.subarray(blk * RS_K, blk * RS_K + RS_K));
      coded.set(cw, blk * RS_N);
    }
    // 补齐到格流字节数（9105）
    var streamBytes = new Uint8Array(Math.ceil(DATA_CELLS * BITS_PER_CELL / 8));
    streamBytes.set(coded, 0);
    // 写入格值
    var bw = new BitWriter();
    for (var i = 0; i < streamBytes.length; i++) bw.write(streamBytes[i], 8);
    var bitArr = bw.finish();
    var cellVals = new Uint8Array(DATA_CELLS);
    var br = new BitReader(streamBytes);
    for (i = 0; i < DATA_CELLS; i++) cellVals[i] = br.read(BITS_PER_CELL);

    // 绘制数据格（流位置 i → 数据格下标 perm[i] → 网格坐标）
    // 交集规则：图像像素 k 显示"其符号区间 [floor((k-M)/R), floor((k-M)/R)+1/R) 与格符号范围
    // 交集下界"对应的 tile 像素——与解码端 floor(M+符号×R) 采样精确对齐，任意 R 一致
    for (i = 0; i < DATA_CELLS; i++) {
      var gridIdx = cellPos[perm[i]];
      var cc = gridIdx % GRID, cr = (gridIdx / GRID) | 0;
      var v = cellVals[i];
      var tile = tileCache[v >> SYMBOL_BITS][v & 15];
      var x0 = M + Math.floor((OFFSET + cc * PITCH) * R), y0 = M + Math.floor((OFFSET + cr * PITCH) * R);
      var gsx = OFFSET + cc * PITCH, gsy = OFFSET + cr * PITCH;
      var span = Math.ceil(8 * R) + 1;
      var invR = 1 / R;
      for (var ky = y0; ky < y0 + span; ky++) {
        var sY = Math.floor((ky - M) / R);
        // 区间重叠判定：像素符号区间 [sY, sY+invR) 与格 [gsy, gsy+8) 相交
        if (sY + invR <= gsy || sY >= gsy + 8) continue;
        var tY = Math.max(sY, gsy) - gsy;
        for (var kx = x0; kx < x0 + span; kx++) {
          var sX = Math.floor((kx - M) / R);
          if (sX + invR <= gsx || sX >= gsx + 8) continue;
          var tX = Math.max(sX, gsx) - gsx;
          var ti = (tY * 8 + tX) * 4;
          if (tile[ti + 3]) {
            var o = (ky * W2 + kx) * 4;
            buf[o] = tile[ti]; buf[o + 1] = tile[ti + 1]; buf[o + 2] = tile[ti + 2]; buf[o + 3] = 255;
          }
        }
      }
    }
    return { data: buf, width: W2, height: W2 };
  }

  // ---------- 解码 ----------
  // 寻像图形检测（旋转鲁棒）：行扫描 1:1:3:1:1 → 相邻行验证（不再依赖轴对齐十字）
  // 比例判定：中间暗段≈3模块、两侧亮段≈1模块、首尾暗段≥0.5模块（允许与背景合并变长）
  function ratioOK(lens) {
    var m = lens[2] / 3;
    if (m < 1) return false;
    // 中间暗≈3m、两侧亮≈1m、首尾暗≈1m（符号自带白色静区，边框不会被合并）
    return lens[1] >= m * 0.5 && lens[1] <= m * 2.5 &&
      lens[3] >= m * 0.5 && lens[3] <= m * 2.5 &&
      lens[0] >= m * 0.5 && lens[0] <= m * 3 &&
      lens[4] >= m * 0.5 && lens[4] <= m * 3;
  }
  // 在指定行找 1:1:3:1:1，返回中心与模块（无则 null）；cx 为预期中心（用于就近匹配）
  function matchRow(gray, w, y, cx, module, thr) {
    var prevDark = null, run = 0, x, runs = [];
    var base = y * w;
    for (x = 0; x < w; x++) {
      var dark = gray[base + x] < thr;
      if (prevDark === null) { prevDark = dark; run = 1; }
      else if (dark === prevDark) run++;
      else { runs.push({ d: prevDark, l: run }); prevDark = dark; run = 1; }
    }
    if (run > 0) runs.push({ d: prevDark, l: run });
    var best = null, bestDist = Infinity;
    for (var i = 0; i + 4 < runs.length; i++) {
      if (!(runs[i].d && !runs[i + 1].d && runs[i + 2].d && !runs[i + 3].d && runs[i + 4].d)) continue;
      var lens = [runs[i].l, runs[i + 1].l, runs[i + 2].l, runs[i + 3].l, runs[i + 4].l];
      var m = lens[2] / 3;
      if (m < 1.5 || (module && (m < module * 0.5 || m > module * 2))) continue;
      if (!ratioOK(lens)) continue;
      var startX = 0;
      for (var j = 0; j < i; j++) startX += runs[j].l;
      var cxm = startX + lens[0] + lens[1] + lens[2] / 2;
      var d = Math.abs(cxm - (cx === undefined ? cxm : cx));
      if (d < bestDist && d < (module || m) * 2.5) { bestDist = d; best = { x: cxm, module: m }; }
    }
    return best;
  }
  // 在指定列找 1:1:3:1:1（用于精化）
  function matchCol(gray, w, h, col, cy, module, thr) {
    var prevDark = null, run = 0, y, runs = [];
    for (y = 0; y < h; y++) {
      var dark = gray[y * w + col] < thr;
      if (prevDark === null) { prevDark = dark; run = 1; }
      else if (dark === prevDark) run++;
      else { runs.push({ d: prevDark, l: run }); prevDark = dark; run = 1; }
    }
    if (run > 0) runs.push({ d: prevDark, l: run });
    var best = null, bestDist = Infinity;
    for (var i = 0; i + 4 < runs.length; i++) {
      if (!(runs[i].d && !runs[i + 1].d && runs[i + 2].d && !runs[i + 3].d && runs[i + 4].d)) continue;
      var lens = [runs[i].l, runs[i + 1].l, runs[i + 2].l, runs[i + 3].l, runs[i + 4].l];
      var m = lens[2] / 3;
      if (m < 1.5 || (module && (m < module * 0.5 || m > module * 2))) continue;
      if (!ratioOK(lens)) continue;
      var startY = 0;
      for (var j = 0; j < i; j++) startY += runs[j].l;
      var cym = startY + lens[0] + lens[1] + lens[2] / 2;
      var d = Math.abs(cym - (cy === undefined ? cym : cy));
      if (d < bestDist && d < (module || m) * 2.5) { bestDist = d; best = { y: cym, module: m }; }
    }
    return best;
  }

  // 单遍行扫描 + 行间投票检测寻像图形（1:1:3:1:1）：
  // - 不逐候选做整行二次扫描（旧版每候选 3×O(w)，候选多时秒级）
  // - 不做 O(n²) 合并；相邻行投票自然去重并给出亚像素质心
  function detectFinders(gray, w, h) {
    var thr = 120, MIN_MODULE = 2.0;
    var acc = [];   // 正在累积的候选 {x, module, y, n}
    var out = [];
    var x, y, j;
    for (y = 0; y < h; y++) {
      var line = scanFinderRow(gray, w, y, thr, MIN_MODULE);
      // 与累积候选匹配（中心与模块尺寸接近）
      var nextAcc = [];
      for (j = 0; j < acc.length; j++) {
        var c = acc[j], best2 = -1;
        for (var k = 0; k < line.length; k++) {
          var l = line[k];
          if (Math.abs(l.x - c.x) <= c.module * 1.6 && Math.abs(l.module - c.module) <= c.module * 0.6) {
            if (best2 < 0 || Math.abs(l.x - c.x) < Math.abs(line[best2].x - c.x)) best2 = k;
          }
        }
        if (best2 >= 0) {
          c.n++; c.x = (c.x * (c.n - 1) + line[best2].x) / c.n;
          c.module = (c.module * (c.n - 1) + line[best2].module) / c.n;
          c.y = (c.y * (c.n - 1) + y) / c.n;
          nextAcc.push(c);
          line.splice(best2, 1);
        } else if (c.n >= 3) {
          out.push({ x: c.x, y: c.y, module: c.module, n: c.n });
        }
        // n<3 且失配：噪音，丢弃
      }
      for (j = 0; j < line.length; j++) {
        var l2 = line[j];
        nextAcc.push({ x: l2.x, module: l2.module, y: y, n: 1 });
      }
      acc = nextAcc;
    }
    for (j = 0; j < acc.length; j++) if (acc[j].n >= 3) out.push({ x: acc[j].x, y: acc[j].y, module: acc[j].module, n: acc[j].n });
    return out;
  }

  // 单行扫描，返回该行所有 1:1:3:1:1 图案中心（无对象化 run 编码，栈式累积）
  function scanFinderRow(gray, w, y, thr, minModule) {
    var base = y * w;
    var d0 = 0, l0 = 0, d1 = 0, l1 = 0, d2 = 0, l2 = 0, d3 = 0, l3 = 0, d4 = 0, l4 = 0;
    var have = 0; // 已编码 run 段数（0..4 环形缓冲）
    var out = [];
    var prevDark = -1, run = 0;
    var x;
    for (x = 0; x < w; x++) {
      var dark = gray[base + x] < thr ? 1 : 0;
      if (prevDark === -1) { prevDark = dark; run = 1; continue; }
      if (dark === prevDark) { run++; continue; }
      // 段结束：推入环形缓冲
      if (have < 5) {
        if (have === 0) { d0 = prevDark; l0 = run; }
        else if (have === 1) { d1 = prevDark; l1 = run; }
        else if (have === 2) { d2 = prevDark; l2 = run; }
        else if (have === 3) { d3 = prevDark; l3 = run; }
        else { d4 = prevDark; l4 = run; }
        have++;
      } else {
        d0 = d1; l0 = l1; d1 = d2; l1 = l2; d2 = d3; l2 = l3; d3 = d4; l3 = l4; d4 = prevDark; l4 = run;
      }
      prevDark = dark; run = 1;
      // 检查当前 5 段是否 1:1:3:1:1（暗亮暗亮暗）
      if (have === 5 && d0 && !d1 && d2 && !d3 && d4) {
        var m = l2 / 3;
        if (m >= minModule && l1 >= m * 0.5 && l1 <= m * 2.5 && l3 >= m * 0.5 && l3 <= m * 2.5 &&
            l0 >= m * 0.5 && l0 <= m * 3 && l4 >= m * 0.5 && l4 <= m * 3) {
          out.push({ x: x - run - l4 - l3 - l2 / 2, module: m });
        }
      }
    }
    // 行尾 flush 最后一段
    if (prevDark !== -1 && have === 5) {
      if (have === 5) {
        d0 = d1; l0 = l1; d1 = d2; l1 = l2; d2 = d3; l2 = l3; d3 = d4; l3 = l4; d4 = prevDark; l4 = run;
        if (d0 && !d1 && d2 && !d3 && d4) {
          var m2 = l2 / 3;
          if (m2 >= minModule && l1 >= m2 * 0.5 && l1 <= m2 * 2.5 && l3 >= m2 * 0.5 && l3 <= m2 * 2.5 &&
              l0 >= m2 * 0.5 && l0 <= m2 * 3 && l4 >= m2 * 0.5 && l4 <= m2 * 3) {
            out.push({ x: w - run - l4 - l3 - l2 / 2, module: m2 });
          }
        }
      }
    }
    return out;
  }

  // 从候选里选三个寻像图形（L 形：直角顶点为 TL）
  // 高效：按模块尺寸降序取前 K 个（真实寻像图形模块最大），再穷举几何约束
  function selectTriple(cands) {
    if (cands.length < 3) return null;
    var sorted = cands.slice().sort(function (a, b) { return b.module - a.module; });
    var top = sorted.slice(0, Math.min(14, sorted.length));
    var best = null, bestScore = Infinity, i, j, k, p;
    for (i = 0; i < top.length; i++)
      for (j = i + 1; j < top.length; j++)
        for (k = j + 1; k < top.length; k++) {
          var a = top[i], b = top[j], c = top[k];
          var pairs = [[a, b, c], [b, a, c], [c, a, b]];
          var bp = null, ps = Infinity;
          for (p = 0; p < pairs.length; p++) {
            var t = pairs[p][0], u = pairs[p][1], v = pairs[p][2];
            var d1 = Math.hypot(u.x - t.x, u.y - t.y);
            var d2 = Math.hypot(v.x - t.x, v.y - t.y);
            if (d1 < 10 || d2 < 10) continue;
            var d = dot(t, u, v);
            var legRatio = Math.abs(d1 - d2) / Math.max(d1, d2);
            var mRatio = Math.abs(t.module - u.module) / Math.max(t.module, u.module) + Math.abs(t.module - v.module) / Math.max(t.module, v.module);
            var modRatioOK = d1 / t.module > 60 && d1 / t.module < 220;
            if (Math.abs(d) > 0.2 || legRatio > 0.25 || mRatio > 0.3 || !modRatioOK) continue;
            var sc = Math.abs(d) + legRatio * 2 + mRatio;
            if (sc < ps) { ps = sc; bp = [t, u, v]; }
          }
          if (!bp) continue;
          var tl = bp[0], u2 = bp[1], v2 = bp[2];
          var dx1 = u2.x - tl.x, dy1 = u2.y - tl.y;
          var dx2 = v2.x - tl.x, dy2 = v2.y - tl.y;
          var cross = dx1 * dy2 - dy1 * dx2;
          if (Math.abs(cross) < 1e-6) continue;
          // 按手性确定 TR/BL：标准朝向（含旋转）下 cross(v_tr, v_bl) > 0
          var tr = cross > 0 ? u2 : v2;
          var bl = cross > 0 ? v2 : u2;
          var mod3 = (tl.module + tr.module + bl.module) / 3;
          if (ps < bestScore) {
            bestScore = ps;
            best = { tl: tl, tr: tr, bl: bl, module: mod3, orient: cross > 0 ? 1 : -1 };
          }
        }
    return best;
  }

  function dot(a, b, c) {
    return ((b.x - a.x) * (c.x - a.x) + (b.y - a.y) * (c.y - a.y)) / (Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - a.x, c.y - a.y));
  }

  // 四点透视变换（DLT）：求解 8 参数单应 H
  function solveHomography(src, dst) {
    var A = [], i, j;
    for (i = 0; i < 4; i++) {
      var sx = src[i][0], sy = src[i][1], dx = dst[i][0], dy = dst[i][1];
      A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]);
      A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]);
    }
    // 高斯消元解 A·h = [dx0,dy0,dx1,dy1,dx2,dy2,dx3,dy3]
    var b = [], h = new Array(8).fill(0);
    for (i = 0; i < 4; i++) { b.push(dst[i][0]); b.push(dst[i][1]); }
    var m = A.map(function (row, r) { return row.concat([b[r]]); });
    for (i = 0; i < 8; i++) {
      var pivot = i;
      for (j = i + 1; j < 8; j++) if (Math.abs(m[j][i]) > Math.abs(m[pivot][i])) pivot = j;
      if (pivot !== i) { var tmp = m[i]; m[i] = m[pivot]; m[pivot] = tmp; }
      if (Math.abs(m[i][i]) < 1e-10) return null;
      for (j = i + 1; j < 8; j++) {
        var f = m[j][i] / m[i][i];
        for (var k = i; k < 9; k++) m[j][k] -= f * m[i][k];
      }
    }
    for (i = 7; i >= 0; i--) {
      h[i] = m[i][8];
      for (j = i + 1; j < 8; j++) h[i] -= m[i][j] * h[j];
      h[i] /= m[i][i];
    }
    return { h: h, map: function (x, y) {
      var d = h[6] * x + h[7] * y + 1;
      return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
    } };
  }

  // 全分辨率精化寻像中心：局部窗口内双向 run 匹配（行向修正 x、列向修正 y），
  // 对初始估计误差鲁棒（窗口覆盖 ±3.2m，全行扫描的 1/20 开销）
  function refineFinder(gray, w, h, cx, cy, module) {
    var thr = 120, i, j;
    // 行向窗口 run 收集 + 找 1:1:3:1:1 中心（局部变量 i2/j2，勿用外层 i/j 避免闭包冲突）
    function scanWindow(axis, fix, lo, hi) {
      var runsD = [], runsL = [], prevDark = -1, run = 0;
      var i2, j2, p;
      for (p = lo; p <= hi; p++) {
        var g = axis === 0 ? gray[fix * w + p] : gray[p * w + fix];
        var dark = g < thr ? 1 : 0;
        if (prevDark === -1) { prevDark = dark; run = 1; }
        else if (dark === prevDark) run++;
        else { runsD.push(prevDark); runsL.push(run); prevDark = dark; run = 1; }
      }
      if (prevDark !== -1) { runsD.push(prevDark); runsL.push(run); }
      var best = null, bestM = 0;
      for (i2 = 0; i2 + 4 < runsD.length; i2++) {
        if (!(runsD[i2] && !runsD[i2 + 1] && runsD[i2 + 2] && !runsD[i2 + 3] && runsD[i2 + 4])) continue;
        var m = runsL[i2 + 2] / 3;
        if (m < 1.5 || m < bestM) continue;
        if (!(runsL[i2 + 1] >= m * 0.5 && runsL[i2 + 1] <= m * 2.5 && runsL[i2 + 3] >= m * 0.5 && runsL[i2 + 3] <= m * 2.5 &&
              runsL[i2] >= m * 0.5 && runsL[i2] <= m * 3 && runsL[i2 + 4] >= m * 0.5 && runsL[i2 + 4] <= m * 3)) continue;
        var start = 0;
        for (j2 = 0; j2 < i2; j2++) start += runsL[j2];
        var c = lo + start + runsL[i2] + runsL[i2 + 1] + m * 1.5; // 全局坐标（窗口起点 lo 偏移）
        if (Math.abs(c - (axis === 0 ? cx : cy)) > m * 2.5) continue; // 窗口内就近匹配
        best = c; bestM = m;
      }
      return best === null ? null : { c: best, m: bestM };
    }
    var R = 3.2 * module;
    // 行向：3 行投票修正 x（module 一并更新）
    var accX = 0, accW = 0, modSum = 0, modN = 0;
    for (j = -1; j <= 1; j++) {
      var ry = Math.round(cy + j * module * 0.7);
      if (ry < 0 || ry >= h) continue;
      var mh = scanWindow(0, ry, Math.max(0, Math.round(cx - R)), Math.min(w - 1, Math.round(cx + R)));
      if (mh) { accX += mh.c; accW++; modSum += mh.m; modN++; }
    }
    if (accW < 2) return null;
    var rx = accX / accW, mod2 = modSum / modN;
    // 列向：3 列投票修正 y
    var accY = 0; accW = 0;
    for (j = -1; j <= 1; j++) {
      var cx2 = Math.round(rx + j * mod2 * 0.7);
      if (cx2 < 0 || cx2 >= w) continue;
      var mv = scanWindow(1, cx2, Math.max(0, Math.round(cy - R)), Math.min(h - 1, Math.round(cy + R)));
      if (mv) { accY += mv.c; accW++; }
    }
    if (accW < 2) return null;
    return { x: rx, y: accY / accW };
  }

  // 模板缓存：按 NSP/INNER/低倍率 分档；低倍率（cellPx<5.5，如 0.5 倍渲染）下格起点奇偶
  // 导致采样像素与符号 floor 错位 1，按 x/y 奇偶生成 4 套模板与渲染交集法精确一致
  // 检测缓存：同帧同 SCALE 复用 finder 候选（阶梯各层同降采样尺寸时省重复检测/精化）
  var detToken = 0, detCacheKey = '', detCands = [];
  var tplCacheMap = {};
  function getTpls(NSP, INNER, lowRes) {
    var key = NSP + '_' + INNER + '_' + (lowRes ? 'L' : 'H');
    if (tplCacheMap[key]) return tplCacheMap[key];
    var tpls = [], softLits = [];
    for (var parity = 0; parity < 4; parity++) {
      var pxp = parity & 1, pyp = parity >> 1;
      var tpl = [], softLit = [];
      for (var s = 0; s < 16; s++) {
        var hi = 0, lo = 0, mhi = 0, mlo = 0, lc = 0;
        for (var sp = 0; sp < NSP * NSP; sp++) {
          var pxv = (8 - INNER) / 2 + ((sp % NSP) + 0.5) / NSP * INNER;
          var pyv = (8 - INNER) / 2 + ((sp / NSP | 0) + 0.5) / NSP * INNER;
          var spx, spy;
          if (lowRes) {
            var kx = Math.floor((pxp + pxv) * 0.5);
            spx = Math.min(7, Math.max(2 * kx, pxp) - pxp);
            var ky = Math.floor((pyp + pyv) * 0.5);
            spy = Math.min(7, Math.max(2 * ky, pyp) - pyp);
          } else {
            spx = Math.min(7, Math.floor(pxv));
            spy = Math.min(7, Math.floor(pyv));
          }
          var bit = Number((PATTERNS[s] >> BigInt(63 - (spy * 8 + spx))) & 1n);
          hi = (hi << 1) | ((lo >>> 31) & 1);
          lo = ((lo << 1) | bit) >>> 0;
          mhi = (mhi << 1) | ((mlo >>> 31) & 1);
          mlo = ((mlo << 1) | bit) >>> 0;
          if (bit) lc++;
        }
        tpl.push([hi >>> 0, lo]);
        softLit.push([mhi >>> 0, mlo, lc]);
      }
      tpls.push(tpl);
      softLits.push(softLit);
    }
    var r = { tpls: tpls, softLits: softLits };
    tplCacheMap[key] = r;
    return r;
  }

  // 单次解码尝试：detTarget=检测用降采样目标边长，INNER=格内采样跨度（越小越抗模糊/混色），
  // soft=软判决匹配，useMarker=用 BR 对齐标记作第 4 角点（否则平行四边形估计）
  function decodeAttempt(rgba, w, h, detTarget, INNER, soft, useMarker) {
    // 灰度
    var gray = new Uint8Array(w * h);
    var i, o = 0;
    for (i = 0; i < w * h; i++, o += 4)
      gray[i] = (rgba[o] * 299 + rgba[o + 1] * 587 + rgba[o + 2] * 114) / 1000;

    // 检测降采样目标按帧尺寸自适应：并行网格大画布（如 2176×2176）每符号像素被摊薄，
    // 检测目标随帧边长同比例提升（基准 768 → detTarget，下限 512 上限 2048）
    var effDet = Math.max(512, Math.min(2048, Math.round(detTarget * Math.max(w, h) / 1088)));
    var SCALE = Math.min(1, effDet / Math.max(w, h));
    // 若图像过大，先缩小检测（detectFinders 直接在灰度上跑，此处按需）
    var sw = w, sh = h, sg = gray;
    var dw = w, dh = h, dg = gray;
    if (SCALE < 1) {
      dw = Math.max(1, Math.round(w * SCALE));
      dh = Math.max(1, Math.round(h * SCALE));
      dg = new Uint8Array(dw * dh);
      for (var yy = 0; yy < dh; yy++) {
        var sy = Math.min(h - 1, Math.round(yy / SCALE));
        for (var xx = 0; xx < dw; xx++) {
          var sx = Math.min(w - 1, Math.round(xx / SCALE));
          dg[yy * dw + xx] = gray[sy * w + sx];
        }
      }
    }
    var dk = detToken + '_' + dw + '_' + dh;
    if (detCacheKey !== dk) { detCands = detectFinders(dg, dw, dh); detCacheKey = dk; }
    var cands = detCands;
    if (typeof self !== "undefined" && self.__CIMQR_DEBUG__) self.__CIMQR_DEBUG__({ phase: 'det', cands: cands.slice(0, 12).map(function(c){return {x:+c.x.toFixed(1), y:+c.y.toFixed(1), m:+c.module.toFixed(2), n:c.n};}) });
    if (cands.length < 3) return [];
    // —— 多符号并行：同一帧可含多个 CimQR 符号（网格布局），逐符号解码，解完移除其寻像候选 ——
    var packets = [];
    var MAX_SYMBOLS = 8;
    var firstH = null;
    for (var symN = 0; symN < MAX_SYMBOLS; symN++) {
    var sel = selectTriple(cands);
    if (!sel) break;
    var mod = sel.module;
    // 放大回原图坐标
    var tl = { x: sel.tl.x / SCALE, y: sel.tl.y / SCALE };
    var tr = { x: sel.tr.x / SCALE, y: sel.tr.y / SCALE };
    var bl = { x: sel.bl.x / SCALE, y: sel.bl.y / SCALE };
    var modFull = mod / SCALE;
    // 全分辨率精化寻像中心（缩小检测会引入亚像素误差，直接放大误差放大）
    tl = refineFinder(gray, w, h, tl.x, tl.y, modFull);
    tr = refineFinder(gray, w, h, tr.x, tr.y, modFull);
    bl = refineFinder(gray, w, h, bl.x, bl.y, modFull);
    if (!tl || !tr || !bl) { cands = dropTriple(cands, sel); continue; }
    // 四个符号角点（寻像中心在符号坐标）
    var symTL = [28, 28], symTR = [988, 28], symBL = [28, 988], symBR = [988, 988];
    var imgTL = [tl.x, tl.y], imgTR = [tr.x, tr.y], imgBL = [bl.x, bl.y];
    // BR 用平行四边形估计
    var imgBR = [tl.x + (tr.x - tl.x) + (bl.x - tl.x), tl.y + (tr.y - tl.y) + (bl.y - tl.y)];
    var H = solveHomography([symTL, symTR, symBL, symBR], [imgTL, imgTR, imgBL, imgBR]);
    if (!H) { cands = dropTriple(cands, sel); continue; }
    // BR 对齐标记精化：检测第 4 角的真实位置（5×5 对齐图案，符号坐标中心 972,972），
    // 用 4 个真实角点重解单应 → 透视不再是平行四边形近似。
    // 判据：中心暗 + 半径 1 mod 处 8 点白色环带（数据区不存在 18px 宽白域，强区分）
    if (useMarker) try {
      var p0 = H.map(972, 972);
      var mstride = w * 4; // 注意：不能用的 stride（此处尚未赋值，var 提升为 undefined）
      var markC = null;
      var SR2 = 5.2 * modFull;
      var bx0 = Math.max(2, Math.round(p0[0] - SR2)), bx1 = Math.min(w - 3, Math.round(p0[0] + SR2));
      var by0 = Math.max(2, Math.round(p0[1] - SR2)), by1 = Math.min(h - 3, Math.round(p0[1] + SR2));
      var best2 = null, bestScore2 = -1;
      for (var cy2 = by0; cy2 <= by1; cy2 += 2)
        for (var cx2 = bx0; cx2 <= bx1; cx2 += 2) {
          var o5 = cy2 * mstride + cx2 * 4;
          var l5 = (rgba[o5] * 299 + rgba[o5 + 1] * 587 + rgba[o5 + 2] * 114) / 1000;
          if (l5 >= 110) continue;
          var hits5 = 0;
          for (var a5 = 0; a5 < 8; a5++) {
            var sx5 = Math.round(cx2 + 0.9238795325112867 * modFull * Math.cos(a5 * 0.7853981633974483));
            var sy5 = Math.round(cy2 + 0.9238795325112867 * modFull * Math.sin(a5 * 0.7853981633974483));
            if (sx5 < 0 || sy5 < 0 || sx5 >= w || sy5 >= h) continue;
            var so5 = sy5 * mstride + sx5 * 4;
            var sl5 = (rgba[so5] * 299 + rgba[so5 + 1] * 587 + rgba[so5 + 2] * 114) / 1000;
            if (sl5 > 170) hits5++;
          }
          if (hits5 < 6) continue;
          var score5 = hits5 * 1000 - Math.hypot(cx2 - p0[0], cy2 - p0[1]);
          if (score5 > bestScore2) { bestScore2 = score5; best2 = [cx2, cy2]; }
        }
      if (best2) {
        // 暗点质心精化（只含暗点本体 ±0.75 mod，避免环带 AA 拉偏质心），+0.5 修正像素索引半像素偏差
        var RAD5 = Math.max(5, modFull * 0.75);
        var wx0 = Math.max(0, Math.round(best2[0] - RAD5)), wx1 = Math.min(w - 1, Math.round(best2[0] + RAD5));
        var wy0 = Math.max(0, Math.round(best2[1] - RAD5)), wy1 = Math.min(h - 1, Math.round(best2[1] + RAD5));
        var accW2 = 0, accX2 = 0, accY2 = 0;
        for (var my = wy0; my <= wy1; my++)
          for (var mx = wx0; mx <= wx1; mx++) {
            var mo = my * mstride + mx * 4;
            var mlum = (rgba[mo] * 299 + rgba[mo + 1] * 587 + rgba[mo + 2] * 114) / 1000;
            if (mlum < 110) { var wg = 128 - mlum; accX2 += mx * wg; accY2 += my * wg; accW2 += wg; }
          }
        if (accW2 > 4) {
          var cmx = accX2 / accW2 + 0.5, cmy = accY2 / accW2 + 0.5;
          if (Math.hypot(cmx - p0[0], cmy - p0[1]) < SR2 * 1.15) markC = [cmx, cmy];
        }
      }
      if (markC) {
        var H2 = solveHomography([symTL, symTR, symBL, [972, 972]], [imgTL, imgTR, imgBL, markC]);
        if (H2) H = H2;
      }
      if (typeof self !== "undefined" && self.__CIMQR_DEBUG__) self.__CIMQR_DEBUG__({ phase: 'br', refined: !!markC, mark: markC, pred: p0 });
    } catch (e) {}
    if (typeof self !== "undefined" && self.__CIMQR_DEBUG__) self.__CIMQR_DEBUG__({ phase: 'h', SCALE: SCALE, tl: [tl.x, tl.y], tr: [tr.x, tr.y], bl: [bl.x, bl.y], h: H.h, sample0: H.map(71.5, 8.5) });

    // 读取格值（分辨率自适应：按格子的图像像素尺寸决定采样密度）
    var vals = new Uint8Array(DATA_CELLS);
    var stride = w * 4;
    // 格子在图像中的像素跨度（8 符号像素经 H 映射）
    var cp0 = H.map(0, 0), cp8 = H.map(8, 0);
    var cellPx = Math.hypot(cp8[0] - cp0[0], cp8[1] - cp0[1]);
    // NSP 上限 6：16 模板在 6×6 采样网格下仍两两可区分（最小汉明距 18/64），采样点 36 vs 64 省 44%
    var NSP = Math.max(2, Math.min(6, Math.round(cellPx)));
    if (typeof self !== "undefined" && self.__CIMQR_DEBUG__) { var __o = self.__CIMQR_DEBUG__({ phase: 'nsp', NSP: NSP, cellPx: cellPx }); if (self.__CIMQR_FORCE_NSP__) NSP = self.__CIMQR_FORCE_NSP__; }
    var nsq = NSP * NSP;
    // 单应系数局部展开（采样热循环内联用，避免 H.map 每次分配数组）
    var h0 = H.h[0], h1 = H.h[1], h2 = H.h[2], h3 = H.h[3], h4 = H.h[4], h5 = H.h[5], h6 = H.h[6], h7 = H.h[7];
    // 采样格内圈：INNER<8 时采样点向格中心收缩，避开格边缘与 1px 空隙的混色/模糊污染
    var INNER_OFF = (8 - INNER) / 2;
    var px = new Float64Array(nsq), py = new Float64Array(nsq);
    for (i = 0; i < nsq; i++) { px[i] = INNER_OFF + ((i % NSP) + 0.5) / NSP * INNER; py[i] = INNER_OFF + ((i / NSP | 0) + 0.5) / NSP * INNER; }
    // popcount 表（8 位）
    var pop8 = CimQR_POP8 || (function () {
      var t = new Uint8Array(256), i, j, c;
      for (i = 0; i < 256; i++) { c = 0; for (j = i; j; j &= j - 1) c++; t[i] = c; }
      CimQR_POP8 = t;
      return t;
    })();
    // 每个模板在 NSP×NSP 采样网格下的期望图案（预计算，与采样点一致），32 位双字
    // 低倍率（cellPx<5.5）下按格起点 x/y 奇偶选 4 套模板（与渲染交集法一致）
    var tplSet = getTpls(NSP, INNER, cellPx < 5.5);
    var tpl = tplSet.tpls;
    var tplIdxSel = cellPx < 5.5 ? 1 : 0;
    // 色相表（用于对每个采样点按色相分类；背景为黑色、低色度）
    var hueTable = (function () {
      var t = new Array(361).fill(-1), i;
      // 预置 4 色的色相角（0-360）
      function addHue(hueDeg, colorIdx) {
        var h = Math.round(hueDeg) % 360;
        for (var d = 0; d <= 6; d++) { t[(h + d) % 360] = colorIdx; t[(h - d + 360) % 360] = colorIdx; }
      }
      addHue(60, 2);   // 黄
      addHue(120, 0);  // 绿
      addHue(180, 1);  // 青
      addHue(300, 3);  // 品红
      return t;
    })();
    var CHROMA_THR = 24;
    var colVotes = [0, 0, 0, 0];
    function pop32(x) { return pop8[x & 255] + pop8[(x >>> 8) & 255] + pop8[(x >>> 16) & 255] + pop8[(x >>> 24) & 255]; }
    // 软判决预计算：每模板的亮点数与掩码（按采样序打包 hi/lo），供连续彩色度打分
    var softLit = soft ? tplSet.softLits : null;
    var sR = soft ? new Float64Array(nsq) : null, sG = soft ? new Float64Array(nsq) : null, sB = soft ? new Float64Array(nsq) : null, sC = soft ? new Float64Array(nsq) : null;
    for (i = 0; i < DATA_CELLS; i++) {
      var gridIdx = cellPos[i];
      var cc = gridIdx % GRID, cr = (gridIdx / GRID) | 0;
      var ox = OFFSET + cc * PITCH, oy = OFFSET + cr * PITCH;
      var patHi = 0, patLo = 0, bad = false, cnt = 0;
      colVotes[0] = colVotes[1] = colVotes[2] = colVotes[3] = 0;
      if (soft) {
        // —— 软判决：连续彩色度 + 模板相关打分，抗重采样/模糊的边界侵蚀 ——
        // 每采样点做 2×2 邻域平均（面积采样），提升模糊/重采样下的色度信噪比
        // 单应内联（避免每次调用分配数组）
        var maxCh = 0;
        for (var q = 0; q < nsq; q++) {
          var mx2 = ox + px[q], my2 = oy + py[q];
          var wden = h6 * mx2 + h7 * my2 + 1;
          var pqx = (h0 * mx2 + h1 * my2 + h2) / wden, pqy = (h3 * mx2 + h4 * my2 + h5) / wden;
          var rq = 0, gq = 0, bq = 0, nv = 0;
          for (var dy2 = -1; dy2 <= 1; dy2 += 2)
            for (var dx2 = -1; dx2 <= 1; dx2 += 2) {
              var xq = Math.floor(pqx + dx2 * 0.5), yq = Math.floor(pqy + dy2 * 0.5);
              if (xq < 0 || yq < 0 || xq >= w || yq >= h) continue;
              var oq = yq * stride + xq * 4;
              rq += rgba[oq]; gq += rgba[oq + 1]; bq += rgba[oq + 2]; nv++;
            }
          if (!nv) { bad = true; break; }
          rq /= nv; gq /= nv; bq /= nv;
          var mxq = rq > gq ? (rq > bq ? rq : bq) : (gq > bq ? gq : bq);
          var mnq = rq < gq ? (rq < bq ? rq : bq) : (gq < bq ? gq : bq);
          var chq = mxq - mnq;
          sR[q] = rq; sG[q] = gq; sB[q] = bq; sC[q] = chq;
          if (chq > maxCh) maxCh = chq;
        }
        if (bad || maxCh < CHROMA_THR * 0.7) { vals[i] = 255; continue; } // 全黑/采样失败 → RS
        var cfSum = 0;
        for (q = 0; q < nsq; q++) { sC[q] = sC[q] / maxCh; cfSum += sC[q]; }
        var bestSym2 = 0, bestD2 = Infinity;
        for (var s3 = 0; s3 < 16; s3++) {
          var L = (tplIdxSel ? softLit[(cr & 1) * 2 + (cc & 1)] : softLit[0])[s3];
          var dotv = 0;
          for (q = 0; q < nsq; q++) {
            var pos = nsq - 1 - q;
            var lit = pos >= 32 ? (L[0] >>> (pos - 32)) & 1 : (L[1] >>> pos) & 1;
            if (lit) dotv += sC[q];
          }
          var d3 = L[2] - 2 * dotv + cfSum; // Σ|cf-lit|
          if (d3 < bestD2) { bestD2 = d3; bestSym2 = s3; }
        }
        if (bestD2 > nsq * 0.45) { vals[i] = 255; continue; } // 模糊到无法辨认 → RS
        // 颜色：按彩色度加权的色相投票
        var cmax = 0;
        for (q = 0; q < nsq; q++) {
          if (sC[q] < 0.4) continue;
          var r2 = sR[q], g2 = sG[q], b2 = sB[q];
          var mx2 = r2 > g2 ? (r2 > b2 ? r2 : b2) : (g2 > b2 ? g2 : b2);
          var mn2 = r2 < g2 ? (r2 < b2 ? r2 : b2) : (g2 < b2 ? g2 : b2);
          var ch2 = mx2 - mn2;
          if (ch2 < CHROMA_THR) continue;
          var hue2;
          if (mx2 === r2) hue2 = ((g2 - b2) / ch2) * 60;
          else if (mx2 === g2) hue2 = 120 + ((b2 - r2) / ch2) * 60;
          else hue2 = 240 + ((r2 - g2) / ch2) * 60;
          if (hue2 < 0) hue2 += 360;
          var ci2 = hueTable[Math.round(hue2) % 360];
          if (ci2 >= 0) colVotes[ci2] += sC[q];
        }
        for (var cl2 = 1; cl2 < 4; cl2++) if (colVotes[cl2] > colVotes[cmax]) cmax = cl2;
        if (colVotes[cmax] < 0.01) { vals[i] = 255; continue; }
        vals[i] = (cmax << SYMBOL_BITS) | bestSym2;
        continue;
      }
      for (var sp = 0; sp < nsq; sp++) {
        // 单应内联（避免每次调用分配数组）
        var mx2 = ox + px[sp], my2 = oy + py[sp];
        var wden = h6 * mx2 + h7 * my2 + 1;
        var sx2 = (h0 * mx2 + h1 * my2 + h2) / wden, sy2 = (h3 * mx2 + h4 * my2 + h5) / wden;
        // floor 而非 round：round(x+0.5) 会偏到下一格（越界到格间空隙）
        var xi = Math.floor(sx2), yi = Math.floor(sy2);
        if (xi < 0 || yi < 0 || xi >= w || yi >= h) { bad = true; break; }
        var oi = yi * stride + xi * 4;
        var r = rgba[oi], g = rgba[oi + 1], b = rgba[oi + 2];
        var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        var chroma = mx - mn;
        var bit = 0;
        if (chroma >= CHROMA_THR) {
          // 色相（HSV 简化）：由 max 分量决定 60° 扇区
          var hue;
          if (mx === r) hue = ((g - b) / chroma) * 60;
          else if (mx === g) hue = 120 + ((b - r) / chroma) * 60;
          else hue = 240 + ((r - g) / chroma) * 60;
          if (hue < 0) hue += 360;
          var cIdx = hueTable[Math.round(hue) % 360];
          if (cIdx >= 0) { colVotes[cIdx]++; cnt++; bit = 1; }
        }
        patHi = (patHi << 1) | ((patLo >>> 31) & 1);
        patLo = ((patLo << 1) | bit) >>> 0;
      }
      if (bad || cnt < Math.max(2, nsq * 0.08)) { vals[i] = 255;  continue; } // 采样失败 → 用 RS 纠
      // 格子颜色 = 彩色点多数色
      var bestC = 0;
      for (var cl = 1; cl < 4; cl++) if (colVotes[cl] > colVotes[bestC]) bestC = cl;
      if (colVotes[bestC] < Math.max(1, nsq * 0.04)) { vals[i] = 255; continue; }
      // 匹配符号（16 模板，popcount Hamming）
      var bestSym = 0, bestD = nsq + 1;
      var tplT = tplIdxSel ? tpl[(cr & 1) * 2 + (cc & 1)] : tpl[0];
      for (var s = 0; s < 16; s++) {
        var d = pop32((patHi ^ tplT[s][0]) >>> 0) + pop32((patLo ^ tplT[s][1]) >>> 0);
        if (d < bestD) { bestD = d; bestSym = s; }
      }
      vals[i] = (bestC << SYMBOL_BITS) | bestSym;
    }
    // 反交织 → 位流 → 字节流
    var stream = new Uint8Array(Math.ceil(DATA_CELLS * BITS_PER_CELL / 8));
    var bw = new BitWriter();
    var failCount = 0;
    for (i = 0; i < DATA_CELLS; i++) {
      var val = vals[perm[i]];
      if (val === 255) failCount++;
      bw.write(val === 255 ? 0 : val, BITS_PER_CELL);
    }
    if (typeof self !== "undefined" && self.__CIMQR_DEBUG__) self.__CIMQR_DEBUG__({ phase: 'cells', fail: failCount, total: DATA_CELLS });
    var bytes = new Uint8Array(bw.finish());
    if (typeof self !== "undefined" && self.__CIMQR_DEBUG__) self.__CIMQR_DEBUG__({ phase: 'vals', first: Array.from(vals.slice(0, 6)), permFirst: Array.from(perm.slice(0, 6)) });
    // RS 解码 58 块
    var rsOut = new Uint8Array(58 * RS_K);
    var anyFail = false, failBlk = -1;
    for (var blk = 0; blk < 58; blk++) {
      var dec = rsDecode(bytes.subarray(blk * RS_N, blk * RS_N + RS_N));
      if (!dec) { anyFail = true; failBlk = blk; break; }
      rsOut.set(dec, blk * RS_K);
    }
    if (typeof self !== "undefined" && self.__CIMQR_DEBUG__) self.__CIMQR_DEBUG__({ phase: 'rs', anyFail: anyFail, failBlk: failBlk, bytes: Array.from(bytes.subarray(0, 8)) });
    if (anyFail) { cands = dropTriple(cands, sel); continue; }
    // 解析帧头
    var plen = rsOut[0] | (rsOut[1] << 8);
    if (plen > MAX_PACKET || plen < 12) { cands = dropTriple(cands, sel); continue; }
    if (rsOut[2] !== MAGIC[0] || rsOut[3] !== MAGIC[1] || rsOut[4] !== FORMAT) { cands = dropTriple(cands, sel); continue; }
    var packet = new Uint8Array(plen);
    packet.set(rsOut.subarray(9, 9 + plen), 0);
    packets.push(packet);
    if (!firstH) firstH = H; // 记录首个符号的单应（供帧间复用）
    cands = dropTriple(cands, sel); // 该符号已解出，移除其 3 个寻像候选
    } // for symN
    _lastH = packets.length === 1 ? firstH : null; // 仅单符号帧缓存单应（并行帧每次全检测）
    return packets;
  }

  // —— 帧间复用：跳过检测，直接用缓存单应采样解码（相机静止/微抖时相邻帧画面几乎不变）——
  // 复制精简版采样+RS+帧头流程（单符号），命中 ~15-25ms/帧
  var _lastH = null; // {x..} 由 decodeAttempt 成功时写入；decodeFrame 优先尝试
  function decodeFromH(rgba, w, h, H, INNER, soft) {
    var i;
    var vals = new Uint8Array(DATA_CELLS);
    var stride = w * 4;
    var cp0 = H.map(0, 0), cp8 = H.map(8, 0);
    var cellPx = Math.hypot(cp8[0] - cp0[0], cp8[1] - cp0[1]);
    var NSP = Math.max(2, Math.min(6, Math.round(cellPx)));
    var nsq = NSP * NSP;
    var INNER_OFF = (8 - INNER) / 2;
    var px = new Float64Array(nsq), py = new Float64Array(nsq);
    for (i = 0; i < nsq; i++) { px[i] = INNER_OFF + ((i % NSP) + 0.5) / NSP * INNER; py[i] = INNER_OFF + ((i / NSP | 0) + 0.5) / NSP * INNER; }
    var pop8 = CimQR_POP8 || (function () {
      var t = new Uint8Array(256), j, c;
      for (j = 0; j < 256; j++) { c = 0; for (var k = j; k; k &= k - 1) c++; t[j] = c; }
      CimQR_POP8 = t;
      return t;
    })();
    var tplSet = getTpls(NSP, INNER, cellPx < 5.5);
    var tpl = tplSet.tpls;
    var tplIdxSel = cellPx < 5.5 ? 1 : 0;
    var hueTable = (function () {
      var t = new Array(361).fill(-1), j;
      function addHue(hueDeg, colorIdx) {
        var hh = Math.round(hueDeg) % 360;
        for (var d = 0; d <= 6; d++) { t[(hh + d) % 360] = colorIdx; t[(hh - d + 360) % 360] = colorIdx; }
      }
      addHue(60, 2); addHue(120, 0); addHue(180, 1); addHue(300, 3);
      return t;
    })();
    var CHROMA_THR = 24;
    var colVotes = [0, 0, 0, 0];
    function pop32(x) { return pop8[x & 255] + pop8[(x >>> 8) & 255] + pop8[(x >>> 16) & 255] + pop8[(x >>> 24) & 255]; }
    var h0 = H.h[0], h1 = H.h[1], h2 = H.h[2], h3 = H.h[3], h4 = H.h[4], h5 = H.h[5], h6 = H.h[6], h7 = H.h[7];
    var softLit = soft ? tplSet.softLits : null;
    var sR = soft ? new Float64Array(nsq) : null, sG = soft ? new Float64Array(nsq) : null, sB = soft ? new Float64Array(nsq) : null, sC = soft ? new Float64Array(nsq) : null;
    for (i = 0; i < DATA_CELLS; i++) {
      var gridIdx = cellPos[i];
      var cc = gridIdx % GRID, cr = (gridIdx / GRID) | 0;
      var ox = OFFSET + cc * PITCH, oy = OFFSET + cr * PITCH;
      var patHi = 0, patLo = 0, bad = false, cnt = 0;
      colVotes[0] = colVotes[1] = colVotes[2] = colVotes[3] = 0;
      if (soft) {
        var maxCh = 0;
        for (var q = 0; q < nsq; q++) {
          var mx2 = ox + px[q], my2 = oy + py[q];
          var wden = h6 * mx2 + h7 * my2 + 1;
          var pqx = (h0 * mx2 + h1 * my2 + h2) / wden, pqy = (h3 * mx2 + h4 * my2 + h5) / wden;
          var rq = 0, gq = 0, bq = 0, nv = 0;
          for (var dy2 = -1; dy2 <= 1; dy2 += 2)
            for (var dx2 = -1; dx2 <= 1; dx2 += 2) {
              var xq = Math.floor(pqx + dx2 * 0.5), yq = Math.floor(pqy + dy2 * 0.5);
              if (xq < 0 || yq < 0 || xq >= w || yq >= h) continue;
              var oq = yq * stride + xq * 4;
              rq += rgba[oq]; gq += rgba[oq + 1]; bq += rgba[oq + 2]; nv++;
            }
          if (!nv) { bad = true; break; }
          rq /= nv; gq /= nv; bq /= nv;
          var mxq = rq > gq ? (rq > bq ? rq : bq) : (gq > bq ? gq : bq);
          var mnq = rq < gq ? (rq < bq ? rq : bq) : (gq < bq ? gq : bq);
          var chq = mxq - mnq;
          sR[q] = rq; sG[q] = gq; sB[q] = bq; sC[q] = chq;
          if (chq > maxCh) maxCh = chq;
        }
        if (bad || maxCh < CHROMA_THR * 0.7) { vals[i] = 255; continue; }
        var cfSum = 0;
        for (q = 0; q < nsq; q++) { sC[q] = sC[q] / maxCh; cfSum += sC[q]; }
        var bestSym2 = 0, bestD2 = Infinity;
        for (var s3 = 0; s3 < 16; s3++) {
          var L = (tplIdxSel ? softLit[(cr & 1) * 2 + (cc & 1)] : softLit[0])[s3];
          var dotv = 0;
          for (q = 0; q < nsq; q++) {
            var pos = nsq - 1 - q;
            var lit = pos >= 32 ? (L[0] >>> (pos - 32)) & 1 : (L[1] >>> pos) & 1;
            if (lit) dotv += sC[q];
          }
          var d3 = L[2] - 2 * dotv + cfSum;
          if (d3 < bestD2) { bestD2 = d3; bestSym2 = s3; }
        }
        if (bestD2 > nsq * 0.45) { vals[i] = 255; continue; }
        var cmax = 0;
        for (q = 0; q < nsq; q++) {
          if (sC[q] < 0.4) continue;
          var r2 = sR[q], g2 = sG[q], b2 = sB[q];
          var mx2 = r2 > g2 ? (r2 > b2 ? r2 : b2) : (g2 > b2 ? g2 : b2);
          var mn2 = r2 < g2 ? (r2 < b2 ? r2 : b2) : (g2 < b2 ? g2 : b2);
          var ch2 = mx2 - mn2;
          if (ch2 < CHROMA_THR) continue;
          var hue2;
          if (mx2 === r2) hue2 = ((g2 - b2) / ch2) * 60;
          else if (mx2 === g2) hue2 = 120 + ((b2 - r2) / ch2) * 60;
          else hue2 = 240 + ((r2 - g2) / ch2) * 60;
          if (hue2 < 0) hue2 += 360;
          var ci2 = hueTable[Math.round(hue2) % 360];
          if (ci2 >= 0) colVotes[ci2] += sC[q];
        }
        for (var cl2 = 1; cl2 < 4; cl2++) if (colVotes[cl2] > colVotes[cmax]) cmax = cl2;
        if (colVotes[cmax] < 0.01) { vals[i] = 255; continue; }
        vals[i] = (cmax << SYMBOL_BITS) | bestSym2;
        continue;
      }
      for (var sp = 0; sp < nsq; sp++) {
        var mx2 = ox + px[sp], my2 = oy + py[sp];
        var wden = h6 * mx2 + h7 * my2 + 1;
        var sx2 = (h0 * mx2 + h1 * my2 + h2) / wden, sy2 = (h3 * mx2 + h4 * my2 + h5) / wden;
        var xi = Math.floor(sx2), yi = Math.floor(sy2);
        if (xi < 0 || yi < 0 || xi >= w || yi >= h) { bad = true; break; }
        var oi = yi * stride + xi * 4;
        var r = rgba[oi], g = rgba[oi + 1], b = rgba[oi + 2];
        var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        var chroma = mx - mn;
        var bit = 0;
        if (chroma >= CHROMA_THR) {
          var hue;
          if (mx === r) hue = ((g - b) / chroma) * 60;
          else if (mx === g) hue = 120 + ((b - r) / chroma) * 60;
          else hue = 240 + ((r - g) / chroma) * 60;
          if (hue < 0) hue += 360;
          var cIdx = hueTable[Math.round(hue) % 360];
          if (cIdx >= 0) { colVotes[cIdx]++; cnt++; bit = 1; }
        }
        patHi = (patHi << 1) | ((patLo >>> 31) & 1);
        patLo = ((patLo << 1) | bit) >>> 0;
      }
      if (bad || cnt < Math.max(2, nsq * 0.08)) { vals[i] = 255;  continue; }
      var bestC = 0;
      for (var cl = 1; cl < 4; cl++) if (colVotes[cl] > colVotes[bestC]) bestC = cl;
      if (colVotes[bestC] < Math.max(1, nsq * 0.04)) { vals[i] = 255; continue; }
      var bestSym = 0, bestD = nsq + 1;
      var tplT = tplIdxSel ? tpl[(cr & 1) * 2 + (cc & 1)] : tpl[0];
      for (var s = 0; s < 16; s++) {
        var d = pop32((patHi ^ tplT[s][0]) >>> 0) + pop32((patLo ^ tplT[s][1]) >>> 0);
        if (d < bestD) { bestD = d; bestSym = s; }
      }
      vals[i] = (bestC << SYMBOL_BITS) | bestSym;
    }
    // 反交织 → 位流 → 字节流
    var bw = new BitWriter();
    var failCount = 0;
    for (i = 0; i < DATA_CELLS; i++) {
      var val = vals[perm[i]];
      if (val === 255) failCount++;
      bw.write(val === 255 ? 0 : val, BITS_PER_CELL);
    }
    var bytes = new Uint8Array(bw.finish());
    var rsOut = new Uint8Array(58 * RS_K);
    for (var blk = 0; blk < 58; blk++) {
      var dec = rsDecode(bytes.subarray(blk * RS_N, blk * RS_N + RS_N));
      if (!dec) return [];
      rsOut.set(dec, blk * RS_K);
    }
    var plen = rsOut[0] | (rsOut[1] << 8);
    if (plen > MAX_PACKET || plen < 12) return [];
    if (rsOut[2] !== MAGIC[0] || rsOut[3] !== MAGIC[1] || rsOut[4] !== FORMAT) return [];
    var packet = new Uint8Array(plen);
    packet.set(rsOut.subarray(9, 9 + plen), 0);
    return [packet];
  }

  // 从候选列表中移除某符号三元组对应的 3 个寻像（按对象引用）
  function dropTriple(cands, sel) {
    var out = [];
    for (var k = 0; k < cands.length; k++) {
      var c = cands[k];
      if (c !== sel.tl && c !== sel.tr && c !== sel.bl) out.push(c);
    }
    return out;
  }

  // 容错尝试阶梯：正常帧一次命中（零额外开销）；困难帧逐级加强
  // [检测降采样目标, 采样内缩跨度, 软判决, 用BR标记] —— 内缩越小越抗模糊，软判决抗重采样侵蚀，
  // BR 标记给出真实第 4 角点（透视精确）；平行四边形变体保留（标记误检时由 RS 裁决）
  var ATTEMPTS = [
    [512, 7.5, false, true],
    [512, 6, true, true],
    [768, 7.5, false, true],
    [512, 6, false, true],
    [512, 6, true, false],
    [512, 7.5, false, false],
    [512, 4.5, true, true],
    [768, 6, true, true],
    // 并行网格大画布（如 2176×2176）：每符号像素被摊薄，需更高检测分辨率
    [2048, 6, true, true],
    [2048, 7.5, false, true]
  ];
  function decodeFrame(rgba, w, h) {
    detToken++;
    // 帧间复用：相邻帧画面几乎不变（相机静止/微抖），直接沿用上次成功单应采样
    if (_lastH) {
      var fast;
      try { fast = decodeFromH(rgba, w, h, _lastH, 6, true); } catch (e) { fast = []; }
      if (fast && fast.length) return fast;
      // 复用失败（画面变化/切包）：继续完整检测，_lastH 会被新成功帧刷新
    }
    for (var a = 0; a < ATTEMPTS.length; a++) {
      var out;
      try { out = decodeAttempt(rgba, w, h, ATTEMPTS[a][0], ATTEMPTS[a][1], ATTEMPTS[a][2], ATTEMPTS[a][3]); } catch (e) { out = null; }
      if (out && out.length) return out;
    }
    return [];
  }

  // 快速预检：帧中是否存在足够多的饱和彩色像素（用于跳过黑白 QR 帧的昂贵解码）
  function maybeColor(rgba, w, h) {
    var step = Math.max(8, Math.floor(Math.max(w, h) / 96)), hits = 0, limit = 24;
    for (var y = 0; y < h && hits < limit; y += step) {
      for (var x = 0; x < w && hits < limit; x += step) {
        var o = (y * w + x) * 4;
        var r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
        var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        if (mx - mn > 48 && mx > 60) hits++;
      }
    }
    return hits >= 12;
  }

  return {
    CELL: CELL, PITCH: PITCH, OFFSET: OFFSET, GRID: GRID, IMG: IMG,
    DATA_CELLS: DATA_CELLS, MAX_PACKET: MAX_PACKET,
    maybeColor: maybeColor,
    render: renderFrame,
    decode: decodeFrame, _decodeAttempt: decodeAttempt,
    rsEncode: rsEncode, rsDecode: rsDecode,
    _perm: perm, _cellPos: cellPos,
    _detect: function (rgba, w, h) {
      var gray = new Uint8Array(w * h), i, o = 0;
      for (i = 0; i < w * h; i++, o += 4) gray[i] = (rgba[o] * 299 + rgba[o + 1] * 587 + rgba[o + 2] * 114) / 1000;
      var cands = detectFinders(gray, w, h);
      return { cands: cands, sel: selectTriple(cands) };
    }
  };
});

self.__RQR_WASM_MAP = null;
self.__RQR_DEBUG = false;
// 顶层 await：挂起模块求值直到 wasm 资源注入到达（已验证：await 期间消息照常派发）。
// 这样模块级的急切 init（zxing 顶层 await、ensureFastQrWasm）必然在 map 到达后执行。
await new Promise(function (__rqr_resolve) {
  self.addEventListener("message", function __rqr_wasm_boot(e) {
    if (self.__RQR_DEBUG) { self.__RQR_MSG_COUNT = (self.__RQR_MSG_COUNT || 0) + 1; if (self.__RQR_MSG_COUNT <= 5) self.postMessage({type:"wasm-msg-log", n: self.__RQR_MSG_COUNT, t: e.data && e.data.type}); }
    if (e.data && e.data.type === "wasm-assets") { self.__RQR_WASM_MAP = e.data.map; self.__RQR_DEBUG = !!e.data.debug; if (self.__RQR_DEBUG) self.postMessage({type:"wasm-map-received", keys: Object.keys(e.data.map||{}), n: (e.data.map?Object.keys(e.data.map).length:0)}); __rqr_resolve(true); }
  });
});
self.__RQR_WASM_URL = function (name) {
  if (self.__RQR_WASM_MAP && self.__RQR_WASM_MAP[name]) return self.__RQR_WASM_MAP[name];
  if (self.__RQR_DEBUG) self.postMessage({type:"wasm-url-called", name: name, hasMap: !!self.__RQR_WASM_MAP, keys: self.__RQR_WASM_MAP?Object.keys(self.__RQR_WASM_MAP):[]});
  throw new Error("RaptorQR WASM 资源未注入: " + name);
};
var Eo=Object.defineProperty;var Io=(r,n,i)=>n in r?Eo(r,n,{enumerable:!0,configurable:!0,writable:!0,value:i}):r[n]=i;var ee=(r,n,i)=>Io(r,typeof n!="symbol"?n+"":n,i);var ne=Uint8Array,je=Uint16Array,Fo=Int32Array,qr=new ne([0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0,0,0,0]),Hr=new ne([0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13,0,0]),Oo=new ne([16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15]),Xr=function(r,n){for(var i=new je(31),u=0;u<31;++u)i[u]=n+=1<<r[u-1];for(var s=new Fo(i[30]),u=1;u<30;++u)for(var h=i[u];h<i[u+1];++h)s[h]=h-i[u]<<5|u;return{b:i,r:s}},Yr=Xr(qr,2),Zr=Yr.b,Mo=Yr.r;Zr[28]=258,Mo[258]=28;var Do=Xr(Hr,0),ko=Do.b,Yt=new je(32768);for(var U=0;U<32768;++U){var Se=(U&43690)>>1|(U&21845)<<1;Se=(Se&52428)>>2|(Se&13107)<<2,Se=(Se&61680)>>4|(Se&3855)<<4,Yt[U]=((Se&65280)>>8|(Se&255)<<8)>>1}var Je=(function(r,n,i){for(var u=r.length,s=0,h=new je(n);s<u;++s)r[s]&&++h[r[s]-1];var v=new je(n);for(s=1;s<n;++s)v[s]=v[s-1]+h[s-1]<<1;var g;if(i){g=new je(1<<n);var y=15-n;for(s=0;s<u;++s)if(r[s])for(var P=s<<4|r[s],D=n-r[s],_=v[r[s]-1]++<<D,R=_|(1<<D)-1;_<=R;++_)g[Yt[_]>>y]=P}else for(g=new je(u),s=0;s<u;++s)r[s]&&(g[s]=Yt[v[r[s]-1]++]>>15-r[s]);return g}),tt=new ne(288);for(var U=0;U<144;++U)tt[U]=8;for(var U=144;U<256;++U)tt[U]=9;for(var U=256;U<280;++U)tt[U]=7;for(var U=280;U<288;++U)tt[U]=8;var Kr=new ne(32);for(var U=0;U<32;++U)Kr[U]=5;var Lo=Je(tt,9,1),Uo=Je(Kr,5,1),jt=function(r){for(var n=r[0],i=1;i<r.length;++i)r[i]>n&&(n=r[i]);return n},le=function(r,n,i){var u=n/8|0;return(r[u]|r[u+1]<<8)>>(n&7)&i},zt=function(r,n){var i=n/8|0;return(r[i]|r[i+1]<<8|r[i+2]<<16)>>(n&7)},Bo=function(r){return(r+7)/8|0},Go=function(r,n,i){return(i==null||i>r.length)&&(i=r.length),new ne(r.subarray(n,i))},Wo=["unexpected EOF","invalid block type","invalid length/literal","invalid distance","stream finished","no stream handler",,"no callback","invalid UTF-8 data","extra field too long","date not in range 1980-2099","filename too long","stream finishing","invalid zip data"],we=function(r,n,i){var u=new Error(n||Wo[r]);if(u.code=r,Error.captureStackTrace&&Error.captureStackTrace(u,we),!i)throw u;return u},jo=function(r,n,i,u){var s=r.length,h=0;if(!s||n.f&&!n.l)return i||new ne(0);var v=!i,g=v||n.i!=2,y=n.i;v&&(i=new ne(s*3));var P=function(C){var $=i.length;if(C>$){var Pe=new ne(Math.max($*2,C));Pe.set(i),i=Pe}},D=n.f||0,_=n.p||0,R=n.b||0,j=n.l,ae=n.d,z=n.m,Q=n.n,fe=s*8;do{if(!j){D=le(r,_,1);var x=le(r,_+1,3);if(_+=3,x)if(x==1)j=Lo,ae=Uo,z=9,Q=5;else if(x==2){var K=le(r,_,31)+257,q=le(r,_+10,15)+4,de=K+le(r,_+5,31)+1;_+=14;for(var oe=new ne(de),ie=new ne(19),Y=0;Y<q;++Y)ie[Oo[Y]]=le(r,_+Y*3,7);_+=q*3;for(var rt=jt(ie),$t=(1<<rt)-1,St=Je(ie,rt,1),Y=0;Y<de;){var nt=St[le(r,_,$t)];_+=nt&15;var L=nt>>4;if(L<16)oe[Y++]=L;else{var _e=0,Me=0;for(L==16?(Me=3+le(r,_,3),_+=2,_e=oe[Y-1]):L==17?(Me=3+le(r,_,7),_+=3):L==18&&(Me=11+le(r,_,127),_+=7);Me--;)oe[Y++]=_e}}var xe=oe.subarray(0,K),Z=oe.subarray(K);z=jt(xe),Q=jt(Z),j=Je(xe,z,1),ae=Je(Z,Q,1)}else we(1);else{var L=Bo(_)+4,W=r[L-4]|r[L-3]<<8,te=L+W;if(te>s){y&&we(0);break}g&&P(R+W),i.set(r.subarray(L,te),R),n.b=R+=W,n.p=_=te*8,n.f=D;continue}if(_>fe){y&&we(0);break}}g&&P(R+131072);for(var ge=(1<<z)-1,at=(1<<Q)-1,De=_;;De=_){var _e=j[zt(r,_)&ge],re=_e>>4;if(_+=_e&15,_>fe){y&&we(0);break}if(_e||we(2),re<256)i[R++]=re;else if(re==256){De=_,j=null;break}else{var k=re-254;if(re>264){var Y=re-257,H=qr[Y];k=le(r,_,(1<<H)-1)+Zr[Y],_+=H}var ke=ae[zt(r,_)&at],Le=ke>>4;ke||we(3),_+=ke&15;var Z=ko[Le];if(Le>3){var H=Hr[Le];Z+=zt(r,_)&(1<<H)-1,_+=H}if(_>fe){y&&we(0);break}g&&P(R+131072);var ot=R+k;if(R<Z){var Qe=h-Z,Tt=Math.min(Z,ot);for(Qe+R<0&&we(3);R<Tt;++R)i[R]=u[Qe+R]}for(;R<ot;++R)i[R]=i[R-Z]}}n.l=j,n.p=De,n.b=R,n.f=D,j&&(D=1,n.m=z,n.d=ae,n.n=Q)}while(!D);return R!=i.length&&v?Go(i,0,R):i.subarray(0,R)},zo=new ne(0);function No(r,n){return jo(r,{i:2},n,n)}var Qo=typeof TextDecoder<"u"&&new TextDecoder,Vo=0;try{Qo.decode(zo,{stream:!0}),Vo=1}catch{}var ue=[["All","*","*","     ",0,"All"],["AllReadable","*","r","     ",0,"All Readable"],["AllCreatable","*","w","     ",0,"All Creatable"],["AllLinear","*","l","     ",0,"All Linear"],["AllMatrix","*","m","     ",0,"All Matrix"],["AllGS1","*","G","     ",0,"All GS1"],["AllRetail","*","R","     ",0,"All Retail"],["AllIndustrial","*","I","     ",0,"All Industrial"],["Codabar","F"," ","lrw  ",18,"Codabar"],["Code39","A"," ","lrw I",8,"Code 39"],["Code39Std","A","s","lrw I",8,"Code 39 Standard"],["Code39Ext","A","e","lr  I",9,"Code 39 Extended"],["Code32","A","2","lr  I",129,"Code 32"],["PZN","A","p","lr  I",52,"Pharmazentralnummer"],["Code93","G"," ","lrw I",25,"Code 93"],["Code128","C"," ","lrwGI",20,"Code 128"],["ITF","I"," ","lrw I",3,"ITF"],["ITF14","I","4","lr  I",89,"ITF-14"],["DataBar","e"," ","lr GR",29,"DataBar"],["DataBarOmni","e","o","lr GR",29,"DataBar Omni"],["DataBarStk","e","s","lr GR",79,"DataBar Stacked"],["DataBarStkOmni","e","O","lr GR",80,"DataBar Stacked Omni"],["DataBarLtd","e","l","lr GR",30,"DataBar Limited"],["DataBarExp","e","e","lr GR",31,"DataBar Expanded"],["DataBarExpStk","e","E","lr GR",81,"DataBar Expanded Stacked"],["EANUPC","E"," ","lr  R",15,"EAN/UPC"],["EAN13","E","1","lrw R",15,"EAN-13"],["EAN8","E","8","lrw R",10,"EAN-8"],["EAN5","E","5","l   R",12,"EAN-5"],["EAN2","E","2","l   R",11,"EAN-2"],["ISBN","E","i","lr  R",69,"ISBN"],["UPCA","E","a","lrw R",34,"UPC-A"],["UPCE","E","e","lrw R",37,"UPC-E"],["Telepen","B"," ","lr  I",32,"Telepen"],["TelepenAlpha","B","0","lr  I",32,"Telepen Alpha"],["TelepenNumeric","B","1","lr  I",87,"Telepen Numeric"],["OtherBarcode","X"," "," r   ",0,"Other barcode"],["DXFilmEdge","X","x","lr   ",147,"DX Film Edge"],["PDF417","L"," ","mrw  ",55,"PDF417"],["CompactPDF417","L","c","mr   ",56,"Compact PDF417"],["MicroPDF417","L","m","mr   ",84,"MicroPDF417"],["Aztec","z"," ","mr G ",92,"Aztec"],["AztecCode","z","c","mrwG ",92,"Aztec Code"],["AztecRune","z","r","mr   ",128,"Aztec Rune"],["QRCode","Q"," ","mrwG ",58,"QR Code"],["QRCodeModel1","Q","1","mr   ",0,"QR Code Model 1"],["QRCodeModel2","Q","2","mr   ",58,"QR Code Model 2"],["MicroQRCode","Q","m","mr   ",97,"Micro QR Code"],["RMQRCode","Q","r","mr G ",145,"rMQR Code"],["DataMatrix","d"," ","mrwG ",71,"Data Matrix"],["MaxiCode","U"," ","mr   ",57,"MaxiCode"]],qo={DataBarExpanded:"DataBarExp",DataBarLimited:"DataBarLtd","Linear-Codes":"AllLinear","Matrix-Codes":"AllMatrix",Any:"All",rMQRCode:"RMQRCode"};ue.map(r=>r[5]);ue.filter(r=>r[1]==="*").map(r=>r[0]);ue.filter(r=>r[1]!=="*").map(r=>r[0]);ue.filter(r=>r[2]===" ").map(r=>r[0]);ue.filter(r=>r[3][0]==="l").map(r=>r[0]);ue.filter(r=>r[3][0]==="m").map(r=>r[0]);ue.filter(r=>r[3][1]==="r").map(r=>r[0]);ue.filter(r=>r[3][2]==="w"||r[4]!==0).map(r=>r[0]);ue.filter(r=>r[3][3]==="G").map(r=>r[0]);ue.filter(r=>r[3][4]==="R").map(r=>r[0]);ue.filter(r=>r[3][4]==="I").map(r=>r[0]);function Ho(r){var n;return(n=qo[r])==null?r:n}function Xo(r){return r.map(Ho).join(",")}var Wr=["LocalAverage","GlobalHistogram","FixedThreshold","BoolCast"],Yo="Unknown.ASCII.ISO8859_1.ISO8859_2.ISO8859_3.ISO8859_4.ISO8859_5.ISO8859_6.ISO8859_7.ISO8859_8.ISO8859_9.ISO8859_10.ISO8859_11.ISO8859_13.ISO8859_14.ISO8859_15.ISO8859_16.Cp437.Cp1250.Cp1251.Cp1252.Cp1256.Shift_JIS.Big5.GB2312.GB18030.EUC_JP.EUC_KR.UTF16BE.UTF8.UTF16LE.UTF32BE.UTF32LE.BINARY".split("."),Zo=["Ignore","Read","Require"],Ko=["Plain","ECI","HRI","Escaped","Hex","HexECI"],Jo={formats:[]},ei={locateFile:(r,n)=>{let i=r.match(/_(.+?)\.wasm$/);return i?`https://fastly.jsdelivr.net/npm/zxing-wasm@3.1.0/dist/${i[1]}/${r}`:n+r}},Nt=new WeakMap;function ti(r,n){return Object.is(r,n)||Object.keys(r).length===Object.keys(n).length&&Object.keys(r).every(i=>Object.hasOwn(n,i)&&r[i]===n[i])}function ri(r,{overrides:n,equalityFn:i=ti,fireImmediately:u=!1}={}){var s,h;let[v,g]=(s=Nt.get(r))==null?[ei]:s,y=n??v,P;if(u){if(g&&(P=i(v,y)))return g;let D=r({...y});return Nt.set(r,[y,D]),D}((h=P)==null?i(v,y):h)||Nt.set(r,[y])}[...Jo.formats];async function ni(r={}){var n,i,u,s=r,h=!!globalThis.window,v=typeof Bun<"u",g=!!globalThis.WorkerGlobalScope;!((i=globalThis.process)==null||(i=i.versions)==null)&&i.node&&((u=globalThis.process)==null||u.type);var y="./this.program",P,D="";function _(e){return s.locateFile?s.locateFile(e,D):D+e}var R,j;if(h||g||v){try{D=new URL(".",P).href}catch{}g&&(j=e=>{var t=new XMLHttpRequest;return t.open("GET",e,!1),t.responseType="arraybuffer",t.send(null),new Uint8Array(t.response)}),R=async e=>{var t=await fetch(e,{credentials:"same-origin"});if(t.ok)return t.arrayBuffer();throw Error(t.status+" : "+t.url)}}var ae=console.log.bind(console),z=console.error.bind(console),Q,fe=!1,x,L,W=!1;function te(){var e=mt.buffer;ge=new Int8Array(e),xe=new Int16Array(e),s.HEAPU8=H=new Uint8Array(e),re=new Uint16Array(e),Z=new Int32Array(e),k=new Uint32Array(e),at=new Float32Array(e),De=new Float64Array(e)}function K(){if(s.preRun)for(typeof s.preRun=="function"&&(s.preRun=[s.preRun]);s.preRun.length;)Tt(s.preRun.shift());ke(Qe)}function q(){W=!0,gt.Ba()}function de(){if(s.postRun)for(typeof s.postRun=="function"&&(s.postRun=[s.postRun]);s.postRun.length;)ot(s.postRun.shift());ke(Le)}function oe(e){var t,a;(t=s.onAbort)==null||t.call(s,e),e="Aborted("+e+")",z(e),fe=!0,e+=". Build with -sASSERTIONS for more info.";var o=new WebAssembly.RuntimeError(e);throw(a=L)==null||a(o),o}var ie;function Y(){return _("zxing_reader.wasm")}function rt(e){if(e==ie&&Q)return new Uint8Array(Q);if(j)return j(e);throw"both async and sync fetching of the wasm failed"}async function $t(e){if(!Q)try{var t=await R(e);return new Uint8Array(t)}catch{}return rt(e)}async function St(e,t){try{var a=await $t(e);return await WebAssembly.instantiate(a,t)}catch(o){z(`failed to asynchronously prepare wasm: ${o}`),oe(o)}}async function nt(e,t,a){if(!e&&WebAssembly.instantiateStreaming)try{var o=fetch(t,{credentials:"same-origin"});return await WebAssembly.instantiateStreaming(o,a)}catch(l){z(`wasm streaming compile failed: ${l}`),z("falling back to ArrayBuffer instantiation")}return St(t,a)}function _e(){return{a:za}}async function Me(){function e(o,l){return gt=o.exports,ja(gt),te(),gt}function t(o){return e(o.instance)}var a=_e();return s.instantiateWasm?new Promise((o,l)=>{s.instantiateWasm(a,(c,f)=>{o(e(c))})}):(ie!=null||(ie=Y()),t(await nt(Q,ie,a)))}var xe,Z,ge,at,De,re,k,H,ke=e=>{for(;e.length>0;)e.shift()(s)},Le=[],ot=e=>Le.push(e),Qe=[],Tt=e=>Qe.push(e),C=e=>Er(e),$=()=>Ir(),Pe=[],it=0,un=e=>{var t=new At(e);return t.get_caught()||(t.set_caught(!0),it--),t.set_rethrown(!1),Pe.push(t),xr(e)},ye=0,fn=()=>{S(0,0);var e=Pe.pop();Fr(e.excPtr),ye=0};class At{constructor(t){this.excPtr=t,this.ptr=t-24}set_type(t){k[this.ptr+4>>2]=t}get_type(){return k[this.ptr+4>>2]}set_destructor(t){k[this.ptr+8>>2]=t}get_destructor(){return k[this.ptr+8>>2]}set_caught(t){t=+!!t,ge[this.ptr+12]=t}get_caught(){return ge[this.ptr+12]!=0}set_rethrown(t){t=+!!t,ge[this.ptr+13]=t}get_rethrown(){return ge[this.ptr+13]!=0}init(t,a){this.set_adjusted_ptr(0),this.set_type(t),this.set_destructor(a)}set_adjusted_ptr(t){k[this.ptr+16>>2]=t}get_adjusted_ptr(){return k[this.ptr+16>>2]}}var st=e=>Pr(e),Rt=e=>{var t=ye;if(!t)return st(0),0;var a=new At(t);a.set_adjusted_ptr(t);var o=a.get_type();if(!o)return st(0),t;for(var l of e){if(l===0||l===o)break;var c=a.ptr+16;if(Or(l,o,c))return st(l),t}return st(o),t},dn=()=>Rt([]),hn=e=>Rt([e]),pn=(e,t)=>Rt([e,t]),mn=()=>{var e=Pe.pop();e||oe("no exception to throw");var t=e.excPtr;throw e.get_rethrown()||(Pe.push(e),e.set_rethrown(!0),e.set_caught(!1),it++),Gt(t),ye=t,ye},gn=(e,t,a)=>{throw new At(e).init(t,a),Gt(e),ye=e,it++,ye},yn=()=>it,vn=e=>{throw ye||(ye=e),ye},wn=()=>oe(""),lt={},xt=e=>{for(;e.length;){var t=e.pop();e.pop()(t)}};function Ve(e){return this.fromWireType(k[e>>2])}var Ue={},Ee={},ct={},bn=class extends Error{constructor(e){super(e),this.name="InternalError"}},ut=e=>{throw new bn(e)},Ce=(e,t,a)=>{e.forEach(d=>ct[d]=t);function o(d){var p=a(d);p.length!==e.length&&ut("Mismatched type converter count");for(var m=0;m<e.length;++m)he(e[m],p[m])}var l=Array(t.length),c=[],f=0;{let d=t;for(let p=0;p<d.length;++p){let m=d[p];Ee.hasOwnProperty(m)?l[p]=Ee[m]:(c.push(m),Ue.hasOwnProperty(m)||(Ue[m]=[]),Ue[m].push(()=>{l[p]=Ee[m],++f,f===c.length&&o(l)}))}}c.length===0&&o(l)},_n=e=>{var t=lt[e];delete lt[e];var a=t.rawConstructor,o=t.rawDestructor,l=t.fields,c=l.map(f=>f.getterReturnType).concat(l.map(f=>f.setterArgumentType));Ce([e],c,f=>{var d={};{let p=l;for(let m=0;m<p.length;++m){let w=p[m],T=f[m],I=w.getter,O=w.getterContext,M=f[m+l.length],E=w.setter,X=w.setterContext;d[w.fieldName]={read:B=>T.fromWireType(I(O,B)),write:(B,J)=>{var G=[];E(X,B,M.toWireType(G,J)),xt(G)},optional:T.optional}}}return[{name:t.name,fromWireType:p=>{var m={};for(var w in d)m[w]=d[w].read(p);return o(p),m},toWireType:(p,m)=>{for(var w in d)if(!(w in m)&&!d[w].optional)throw TypeError(`Missing field: "${w}"`);var T=a();for(w in d)d[w].write(T,m[w]);return p!==null&&p.push(o,T),T},readValueFromPointer:Ve,destructorFunction:o}]})},Cn=(e,t,a,o,l)=>{},N=e=>{for(var t="";;){var a=H[e++];if(!a)return t;t+=String.fromCharCode(a)}},qe=class extends Error{constructor(e){super(e),this.name="BindingError"}},F=e=>{throw new qe(e)};function $n(e,t){let a=arguments.length>2&&arguments[2]!==void 0?arguments[2]:{};var o=t.name;if(e||F(`type "${o}" must have a positive integer typeid pointer`),Ee.hasOwnProperty(e)){if(a.ignoreDuplicateRegistrations)return;F(`Cannot register type '${o}' twice`)}if(Ee[e]=t,delete ct[e],Ue.hasOwnProperty(e)){var l=Ue[e];delete Ue[e],l.forEach(c=>c())}}function he(e,t){return $n(e,t,arguments.length>2&&arguments[2]!==void 0?arguments[2]:{})}var Sn=(e,t,a,o)=>{t=N(t),he(e,{name:t,fromWireType:function(l){return!!l},toWireType:function(l,c){return c?a:o},readValueFromPointer:function(l){return this.fromWireType(H[l])},destructorFunction:null})},Tn=e=>({count:e.count,deleteScheduled:e.deleteScheduled,preservePointerOnDelete:e.preservePointerOnDelete,ptr:e.ptr,ptrType:e.ptrType,smartPtr:e.smartPtr,smartPtrType:e.smartPtrType}),Pt=e=>{function t(a){return a.$$.ptrType.registeredClass.name}F(t(e)+" instance already deleted")},Et=!1,cr=e=>{},An=e=>{e.smartPtr?e.smartPtrType.rawDestructor(e.smartPtr):e.ptrType.registeredClass.rawDestructor(e.ptr)},ur=e=>{--e.count.value,e.count.value===0&&An(e)},He=e=>globalThis.FinalizationRegistry?(Et=new FinalizationRegistry(t=>{ur(t.$$)}),He=t=>{var a=t.$$;if(a.smartPtr){var o={$$:a};Et.register(t,o,t)}return t},cr=t=>Et.unregister(t),He(e)):(He=t=>t,e),Rn=()=>{let e=ft.prototype;Object.assign(e,{isAliasOf(a){if(!(this instanceof ft)||!(a instanceof ft))return!1;var o=this.$$.ptrType.registeredClass,l=this.$$.ptr;a.$$=a.$$;for(var c=a.$$.ptrType.registeredClass,f=a.$$.ptr;o.baseClass;)l=o.upcast(l),o=o.baseClass;for(;c.baseClass;)f=c.upcast(f),c=c.baseClass;return o===c&&l===f},clone(){if(this.$$.ptr||Pt(this),this.$$.preservePointerOnDelete)return this.$$.count.value+=1,this;var a=He(Object.create(Object.getPrototypeOf(this),{$$:{value:Tn(this.$$)}}));return a.$$.count.value+=1,a.$$.deleteScheduled=!1,a},delete(){this.$$.ptr||Pt(this),this.$$.deleteScheduled&&!this.$$.preservePointerOnDelete&&F("Object already scheduled for deletion"),cr(this),ur(this.$$),this.$$.preservePointerOnDelete||(this.$$.smartPtr=void 0,this.$$.ptr=void 0)},isDeleted(){return!this.$$.ptr},deleteLater(){return this.$$.ptr||Pt(this),this.$$.deleteScheduled&&!this.$$.preservePointerOnDelete&&F("Object already scheduled for deletion"),this.$$.deleteScheduled=!0,this}});let t=Symbol.dispose;t&&(e[t]=e.delete)};function ft(){}var It=(e,t)=>Object.defineProperty(t,"name",{value:e}),fr={},dr=(e,t,a)=>{if(e[t].overloadTable===void 0){var o=e[t];e[t]=function(){var l=[...arguments];return e[t].overloadTable.hasOwnProperty(l.length)||F(`Function '${a}' called with an invalid number of arguments (${l.length}) - expects one of (${e[t].overloadTable})!`),e[t].overloadTable[l.length].apply(this,l)},e[t].overloadTable=[],e[t].overloadTable[o.argCount]=o}},hr=(e,t,a)=>{s.hasOwnProperty(e)?((a===void 0||s[e].overloadTable!==void 0&&s[e].overloadTable[a]!==void 0)&&F(`Cannot register public name '${e}' twice`),dr(s,e,e),s[e].overloadTable.hasOwnProperty(a)&&F(`Cannot register multiple overloads of a function with the same number of arguments (${a})!`),s[e].overloadTable[a]=t):(s[e]=t,s[e].argCount=a)},xn=48,Pn=57,En=e=>{e=e.replace(/[^a-zA-Z0-9_]/g,"$");var t=e.charCodeAt(0);return t>=xn&&t<=Pn?`_${e}`:e};function In(e,t,a,o,l,c,f,d){this.name=e,this.constructor=t,this.instancePrototype=a,this.rawDestructor=o,this.baseClass=l,this.getActualType=c,this.upcast=f,this.downcast=d,this.pureVirtualFunctions=[]}var Ft=(e,t,a)=>{for(;t!==a;)t.upcast||F(`Expected null or instance of ${a.name}, got an instance of ${t.name}`),e=t.upcast(e),t=t.baseClass;return e},Ot=e=>{if(e===null)return"null";var t=typeof e;return t==="object"||t==="array"||t==="function"?e.toString():""+e};function Fn(e,t){if(t===null)return this.isReference&&F(`null is not a valid ${this.name}`),0;t.$$||F(`Cannot pass "${Ot(t)}" as a ${this.name}`),t.$$.ptr||F(`Cannot pass deleted object as a pointer of type ${this.name}`);var a=t.$$.ptrType.registeredClass;return Ft(t.$$.ptr,a,this.registeredClass)}function On(e,t){var a;if(t===null)return this.isReference&&F(`null is not a valid ${this.name}`),this.isSmartPointer?(a=this.rawConstructor(),e!==null&&e.push(this.rawDestructor,a),a):0;(!t||!t.$$)&&F(`Cannot pass "${Ot(t)}" as a ${this.name}`),t.$$.ptr||F(`Cannot pass deleted object as a pointer of type ${this.name}`),!this.isConst&&t.$$.ptrType.isConst&&F(`Cannot convert argument of type ${t.$$.smartPtrType?t.$$.smartPtrType.name:t.$$.ptrType.name} to parameter type ${this.name}`);var o=t.$$.ptrType.registeredClass;if(a=Ft(t.$$.ptr,o,this.registeredClass),this.isSmartPointer)switch(t.$$.smartPtr===void 0&&F("Passing raw pointer to smart pointer is illegal"),this.sharingPolicy){case 0:t.$$.smartPtrType===this?a=t.$$.smartPtr:F(`Cannot convert argument of type ${t.$$.smartPtrType?t.$$.smartPtrType.name:t.$$.ptrType.name} to parameter type ${this.name}`);break;case 1:a=t.$$.smartPtr;break;case 2:if(t.$$.smartPtrType===this)a=t.$$.smartPtr;else{var l=t.clone();a=this.rawShare(a,pe.toHandle(()=>l.delete())),e!==null&&e.push(this.rawDestructor,a)}break;default:F("Unsupported sharing policy")}return a}function Mn(e,t){if(t===null)return this.isReference&&F(`null is not a valid ${this.name}`),0;t.$$||F(`Cannot pass "${Ot(t)}" as a ${this.name}`),t.$$.ptr||F(`Cannot pass deleted object as a pointer of type ${this.name}`),t.$$.ptrType.isConst&&F(`Cannot convert argument of type ${t.$$.ptrType.name} to parameter type ${this.name}`);var a=t.$$.ptrType.registeredClass;return Ft(t.$$.ptr,a,this.registeredClass)}var pr=(e,t,a)=>{if(t===a)return e;if(a.baseClass===void 0)return null;var o=pr(e,t,a.baseClass);return o===null?null:a.downcast(o)},Dn={},kn=(e,t)=>{for(t===void 0&&F("ptr should not be undefined");e.baseClass;)t=e.upcast(t),e=e.baseClass;return t},Ln=(e,t)=>(t=kn(e,t),Dn[t]),dt=(e,t)=>((!t.ptrType||!t.ptr)&&ut("makeClassHandle requires ptr and ptrType"),!!t.smartPtrType!=!!t.smartPtr&&ut("Both smartPtrType and smartPtr must be specified"),t.count={value:1},He(Object.create(e,{$$:{value:t,writable:!0}})));function Un(e){var t=this.getPointee(e);if(!t)return this.destructor(e),null;var a=Ln(this.registeredClass,t);if(a!==void 0){if(a.$$.count.value===0)return a.$$.ptr=t,a.$$.smartPtr=e,a.clone();var o=a.clone();return this.destructor(e),o}function l(){return this.isSmartPointer?dt(this.registeredClass.instancePrototype,{ptrType:this.pointeeType,ptr:t,smartPtrType:this,smartPtr:e}):dt(this.registeredClass.instancePrototype,{ptrType:this,ptr:e})}var c=fr[this.registeredClass.getActualType(t)];if(!c)return l.call(this);var f=this.isConst?c.constPointerType:c.pointerType,d=pr(t,this.registeredClass,f.registeredClass);return d===null?l.call(this):this.isSmartPointer?dt(f.registeredClass.instancePrototype,{ptrType:f,ptr:d,smartPtrType:this,smartPtr:e}):dt(f.registeredClass.instancePrototype,{ptrType:f,ptr:d})}var Bn=()=>{Object.assign(ht.prototype,{getPointee(e){return this.rawGetPointee&&(e=this.rawGetPointee(e)),e},destructor(e){var t;(t=this.rawDestructor)==null||t.call(this,e)},readValueFromPointer:Ve,fromWireType:Un})};function ht(e,t,a,o,l,c,f,d,p,m,w){this.name=e,this.registeredClass=t,this.isReference=a,this.isConst=o,this.isSmartPointer=l,this.pointeeType=c,this.sharingPolicy=f,this.rawGetPointee=d,this.rawConstructor=p,this.rawShare=m,this.rawDestructor=w,!l&&t.baseClass===void 0?o?(this.toWireType=Fn,this.destructorFunction=null):(this.toWireType=Mn,this.destructorFunction=null):this.toWireType=On}var mr=(e,t,a)=>{s.hasOwnProperty(e)||ut("Replacing nonexistent public symbol"),s[e].overloadTable!==void 0&&a!==void 0?s[e].overloadTable[a]=t:(s[e]=t,s[e].argCount=a)},ve={},Gn=(e,t,a)=>{e=e.replace(/p/g,"i");var o=ve[e];return o(t,...a)},gr=[],A=e=>{var t=gr[e];return t||(gr[e]=t=Lr.get(e)),t},Wn=function(e,t){let a=arguments.length>2&&arguments[2]!==void 0?arguments[2]:[];if(e.includes("j"))return Gn(e,t,a);var o=A(t)(...a);function l(c){return c}return o},jn=function(e,t){let a=arguments.length>2&&arguments[2]!==void 0?arguments[2]:!1;return function(){return Wn(e,t,[...arguments],a)}},se=function(e,t){e=N(e);function a(){return e.includes("j")?jn(e,t):A(t)}var o=a();return typeof o!="function"&&F(`unknown function pointer with signature ${e}: ${t}`),o};class zn extends Error{}var yr=e=>{var t=Rr(e),a=N(t);return $e(t),a},pt=(e,t)=>{var a=[],o={};function l(c){if(!o[c]&&!Ee[c]){if(ct[c]){ct[c].forEach(l);return}a.push(c),o[c]=!0}}throw t.forEach(l),new zn(`${e}: `+a.map(yr).join([", "]))},Nn=(e,t,a,o,l,c,f,d,p,m,w,T,I)=>{w=N(w),c=se(l,c),d&&(d=se(f,d)),m&&(m=se(p,m)),I=se(T,I);var O=En(w);hr(O,function(){pt(`Cannot construct ${w} due to unbound types`,[o])}),Ce([e,t,a],o?[o]:[],M=>{M=M[0];var E,X;o?(E=M.registeredClass,X=E.instancePrototype):X=ft.prototype;var B=It(w,function(){if(Object.getPrototypeOf(this)!==J)throw new qe(`Use 'new' to construct ${w}`);if(G.constructor_body===void 0)throw new qe(`${w} has no accessible constructor`);var Wt=[...arguments],Gr=G.constructor_body[Wt.length];if(Gr===void 0)throw new qe(`Tried to invoke ctor of ${w} with invalid number of parameters (${Wt.length}) - expected (${Object.keys(G.constructor_body).toString()}) parameters instead!`);return Gr.apply(this,Wt)}),J=Object.create(X,{constructor:{value:B}});B.prototype=J;var G=new In(w,B,J,I,E,c,d,m);if(G.baseClass){var Ge;(Ge=G.baseClass).__derivedClasses!=null||(Ge.__derivedClasses=[]),G.baseClass.__derivedClasses.push(G)}var Ye=new ht(w,G,!0,!1,!1),Ur=new ht(w+"*",G,!1,!1,!1),Br=new ht(w+" const*",G,!1,!0,!1);return fr[e]={pointerType:Ur,constPointerType:Br},mr(O,B),[Ye,Ur,Br]})},Mt=(e,t)=>{for(var a=[],o=0;o<e;o++)a.push(k[t+o*4>>2]);return a};function Qn(e){for(var t=1;t<e.length;++t)if(e[t]!==null&&e[t].destructorFunction===void 0)return!0;return!1}function Dt(e,t,a,o,l,c){var f=t.length;f<2&&F("argTypes array size mismatch! Must at least get return value and 'this' types!");var d=t[1]!==null&&a!==null,p=Qn(t),m=!t[0].isVoid,w=f-2,T=Array(w),I=[],O=[];return It(e,function(){O.length=0;var M;I.length=d?2:1,I[0]=l,d&&(M=t[1].toWireType(O,this),I[1]=M);for(var E=0;E<w;++E)T[E]=t[E+2].toWireType(O,E<0||arguments.length<=E?void 0:arguments[E]),I.push(T[E]);var X=o(...I);function B(J){if(p)xt(O);else for(var G=d?1:2;G<t.length;G++){var Ge=G===1?M:T[G-2];t[G].destructorFunction!==null&&t[G].destructorFunction(Ge)}if(m)return t[0].fromWireType(J)}return B(X)})}var Vn=(e,t,a,o,l,c)=>{var f=Mt(t,a);l=se(o,l),Ce([],[e],d=>{d=d[0];var p=`constructor ${d.name}`;if(d.registeredClass.constructor_body===void 0&&(d.registeredClass.constructor_body=[]),d.registeredClass.constructor_body[t-1]!==void 0)throw new qe(`Cannot register multiple constructors with identical number of parameters (${t-1}) for class '${d.name}'! Overload resolution is currently only performed using the parameter count, not actual type info!`);return d.registeredClass.constructor_body[t-1]=()=>{pt(`Cannot construct ${d.name} due to unbound types`,f)},Ce([],f,m=>(m.splice(1,0,null),d.registeredClass.constructor_body[t-1]=Dt(p,m,null,l,c),[])),[]})},vr=e=>{e=e.trim();let t=e.indexOf("(");return t===-1?e:e.slice(0,t)},qn=(e,t,a,o,l,c,f,d,p,m)=>{var w=Mt(a,o);t=N(t),t=vr(t),c=se(l,c),Ce([],[e],T=>{T=T[0];var I=`${T.name}.${t}`;t.startsWith("@@")&&(t=Symbol[t.substring(2)]),d&&T.registeredClass.pureVirtualFunctions.push(t);function O(){pt(`Cannot call ${I} due to unbound types`,w)}var M=T.registeredClass.instancePrototype,E=M[t];return E===void 0||E.overloadTable===void 0&&E.className!==T.name&&E.argCount===a-2?(O.argCount=a-2,O.className=T.name,M[t]=O):(dr(M,t,I),M[t].overloadTable[a-2]=O),Ce([],w,X=>{var B=Dt(I,X,T,c,f);return M[t].overloadTable===void 0?(B.argCount=a-2,M[t]=B):M[t].overloadTable[a-2]=B,[]}),[]})},wr=[],Ie=[0,1,,1,null,1,!0,1,!1,1],kt=e=>{e>9&&--Ie[e+1]===0&&(Ie[e]=void 0,wr.push(e))},pe={toValue:e=>(e||F(`Cannot use deleted val. handle = ${e}`),Ie[e]),toHandle:e=>{switch(e){case void 0:return 2;case null:return 4;case!0:return 6;case!1:return 8;default:{let t=wr.pop()||Ie.length;return Ie[t]=e,Ie[t+1]=1,t}}}},br={name:"emscripten::val",fromWireType:e=>{var t=pe.toValue(e);return kt(e),t},toWireType:(e,t)=>pe.toHandle(t),readValueFromPointer:Ve,destructorFunction:null},Hn=e=>he(e,br),Xn=(e,t)=>{switch(t){case 4:return function(a){return this.fromWireType(at[a>>2])};case 8:return function(a){return this.fromWireType(De[a>>3])};default:throw TypeError(`invalid float width (${t}): ${e}`)}},Yn=(e,t,a)=>{t=N(t),he(e,{name:t,fromWireType:o=>o,toWireType:(o,l)=>l,readValueFromPointer:Xn(t,a),destructorFunction:null})},Zn=(e,t,a,o,l,c,f,d)=>{var p=Mt(t,a);e=N(e),e=vr(e),l=se(o,l),hr(e,function(){pt(`Cannot call ${e} due to unbound types`,p)},t-1),Ce([],p,m=>{var w=[m[0],null].concat(m.slice(1));return mr(e,Dt(e,w,null,l,c),t-1),[]})},Kn=(e,t,a)=>{switch(t){case 1:return a?o=>ge[o]:o=>H[o];case 2:return a?o=>xe[o>>1]:o=>re[o>>1];case 4:return a?o=>Z[o>>2]:o=>k[o>>2];default:throw TypeError(`invalid integer width (${t}): ${e}`)}},Jn=(e,t,a,o,l)=>{t=N(t);let c=o===0,f=p=>p;if(c){var d=32-8*a;f=p=>p<<d>>>d,l=f(l)}he(e,{name:t,fromWireType:f,toWireType:(p,m)=>m,readValueFromPointer:Kn(t,a,o!==0),destructorFunction:null})},ea=(e,t,a)=>{let o=(l,c)=>{let f=0;return{next(){if(f>=l)return{done:!0};let d=f;return f++,{value:c(d),done:!1}},[Symbol.iterator](){return this}}};e[Symbol.iterator]||(e[Symbol.iterator]=function(){return o(this[t](),l=>this[a](l))})},ta=(e,t,a,o)=>{a=N(a),o=N(o),Ce([],[e,t],l=>{let c=l[0];return ea(c.registeredClass.instancePrototype,a,o),[]})},ra=(e,t,a)=>{var o=[Int8Array,Uint8Array,Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array][t];function l(c){var f=k[c>>2],d=k[c+4>>2];return new o(ge.buffer,d,f)}a=N(a),he(e,{name:a,fromWireType:l,readValueFromPointer:l},{ignoreDuplicateRegistrations:!0})},na=Object.assign({optional:!0},br),aa=(e,t)=>{he(e,na)},oa=(e,t,a,o)=>{if(!(o>0))return 0;for(var l=a,c=a+o-1,f=0;f<e.length;++f){var d=e.codePointAt(f);if(d<=127){if(a>=c)break;t[a++]=d}else if(d<=2047){if(a+1>=c)break;t[a++]=192|d>>6,t[a++]=128|d&63}else if(d<=65535){if(a+2>=c)break;t[a++]=224|d>>12,t[a++]=128|d>>6&63,t[a++]=128|d&63}else{if(a+3>=c)break;t[a++]=240|d>>18,t[a++]=128|d>>12&63,t[a++]=128|d>>6&63,t[a++]=128|d&63,f++}}return t[a]=0,a-l},Be=(e,t,a)=>oa(e,H,t,a),_r=e=>{for(var t=0,a=0;a<e.length;++a){var o=e.charCodeAt(a);o<=127?t++:o<=2047?t+=2:o>=55296&&o<=57343?(t+=4,++a):t+=3}return t},Cr=globalThis.TextDecoder&&new TextDecoder,$r=(e,t,a,o)=>{var l=t+a;if(o)return l;for(;e[t]&&!(t>=l);)++t;return t},Sr=function(e){let t=arguments.length>1&&arguments[1]!==void 0?arguments[1]:0,a=arguments.length>2?arguments[2]:void 0,o=arguments.length>3?arguments[3]:void 0;var l=$r(e,t,a,o);if(l-t>16&&e.buffer&&Cr)return Cr.decode(e.subarray(t,l));for(var c="";t<l;){var f=e[t++];if(!(f&128)){c+=String.fromCharCode(f);continue}var d=e[t++]&63;if((f&224)==192){c+=String.fromCharCode((f&31)<<6|d);continue}var p=e[t++]&63;if(f=(f&240)==224?(f&15)<<12|d<<6|p:(f&7)<<18|d<<12|p<<6|e[t++]&63,f<65536)c+=String.fromCharCode(f);else{var m=f-65536;c+=String.fromCharCode(55296|m>>10,56320|m&1023)}}return c},ia=(e,t,a)=>e?Sr(H,e,t,a):"",sa=(e,t)=>{t=N(t),he(e,{name:t,fromWireType(a){var o=k[a>>2],l=a+4,c;return c=ia(l,o,!0),$e(a),c},toWireType(a,o){o instanceof ArrayBuffer&&(o=new Uint8Array(o));var l,c=typeof o=="string";c||ArrayBuffer.isView(o)&&o.BYTES_PER_ELEMENT==1||F("Cannot pass non-string to std::string"),l=c?_r(o):o.length;var f=Bt(4+l+1),d=f+4;return k[f>>2]=l,c?Be(o,d,l+1):H.set(o,d),a!==null&&a.push($e,f),f},readValueFromPointer:Ve,destructorFunction(a){$e(a)}})},Tr=globalThis.TextDecoder?new TextDecoder("utf-16le"):void 0,la=(e,t,a)=>{var o=e>>1,l=$r(re,o,t/2,a);if(l-o>16&&Tr)return Tr.decode(re.subarray(o,l));for(var c="",f=o;f<l;++f){var d=re[f];c+=String.fromCharCode(d)}return c},ca=(e,t,a)=>{if(a!=null||(a=2147483647),a<2)return 0;a-=2;for(var o=t,l=a<e.length*2?a/2:e.length,c=0;c<l;++c){var f=e.charCodeAt(c);xe[t>>1]=f,t+=2}return xe[t>>1]=0,t-o},ua=e=>e.length*2,fa=(e,t,a)=>{for(var o="",l=e>>2,c=0;!(c>=t/4);c++){var f=k[l+c];if(!f&&!a)break;o+=String.fromCodePoint(f)}return o},da=(e,t,a)=>{if(a!=null||(a=2147483647),a<4)return 0;for(var o=t,l=o+a-4,c=0;c<e.length;++c){var f=e.codePointAt(c);if(f>65535&&c++,Z[t>>2]=f,t+=4,t+4>l)break}return Z[t>>2]=0,t-o},ha=e=>{for(var t=0,a=0;a<e.length;++a)e.codePointAt(a)>65535&&a++,t+=4;return t},pa=(e,t,a)=>{a=N(a);var o,l,c;t===2?(o=la,l=ca,c=ua):(o=fa,l=da,c=ha),he(e,{name:a,fromWireType:f=>{var d=k[f>>2],p=o(f+4,d*t,!0);return $e(f),p},toWireType:(f,d)=>{typeof d!="string"&&F(`Cannot pass non-string to C++ string type ${a}`);var p=c(d),m=Bt(4+p+t);return k[m>>2]=p/t,l(d,m+4,p+t),f!==null&&f.push($e,m),m},readValueFromPointer:Ve,destructorFunction(f){$e(f)}})},ma=(e,t,a,o,l,c)=>{lt[e]={name:N(t),rawConstructor:se(a,o),rawDestructor:se(l,c),fields:[]}},ga=(e,t,a,o,l,c,f,d,p,m)=>{lt[e].fields.push({fieldName:N(t),getterReturnType:a,getter:se(o,l),getterContext:c,setterArgumentType:f,setter:se(d,p),setterContext:m})},ya=(e,t)=>{t=N(t),he(e,{isVoid:!0,name:t,fromWireType:()=>{},toWireType:(a,o)=>{}})},Lt=[],va=e=>{var t=Lt.length;return Lt.push(e),t},wa=(e,t)=>{var a=Ee[e];return a===void 0&&F(`${t} has unknown type ${yr(e)}`),a},ba=(e,t)=>{for(var a=Array(e),o=0;o<e;++o)a[o]=wa(k[t+o*4>>2],`parameter ${o}`);return a},_a=(e,t,a)=>{var o=[],l=e(o,a);return o.length&&(k[t>>2]=pe.toHandle(o)),l},Ca={},Ar=e=>{var t=Ca[e];return t===void 0?N(e):t},$a=(e,t,a)=>{var o=8,[l,...c]=ba(e,t),f=l.toWireType.bind(l),d=c.map(m=>m.readValueFromPointer.bind(m));e--;var p=Array(e);return va(It(`methodCaller<(${c.map(m=>m.name)}) => ${l.name}>`,(m,w,T,I)=>{for(var O=0,M=0;M<e;++M)p[M]=d[M](I+O),O+=o;var E;switch(a){case 0:E=pe.toValue(m).apply(null,p);break;case 2:E=Reflect.construct(pe.toValue(m),p);break;case 3:E=p[0];break;case 1:E=pe.toValue(m)[Ar(w)](...p);break}return _a(f,T,E)}))},Sa=e=>e?(e=Ar(e),pe.toHandle(globalThis[e])):pe.toHandle(globalThis),Ta=e=>{e>9&&(Ie[e+1]+=1)},Aa=(e,t,a,o,l)=>Lt[e](t,a,o,l),Ra=e=>{xt(pe.toValue(e)),kt(e)},xa=(e,t,a,o)=>{var l=new Date().getFullYear(),c=new Date(l,0,1),f=new Date(l,6,1),d=c.getTimezoneOffset(),p=f.getTimezoneOffset(),m=Math.max(d,p);k[e>>2]=m*60,Z[t>>2]=+(d!=p);var w=O=>{var M=O>=0?"-":"+",E=Math.abs(O);return`UTC${M}${String(Math.floor(E/60)).padStart(2,"0")}${String(E%60).padStart(2,"0")}`},T=w(d),I=w(p);p<d?(Be(T,a,17),Be(I,o,17)):(Be(T,o,17),Be(I,a,17))},Pa=()=>2147483648,Ea=(e,t)=>Math.ceil(e/t)*t,Ia=e=>{var t=(e-mt.buffer.byteLength+65535)/65536|0;try{return mt.grow(t),te(),1}catch{}},Fa=e=>{var t=H.length;e>>>=0;var a=Pa();if(e>a)return!1;for(var o=1;o<=4;o*=2){var l=t*(1+.2/o);if(l=Math.min(l,e+100663296),Ia(Math.min(a,Ea(Math.max(e,l),65536))))return!0}return!1},Ut={},Oa=()=>y||"./this.program",Xe=()=>{if(!Xe.strings){var e,t,a={USER:"web_user",LOGNAME:"web_user",PATH:"/",PWD:"/",HOME:"/home/web_user",LANG:((e=(t=globalThis.navigator)==null?void 0:t.language)==null?"C":e).replace("-","_")+".UTF-8",_:Oa()};for(var o in Ut)Ut[o]===void 0?delete a[o]:a[o]=Ut[o];var l=[];for(var o in a)l.push(`${o}=${a[o]}`);Xe.strings=l}return Xe.strings},Ma=(e,t)=>{var a=0,o=0;for(var l of Xe()){var c=t+a;k[e+o>>2]=c,a+=Be(l,c,1/0)+1,o+=4}return 0},Da=(e,t)=>{var a=Xe();k[e>>2]=a.length;var o=0;for(var l of a)o+=_r(l)+1;return k[t>>2]=o,0},ka=e=>52;function La(e,t,a,o,l){return 70}var Ua=[null,[],[]],Ba=(e,t)=>{var a=Ua[e];t===0||t===10?((e===1?ae:z)(Sr(a)),a.length=0):a.push(t)},Ga=(e,t,a,o)=>{for(var l=0,c=0;c<a;c++){var f=k[t>>2],d=k[t+4>>2];t+=8;for(var p=0;p<d;p++)Ba(e,H[f+p]);l+=d}return k[o>>2]=l,0},Wa=e=>e;if(Rn(),Bn(),s.noExitRuntime&&s.noExitRuntime,s.print&&(ae=s.print),s.printErr&&(z=s.printErr),s.wasmBinary&&(Q=s.wasmBinary),s.arguments&&s.arguments,s.thisProgram&&(y=s.thisProgram),s.preInit)for(typeof s.preInit=="function"&&(s.preInit=[s.preInit]);s.preInit.length>0;)s.preInit.shift()();var Rr,$e,Bt,xr,S,Pr,Er,Ir,Fr,Gt,Or,Mr,Dr,kr,mt,Lr;function ja(e){Rr=e.Ca,$e=s._free=e.Da,Bt=s._malloc=e.Fa,xr=e.Ga,S=e.Ha,Pr=e.Ia,Er=e.Ja,Ir=e.Ka,Fr=e.La,Gt=e.Ma,Or=e.Na,ve.viijii=e.Oa,Mr=ve.viijjijjjjjj=e.Pa,Dr=ve.iiijj=e.Qa,ve.jiji=e.Ra,kr=ve.jiiii=e.Sa,ve.iiiiij=e.Ta,ve.iiiiijj=e.Ua,ve.iiiiiijj=e.Va,mt=e.Aa,Lr=e.Ea}var za={r:un,x:fn,a:dn,i:hn,m:pn,S:mn,p:gn,ha:yn,d:vn,da:wn,xa:_n,ca:Cn,ra:Sn,va:Nn,ua:Vn,H:qn,pa:Hn,Y:Yn,Z:Zn,A:Jn,ta,u:ra,wa:aa,qa:sa,T:pa,I:ma,ya:ga,sa:ya,O:$a,za:kt,E:Sa,U:Ta,N:Aa,la:Ra,ea:xa,ia:Fa,fa:Ma,ga:Da,ja:ka,$:La,W:Ga,na:fo,M:mo,B:_o,P:Za,V:$o,q:co,b:Va,F:po,ka:wo,c:Ha,Q:bo,h:Ya,j:no,s:ao,R:ho,t:io,G:so,C:lo,K:So,aa:Ro,_:xo,f:Ka,l:Na,e:qa,X:go,g:Xa,L:Co,k:Qa,ma:yo,o:oo,y:eo,v:uo,D:ro,w:vo,n:Ja,J:To,oa:to,ba:Ao,z:Wa};function Na(e,t){var a=$();try{A(e)(t)}catch(o){if(C(a),o!==o+0)throw o;S(1,0)}}function Qa(e,t,a,o,l){var c=$();try{A(e)(t,a,o,l)}catch(f){if(C(c),f!==f+0)throw f;S(1,0)}}function Va(e,t){var a=$();try{return A(e)(t)}catch(o){if(C(a),o!==o+0)throw o;S(1,0)}}function qa(e,t,a){var o=$();try{A(e)(t,a)}catch(l){if(C(o),l!==l+0)throw l;S(1,0)}}function Ha(e,t,a){var o=$();try{return A(e)(t,a)}catch(l){if(C(o),l!==l+0)throw l;S(1,0)}}function Xa(e,t,a,o){var l=$();try{A(e)(t,a,o)}catch(c){if(C(l),c!==c+0)throw c;S(1,0)}}function Ya(e,t,a,o){var l=$();try{return A(e)(t,a,o)}catch(c){if(C(l),c!==c+0)throw c;S(1,0)}}function Za(e,t,a,o,l,c){var f=$();try{return A(e)(t,a,o,l,c)}catch(d){if(C(f),d!==d+0)throw d;S(1,0)}}function Ka(e){var t=$();try{A(e)()}catch(a){if(C(t),a!==a+0)throw a;S(1,0)}}function Ja(e,t,a,o,l,c,f,d,p,m,w){var T=$();try{A(e)(t,a,o,l,c,f,d,p,m,w)}catch(I){if(C(T),I!==I+0)throw I;S(1,0)}}function eo(e,t,a,o,l,c,f){var d=$();try{A(e)(t,a,o,l,c,f)}catch(p){if(C(d),p!==p+0)throw p;S(1,0)}}function to(e,t,a,o,l,c,f,d,p,m,w,T,I,O,M,E,X){var B=$();try{A(e)(t,a,o,l,c,f,d,p,m,w,T,I,O,M,E,X)}catch(J){if(C(B),J!==J+0)throw J;S(1,0)}}function ro(e,t,a,o,l,c,f,d,p){var m=$();try{A(e)(t,a,o,l,c,f,d,p)}catch(w){if(C(m),w!==w+0)throw w;S(1,0)}}function no(e,t,a,o,l){var c=$();try{return A(e)(t,a,o,l)}catch(f){if(C(c),f!==f+0)throw f;S(1,0)}}function ao(e,t,a,o,l,c){var f=$();try{return A(e)(t,a,o,l,c)}catch(d){if(C(f),d!==d+0)throw d;S(1,0)}}function oo(e,t,a,o,l,c){var f=$();try{A(e)(t,a,o,l,c)}catch(d){if(C(f),d!==d+0)throw d;S(1,0)}}function io(e,t,a,o,l,c,f){var d=$();try{return A(e)(t,a,o,l,c,f)}catch(p){if(C(d),p!==p+0)throw p;S(1,0)}}function so(e,t,a,o,l,c,f,d){var p=$();try{return A(e)(t,a,o,l,c,f,d)}catch(m){if(C(p),m!==m+0)throw m;S(1,0)}}function lo(e,t,a,o,l,c,f,d,p){var m=$();try{return A(e)(t,a,o,l,c,f,d,p)}catch(w){if(C(m),w!==w+0)throw w;S(1,0)}}function co(e){var t=$();try{return A(e)()}catch(a){if(C(t),a!==a+0)throw a;S(1,0)}}function uo(e,t,a,o,l,c,f,d){var p=$();try{A(e)(t,a,o,l,c,f,d)}catch(m){if(C(p),m!==m+0)throw m;S(1,0)}}function fo(e,t,a){var o=$();try{return A(e)(t,a)}catch(l){if(C(o),l!==l+0)throw l;S(1,0)}}function ho(e,t,a,o,l,c,f){var d=$();try{return A(e)(t,a,o,l,c,f)}catch(p){if(C(d),p!==p+0)throw p;S(1,0)}}function po(e,t,a,o){var l=$();try{return A(e)(t,a,o)}catch(c){if(C(l),c!==c+0)throw c;S(1,0)}}function mo(e,t,a,o){var l=$();try{return A(e)(t,a,o)}catch(c){if(C(l),c!==c+0)throw c;S(1,0)}}function go(e,t,a,o,l,c,f,d,p){var m=$();try{A(e)(t,a,o,l,c,f,d,p)}catch(w){if(C(m),w!==w+0)throw w;S(1,0)}}function yo(e,t,a,o,l,c,f,d){var p=$();try{A(e)(t,a,o,l,c,f,d)}catch(m){if(C(p),m!==m+0)throw m;S(1,0)}}function vo(e,t,a,o,l,c,f,d,p,m){var w=$();try{A(e)(t,a,o,l,c,f,d,p,m)}catch(T){if(C(w),T!==T+0)throw T;S(1,0)}}function wo(e,t,a){var o=$();try{return A(e)(t,a)}catch(l){if(C(o),l!==l+0)throw l;S(1,0)}}function bo(e,t,a,o,l){var c=$();try{return A(e)(t,a,o,l)}catch(f){if(C(c),f!==f+0)throw f;S(1,0)}}function _o(e,t,a,o,l,c){var f=$();try{return A(e)(t,a,o,l,c)}catch(d){if(C(f),d!==d+0)throw d;S(1,0)}}function Co(e,t,a,o,l,c,f){var d=$();try{A(e)(t,a,o,l,c,f)}catch(p){if(C(d),p!==p+0)throw p;S(1,0)}}function $o(e,t,a,o){var l=$();try{return A(e)(t,a,o)}catch(c){if(C(l),c!==c+0)throw c;S(1,0)}}function So(e,t,a,o,l,c,f,d,p,m,w,T){var I=$();try{return A(e)(t,a,o,l,c,f,d,p,m,w,T)}catch(O){if(C(I),O!==O+0)throw O;S(1,0)}}function To(e,t,a,o,l,c,f,d,p,m,w,T,I,O,M,E){var X=$();try{A(e)(t,a,o,l,c,f,d,p,m,w,T,I,O,M,E)}catch(B){if(C(X),B!==B+0)throw B;S(1,0)}}function Ao(e,t,a,o,l,c,f,d,p,m,w,T,I,O,M,E,X,B,J,G){var Ge=$();try{Mr(e,t,a,o,l,c,f,d,p,m,w,T,I,O,M,E,X,B,J,G)}catch(Ye){if(C(Ge),Ye!==Ye+0)throw Ye;S(1,0)}}function Ro(e,t,a,o,l,c,f){var d=$();try{return Dr(e,t,a,o,l,c,f)}catch(p){if(C(d),p!==p+0)throw p;S(1,0)}}function xo(e,t,a,o,l){var c=$();try{return kr(e,t,a,o,l)}catch(f){if(C(c),f!==f+0)throw f;S(1,0)}}function Po(){K();function e(){var t,a;s.calledRun=!0,!fe&&(q(),(t=x)==null||t(s),(a=s.onRuntimeInitialized)==null||a.call(s),de())}s.setStatus?(s.setStatus("Running..."),setTimeout(()=>{setTimeout(()=>s.setStatus(""),1),e()},1)):e()}var gt=await Me();return Po(),n=W?s:new Promise((e,t)=>{x=e,L=t}),n}function ai(r){return ri(ni,r)}var oi=""+new URL(__RQR_WASM_URL("zxing_reader-B47v7G7e.wasm"),import.meta.url).href;const ii={balance:{binarizer:"LocalAverage",tryHarder:!1,tryRotate:!1,tryInvert:!1}},si=["LocalAverage","GlobalHistogram","FixedThreshold","BoolCast"],li=["auto",1,2,4,6,8],ci=[2,3,4],Te={...ii.balance,maxSymbols:"auto",tryDownscale:!0,downscaleFactor:3};function Jr(r){const n={...Te,...r};return si.includes(n.binarizer)||(n.binarizer=Te.binarizer),li.includes(n.maxSymbols)||(n.maxSymbols=Te.maxSymbols),ci.includes(n.downscaleFactor)||(n.downscaleFactor=Te.downscaleFactor),n}const ui=Xo(["QRCode"]),fi=Zo.indexOf("Ignore"),di=Ko.indexOf("Plain"),hi=Yo.indexOf("Unknown"),or=4,pi=8;({...Te});let Qt=null,yt=null;function mi(r,n=or){return gi(r,$i(n))}async function gi(r,n){const i=await yi();return vi(i,r,n)}function yi(){return Qt||(Qt=ai({overrides:{locateFile:r=>r.endsWith(".wasm")?oi:r},equalityFn:Object.is,fireImmediately:!0})),Qt}function vi(r,n,i){var v;const u=wi(n),s=r._malloc(u.byteLength);if(!s)throw new Error(`Failed to allocate ${u.byteLength} bytes in WASM memory`);let h=null;try{r.HEAPU8.set(u,s),h=r.readBarcodesFromPixmap(s,n.width,n.height,bi(i));const g=[];for(let y=0;y<h.size();y++){const P=h.get(y);!(P!=null&&P.isValid)||P.symbology!=="QRCode"||P.bytes.length===0||g.push({bytes:new Uint8Array(P.bytes),version:Ci(P.version,P.extra)})}return g}finally{(v=h==null?void 0:h.delete)==null||v.call(h),r._free(s)}}function wi(r){const n=r.width*r.height,i=n*4;if(r.data.length!==i)throw new Error(`ImageData size mismatch: expected ${i} RGBA bytes, got ${r.data.length}`);(!yt||yt.length<n)&&(yt=new Uint8Array(n));const u=yt.subarray(0,n),s=r.data;for(let h=0,v=0;h<n;h++,v+=4)u[h]=306*s[v]+601*s[v+1]+117*s[v+2]+512>>10;return u}function bi(r){return{formats:ui,tryHarder:r.tryHarder,tryRotate:r.tryRotate,tryInvert:r.tryInvert,tryDownscale:r.tryDownscale,tryDenoise:!1,binarizer:_i(r.binarizer),isPure:!1,downscaleThreshold:500,downscaleFactor:r.downscaleFactor,minLineCount:2,maxNumberOfSymbols:Zt(r.maxSymbols),validateOptionalChecksum:!1,returnErrors:!1,eanAddOnSymbol:fi,textMode:di,characterSet:hi,tryCode39ExtendedMode:!0}}function _i(r){const n=Wr.indexOf(r);return n>=0?n:Wr.indexOf(Te.binarizer)}function Ci(r,n){const i=Number.parseInt(r,10);if(Number.isFinite(i)&&i>0)return i;try{const u=JSON.parse(n),s=Number.parseInt(String(u.Version??""),10);if(Number.isFinite(s)&&s>0)return s}catch{}return 0}function Zt(r){return Number.isFinite(r)?Math.min(pi,Math.max(1,Math.round(r))):or}function $i(r){if(typeof r=="number")return{...Te,maxSymbols:Zt(r)};const{maxSymbols:n,...i}=r;return{...Jr(i),maxSymbols:Zt(n??or)}}const Si=81,ce=8,Vt=4,Ti=201,ze=16,Ai=31,Ri=.03,Kt=255;function xi(r){if(r<=0)return 0;const n=Math.floor(r*Ri),i=Math.max(0,Kt-r);return Math.min(n,i)}function Jt(r,n){if(!Number.isInteger(n)||n<=0)throw new RangeError(`Invalid symbol size: ${n}`);const i=Math.max(1,Math.ceil(Math.max(0,r)/n));return Math.max(1,Math.ceil(i/ze))}const en=new Uint32Array(256);let tn=!1;function Pi(){for(let n=0;n<256;n++){let i=n;for(let u=0;u<8;u++)i&1?i=i>>>1^2197175160:i>>>=1;en[n]=i>>>0}tn=!0}function Ei(){tn||Pi()}function Ii(r,n=0){Ei();let i=(n^4294967295)>>>0;const u=r.length;for(let s=0;s<u;s++){const h=(i^r[s])&255;i=(en[h]^i>>>8)>>>0}return(i^4294967295)>>>0}function Fi(r,n){return(r[n]|r[n+1]<<8|r[n+2]<<16)>>>0}function rn(r,n){return(r[n]|r[n+1]<<8|r[n+2]<<16|r[n+3]<<24>>>0)>>>0}function Oi(r){const n=r>>>0;return{generationIndex:n&4095,totalGenerations:n>>>12&4095,symbolIndex:n>>>24&31,isText:(n>>>29&1)!==0,isLastGeneration:(n>>>30&1)!==0,compressed:(n>>>31&1)!==0}}function Mi(r){if(r.length<ce)throw new Error(`Packet too short for header: ${r.length} bytes, need ${ce}`);if(r[0]!==Si)throw new Error(`Invalid magic byte: expected 0x51, got 0x${r[0].toString(16)}`);return{...Oi(rn(r,1)),dataLength:Fi(r,5)}}function Di(r){if(r.length<ce+Vt)throw new Error(`Packet too short: ${r.length} bytes, need at least ${ce+Vt}`);const n=Mi(r),i=r.length-ce-Vt,u=r.slice(ce,ce+i),s=rn(r,ce+i),h=new Uint8Array(ce+i);h.set(r.slice(0,ce),0),h.set(u,ce);const v=Ii(h);if(s!==v)throw new Error(`CRC32C mismatch: stored 0x${s.toString(16)}, computed 0x${v.toString(16)}`);return{header:n,payload:u}}function ki(r){return r.symbolIndex===Ai?"wasm-raptorq":"js-rlnc"}const nn="auto";function Li(r){return r==="auto"||r==="js-rlnc"||r==="wasm-raptorq"?r:nn}class er{__destroy_into_raw(){const n=this.__wbg_ptr;return this.__wbg_ptr=0,jr.unregister(this),n}free(){const n=this.__destroy_into_raw();V.__wbg_raptorqdecoder_free(n,0)}constructor(n,i){try{const v=V.__wbindgen_add_to_stack_pointer(-16);V.raptorqdecoder_new(v,n,i);var u=We().getInt32(v+0,!0),s=We().getInt32(v+4,!0),h=We().getInt32(v+8,!0);if(h)throw wt(s);return this.__wbg_ptr=u,jr.register(this,this.__wbg_ptr,this),this}finally{V.__wbindgen_add_to_stack_pointer(16)}}push(n){try{const h=V.__wbindgen_add_to_stack_pointer(-16),v=Wi(n,V.__wbindgen_export),g=an;V.raptorqdecoder_push(h,this.__wbg_ptr,v,g);var i=We().getInt32(h+0,!0),u=We().getInt32(h+4,!0),s=We().getInt32(h+8,!0);if(s)throw wt(u);return wt(i)}finally{V.__wbindgen_add_to_stack_pointer(16)}}}Symbol.dispose&&(er.prototype[Symbol.dispose]=er.prototype.free);function Ui(){return{__proto__:null,"./raptorqr_raptorq_wasm_bg.js":{__proto__:null,__wbg___wbindgen_throw_344f42d3211c4765:function(n,i){throw new Error(zr(n,i))},__wbg_new_32b398fb48b6d94a:function(){const n=new Array;return qt(n)},__wbg_new_from_slice_77cdfb7977362f3c:function(n,i){const u=new Uint8Array(Gi(n,i));return qt(u)},__wbg_push_d2ae3af0c1217ae6:function(n,i){return tr(n).push(tr(i))},__wbindgen_cast_0000000000000001:function(n,i){const u=zr(n,i);return qt(u)},__wbindgen_object_drop_ref:function(n){wt(n)}}}}const jr=typeof FinalizationRegistry>"u"?{register:()=>{},unregister:()=>{}}:new FinalizationRegistry(r=>V.__wbg_raptorqdecoder_free(r,1));function qt(r){et===be.length&&be.push(be.length+1);const n=et;return et=be[n],be[n]=r,n}function Bi(r){r<1028||(be[r]=et,et=r)}function Gi(r,n){return r=r>>>0,ir().subarray(r/1,r/1+n)}let Fe=null;function We(){return(Fe===null||Fe.buffer.detached===!0||Fe.buffer.detached===void 0&&Fe.buffer!==V.memory.buffer)&&(Fe=new DataView(V.memory.buffer)),Fe}function zr(r,n){return zi(r>>>0,n)}let Ze=null;function ir(){return(Ze===null||Ze.byteLength===0)&&(Ze=new Uint8Array(V.memory.buffer)),Ze}function tr(r){return be[r]}let be=new Array(1024).fill(void 0);be.push(void 0,null,!0,!1);let et=be.length;function Wi(r,n){const i=n(r.length*1,1)>>>0;return ir().set(r,i/1),an=r.length,i}function wt(r){const n=tr(r);return Bi(r),n}let bt=new TextDecoder("utf-8",{ignoreBOM:!0,fatal:!0});bt.decode();const ji=2146435072;let Ht=0;function zi(r,n){return Ht+=n,Ht>=ji&&(bt=new TextDecoder("utf-8",{ignoreBOM:!0,fatal:!0}),bt.decode(),Ht=n),bt.decode(ir().subarray(r,r+n))}let an=0,V;function Ni(r,n){return V=r.exports,Fe=null,Ze=null,V}async function Qi(r,n){if(typeof Response=="function"&&r instanceof Response){if(typeof WebAssembly.instantiateStreaming=="function")try{return await WebAssembly.instantiateStreaming(r,n)}catch(s){if(r.ok&&i(r.type)&&r.headers.get("Content-Type")!=="application/wasm")console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n",s);else throw s}const u=await r.arrayBuffer();return await WebAssembly.instantiate(u,n)}else{const u=await WebAssembly.instantiate(r,n);return u instanceof WebAssembly.Instance?{instance:u,module:r}:u}function i(u){switch(u){case"basic":case"cors":case"default":return!0}return!1}}async function Vi(r){if(V!==void 0)return V;r!==void 0&&(Object.getPrototypeOf(r)===Object.prototype?{module_or_path:r}=r:console.warn("using deprecated parameters for the initialization function; pass a single object instead")),r===void 0&&(r=new URL(""+new URL(__RQR_WASM_URL("raptorqr_raptorq_wasm_bg-C7Shp1E2.wasm"),import.meta.url).href,import.meta.url));const n=Ui();(typeof r=="string"||typeof Request=="function"&&r instanceof Request||typeof URL=="function"&&r instanceof URL)&&(r=fetch(r));const{instance:i,module:u}=await Qi(await r,n);return Ni(i)}let vt=null;function qi(){return"RaptorQ WASM artifacts are not installed. Run packages/raptorqr-raptorq-wasm/src/build_raptorq_wasm_colab.py in Google Colab, then copy the generated files into packages/raptorqr-raptorq-wasm/src/wasm."}async function Hi(){vt||(vt=Promise.resolve(Vi()).catch(r=>{throw vt=null,Yi(r)})),await vt}class sr{constructor(n){ee(this,"inner");this.inner=n}static async create(n,i){return await Hi(),Xi(i),new sr(new er(n,i))}push(n){const i=this.inner.push(n);return i?new Uint8Array(i):null}}function Xi(r){if(!Number.isInteger(r)||r<=4)throw new RangeError(`RaptorQ transport payload size must be an integer greater than 4 bytes, got ${r}`)}function Yi(r){const n=r instanceof Error?r.message:String(r);return n.includes("RaptorQ WASM artifacts are not installed")?new Error(qi()):r instanceof Error?r:new Error(n)}const Ke=256,on=512,Zi=285,Re=new Uint8Array(Ke),Oe=new Uint8Array(on);function Ki(){let r=1;for(let n=0;n<Ke-1;n++)Oe[n]=r,Re[r]=n,r=r<<1,r>=Ke&&(r^=Zi);for(let n=Ke-1;n<on;n++)Oe[n]=Oe[n-(Ke-1)];Re[0]=0}Ki();function sn(r,n){return(r^n)>>>0}function Ne(r,n){return sn(r,n)}function me(r,n){if(r===0||n===0)return 0;const i=Re[r]+Re[n];return Oe[i]}function Ji(r,n){if(n===0)throw new RangeError("GF(256) division by zero");if(r===0)return 0;const i=(Re[r]-Re[n]+255)%255;return Oe[i]}function es(r,n){if(n===0)return 1;const i=Re[r]*n%255;return Oe[i]}function rr(r){return r===0?0:Oe[255-Re[r]]}class ts{constructor(n){ee(this,"s");const i=(n>>>0|0)>>>0;this.s=new Uint32Array(4);let u=BigInt(i);for(let s=0;s<4;s++)u=rs(u),this.s[s]=Number(u&BigInt(4294967295))>>>0}next(){const n=ns(this.s),i=this.s[1]<<9;return this.s[2]^=this.s[0],this.s[3]^=this.s[1],this.s[1]^=this.s[2],this.s[0]^=this.s[3],this.s[2]^=i,this.s[3]=ln(this.s[3],11),n>>>0}nextByte(){return this.next()&255}}function rs(r){r=r+BigInt(114007148193232e5)&BigInt("0xffffffffffffffff");let n=r;return n=(n^n>>30n)*BigInt(0xbf58476d1ce4e800),n=(n^n>>27n)&BigInt("0xffffffffffffffff"),n=n*BigInt(0x94d049bb13311000)&BigInt("0xffffffffffffffff"),n=n^n>>31n,n&BigInt("0xffffffffffffffff")}function ns(r){return Math.imul(ln(Math.imul(r[1]>>>0,5)>>>0,7)>>>0,9)>>>0}function ln(r,n){return(r<<n|r>>>32-n)>>>0}function as(r,n){const i=r>>>0,u=n+1>>>0;return(i*2654435769^u*2246822507^i>>>16^u<<16)>>>0}function os(r,n){const i=new ts(n),u=new Uint8Array(r);let s=!0,h=0;const v=100;do{s=!1;for(let g=0;g<r;g++){let y;do y=i.nextByte();while(y===0);u[g]=y}s=!0;for(let g=0;g<r;g++)if(u[g]!==0){s=!1;break}h++,h>=v&&(u[0]=1,s=!1)}while(s);return u}class is{constructor(n,i){ee(this,"k");ee(this,"symbolLength");ee(this,"rows",[]);ee(this,"pivotForColumn");ee(this,"_rank",0);ee(this,"_solved",!1);ee(this,"_sourceSymbols",null);this.k=n,this.symbolLength=i,this.pivotForColumn=new Array(n).fill(-1)}get rank(){return this._rank}isSolved(){return this._solved}addSymbol(n,i){if(n.length!==this.symbolLength)throw new RangeError(`addSymbol: expected symbol length ${this.symbolLength}, got ${n.length}`);if(i.length!==this.k)throw new RangeError(`addSymbol: expected coefficient length ${this.k}, got ${i.length}`);if(this._solved)return!1;const u={coeffs:new Uint8Array(i),data:new Uint8Array(n)};for(let g=0;g<this.k;g++){const y=this.pivotForColumn[g];if(y<0||u.coeffs[g]===0)continue;const P=this.rows[y],D=u.coeffs[g];this.eliminateFromRow(u,P,D,g)}let s=-1;for(let g=0;g<this.k;g++)if(u.coeffs[g]!==0){s=g;break}if(s<0)return!1;const h=u.coeffs[s];if(h!==1){const g=rr(h);for(let y=s;y<this.k;y++)u.coeffs[y]=me(u.coeffs[y],g);for(let y=0;y<this.symbolLength;y++)u.data[y]=me(u.data[y],g)}for(let g=0;g<this.rows.length;g++){const y=this.rows[g];if(y.coeffs[s]===0)continue;const P=y.coeffs[s];this.eliminateFromRow(y,u,P,s)}let v=0;for(;v<this.rows.length;){const g=this.findPivot(this.rows[v]);if(g<0)break;if(g<s)v++;else break}this.pivotForColumn[s]=v;for(let g=0;g<this.k;g++)this.pivotForColumn[g]>=v&&g!==s&&this.pivotForColumn[g]++;return this.rows.splice(v,0,u),this._rank++,this._rank===this.k&&this.solve(),!0}getSourceSymbols(){return this._sourceSymbols?this._sourceSymbols.map(n=>new Uint8Array(n)):null}findPivot(n){for(let i=0;i<this.k;i++)if(n.coeffs[i]!==0)return i;return-1}eliminateFromRow(n,i,u,s){for(let h=s;h<this.k;h++)n.coeffs[h]=Ne(n.coeffs[h],me(u,i.coeffs[h]));for(let h=0;h<this.symbolLength;h++)n.data[h]=Ne(n.data[h],me(u,i.data[h]))}solve(){this.rows.sort((i,u)=>{const s=this.findPivot(i),h=this.findPivot(u);return s-h});for(let i=0;i<this.k;i++)this.pivotForColumn[i]=-1;for(let i=0;i<this.rows.length;i++){const u=this.findPivot(this.rows[i]);u>=0&&(this.pivotForColumn[u]=i)}const n=new Array(this.k);for(let i=0;i<this.k;i++){const u=this.pivotForColumn[i];if(u<0)throw new Error(`RLNCDecoder: internal error — no pivot row for column ${i} despite rank=${this.k}`);n[i]=new Uint8Array(this.rows[u].data)}this._sourceSymbols=n,this._solved=!0}}class ss{constructor(n,i){ee(this,"k");ee(this,"symbolLength");ee(this,"decoders",new Map);this.k=n,this.symbolLength=i}addSymbol(n,i,u){return this.getOrCreateDecoder(n).addSymbol(i,u)}addSystematicSymbol(n,i,u){const s=new Uint8Array(this.k);return s[u]=1,this.addSymbol(n,i,s)}addCodedSymbol(n,i,u){const s=as(n,u),h=os(this.k,s);return this.addSymbol(n,i,h)}isSolved(n){const i=this.decoders.get(n);return i!==void 0&&i.isSolved()}getSourceSymbols(n){const i=this.decoders.get(n);return i?i.getSourceSymbols():null}rank(n){const i=this.decoders.get(n);return i?i.rank:0}getOrCreateDecoder(n){let i=this.decoders.get(n);return i||(i=new is(this.k,this.symbolLength),this.decoders.set(n,i)),i}}const ls=2;function Nr(r){return es(ls,r%255)}function Qr(r,n,i){let u=1,s=1;const h=i[r];for(let v=0;v<i.length;v++){if(v===r)continue;const g=i[v];u=me(u,Ne(n,g)),s=me(s,Ne(h,g))}return Ji(u,s)}function cs(r,n,i){const u=n,s=i,h=u+s;s>0&&fs(u,s);const v=[],g=[];for(let x=0;x<u;x++)r.has(x)?v.push(x):g.push(x);if(g.length===0){const x=[];for(let L=0;L<u;L++)x.push(new Uint8Array(r.get(L)));return x}const y=[];for(let x=u;x<h;x++)r.has(x)&&y.push(x);if(y.length<g.length)throw new Error(`Cannot recover: ${g.length} missing source generations, but only ${y.length} parity generations available (need ${g.length})`);const P=y.slice(0,g.length),D=r.get(v[0]??P[0]).length,_=Array.from({length:u},(x,L)=>Nr(L)),R=[],j=[];for(const x of P){const L=Nr(x);R.push(v.map(W=>Qr(W,L,_))),j.push(g.map(W=>Qr(W,L,_)))}const z=us(j),Q=new Map;for(let x=0;x<D;x++){const L=[];for(let W=0;W<g.length;W++){const te=P[W];let K=r.get(te)[x];for(let q=0;q<v.length;q++){const de=R[W][q];if(de===0)continue;const oe=v[q],ie=r.get(oe)[x];ie!==0&&(K=Ne(K,me(de,ie)))}L.push(K)}for(let W=0;W<g.length;W++){const te=g[W];Q.has(te)||Q.set(te,new Uint8Array(D));let K=0;for(let q=0;q<g.length;q++){const de=z[W][q];de===0||L[q]===0||(K=sn(K,me(de,L[q])))}Q.get(te)[x]=K}}const fe=[];for(let x=0;x<u;x++)r.has(x)?fe.push(new Uint8Array(r.get(x))):fe.push(Q.get(x));return fe}function us(r){const n=r.length;if(n===0)return[];if(n===1){const s=r[0][0];if(s===0)throw new Error("Singular matrix in outer RS decode");return[[rr(s)]]}const i=[];for(let s=0;s<n;s++){const h=[...r[s],...Array(n).fill(0)];h[n+s]=1,i.push(h)}for(let s=0;s<n;s++){let h=-1;for(let y=s;y<n;y++)if(i[y][s]!==0){h=y;break}if(h===-1)throw new Error("Singular matrix in outer RS decode");if(h!==s){const y=i[s];i[s]=i[h],i[h]=y}const v=i[s][s],g=rr(v);for(let y=s;y<2*n;y++)i[s][y]=me(i[s][y],g);for(let y=0;y<n;y++){if(y===s)continue;const P=i[y][s];if(P!==0)for(let D=s;D<2*n;D++)i[y][D]=Ne(i[y][D],me(P,i[s][D]))}}const u=[];for(let s=0;s<n;s++)u.push(i[s].slice(n,2*n));return u}function fs(r,n){const i=r+n;if(i>Kt)throw new RangeError(`Outer RS over GF(256) supports at most ${Kt} source+parity generations, got ${i}.`)}function ds(r,n,i,u=Ti){if(n===0)return new Uint8Array(0);const s=Jt(i,u),h=xi(s),v=n-s;if(v<0||v!==h)throw new Error(`assemblePayload: inconsistent generation metadata; expected ${s+h} total generations, got ${n}`);if(r.size<s)throw new Error(`assemblePayload: only ${r.size} generations solved, need at least ${s} (out of ${n} total)`);const g=new Map;for(const[R,j]of r){const ae=new Uint8Array(ze*u);for(let z=0;z<j.length;z++)ae.set(j[z],z*u);g.set(R,ae)}const y=cs(g,s,v),P=y.reduce((R,j)=>R+j.length,0),D=new Uint8Array(P);let _=0;for(const R of y)D.set(R,_),_+=R.length;return D.slice(0,i)}const hs=60,ps=4;let b=null,Ae=[],Xt=!1,_t=Te,Ct=nn,nr=!1,ar=!1;self.onmessage=r=>{const n=r.data;if(n.type==="reset"){b=null,Ae=[],nr=!1,ar=!1,fhCache&&fhCache.clear();return}if(n.type==="settings"){_t=Jr(n.settings),Ct=Li(n.fecCodec);return}if(n.type==="frame"){let i=n.imageData??n.frameData??null;if(!i&&n.pixels&&n.width&&n.height)try{i=new ImageData(new Uint8ClampedArray(n.pixels),n.width,n.height)}catch(u){self.postMessage({type:"error",message:"ImageData failed: "+u.message});return}if(!i)return;ms(i,n.realtime===!0);return}};var pendingLatest=null;var fhCache=new Map;function fhKey(r){var d=r.data,w=r.width,h=r.height,hh=0,st=Math.max(4,Math.floor(Math.max(w,h)/64));for(var y=0;y<h;y+=st)for(var x=0;x<w;x+=st){var o=(y*w+x)*4;var v=((d[o]>>4)&3)|((d[o+1]>>4)&3)<<2|((d[o+2]>>4)&3)<<4;hh=((hh*31)+v)>>>0}return hh}function ms(r,n){if(n){if(Xt){pendingLatest=r;return}var hk=fhKey(r);if(fhCache.has(hk)){return}if(fhCache.size>64)fhCache.clear();fhCache.set(hk,1);if(Ae.length===0){Ae.push({imageData:r,realtime:!0}),gs();return}const u=Ae.findIndex(s=>s.realtime);u>=0&&Ae.splice(u,1)}Ae.push({imageData:r,realtime:n}),n||gs()}async function gs(){if(!Xt){Xt=!0;try{for(;;){if(pendingLatest){Ae.push({imageData:pendingLatest,realtime:!0}),pendingLatest=null}if(Ae.length===0)break;const r=Ae.shift();try{await ys(r.imageData),b!=null&&b.completed&&(Ae=[],pendingLatest=null)}catch(n){self.postMessage({type:"error",message:`Frame error: ${n.message??String(n)}`})}}}finally{Xt=!1}}}async function ys(r){let cp=[];if(CimQR.maybeColor(r.data,r.width,r.height)){try{cp=CimQR.decode(r.data,r.width,r.height)||[]}catch(e2){cp=[]}}if(cp.length>0){let i=0;for(const by of cp){let s;try{s=Di(by)}catch{continue}if(await ws({version:0},s,i===0)&&(i++,b!=null&&b.completed)){Vr(b);return}}b&&i>0&&Vr(b);return}const n=await mi(r,{..._t,maxSymbols:vs()});if(n.length===0)return;let i=0;for(const u of n){let s;try{s=Di(u.bytes)}catch{continue}if(await ws(u,s,i===0)&&(i++,b!=null&&b.completed)){Vr(b);return}}b&&i>0&&Vr(b)}function vs(){return _t.maxSymbols!=="auto"?_t.maxSymbols:ps}async function ws(r,n,i){const u=ki(n.header);return $s(u)?u==="wasm-raptorq"?_s(r,n,i):bs(r,n,i):(lr(u),!1)}function bs(r,n,i){const u=n.header;if(!b){const y=n.payload.length,P=Jt(u.dataLength,y);b={codec:"js-rlnc",decoder:new ss(ze,y),dedup:new Set,receivedPackets:0,solvedGenerations:new Set,totalGenerations:u.totalGenerations,sourceGenerations:P,dataLength:u.dataLength,symbolSize:y,qrVersion:r.version,isText:u.isText,isCompressed:u.compressed,completed:!1,stats:{totalFrames:0,framesWithQR:0,acceptedPackets:0}}}if(b.codec!=="js-rlnc")return lr("js-rlnc"),!1;if(b.completed)return!0;if(i&&b.stats.totalFrames++,n.payload.length!==b.symbolSize)throw new Error(`QR payload size changed from ${b.symbolSize} to ${n.payload.length} bytes. Restart the scan before switching QR size.`);b.totalGenerations=u.totalGenerations,b.dataLength=u.dataLength,b.sourceGenerations=Jt(u.dataLength,b.symbolSize),b.qrVersion=r.version,b.isText=u.isText,b.isCompressed=u.compressed,b.stats.framesWithQR++;const s=`${u.generationIndex}:${u.symbolIndex}`;if(b.dedup.has(s))return!0;b.dedup.add(s);const h=u.generationIndex;let v=!1;return u.symbolIndex<ze?v=b.decoder.addSystematicSymbol(h,n.payload,u.symbolIndex):v=b.decoder.addCodedSymbol(h,n.payload,u.symbolIndex-ze),v&&(b.stats.acceptedPackets++,b.receivedPackets++,b.decoder.isSolved(h)&&(b.solvedGenerations.add(h),b.solvedGenerations.size>=b.sourceGenerations&&(Cs(b),b.completed))),!0}async function _s(r,n,i){const u=n.header;if(!b){const h=n.payload.length,v=Math.max(1,Math.ceil(u.dataLength/Math.max(1,h-4)));b={codec:"wasm-raptorq",decoder:null,dedup:new Set,receivedPackets:0,totalGenerations:u.totalGenerations,sourceGenerations:v,dataLength:u.dataLength,symbolSize:h,qrVersion:r.version,isText:u.isText,isCompressed:u.compressed,completed:!1,stats:{totalFrames:0,framesWithQR:0,acceptedPackets:0}}}if(b.codec!=="wasm-raptorq")return lr("wasm-raptorq"),!1;if(b.completed)return!0;if(i&&b.stats.totalFrames++,n.payload.length!==b.symbolSize)throw new Error(`RaptorQ payload size changed from ${b.symbolSize} to ${n.payload.length} bytes. Restart the scan before switching QR size.`);b.totalGenerations=u.totalGenerations,b.dataLength=u.dataLength,b.sourceGenerations=Math.max(1,Math.ceil(u.dataLength/Math.max(1,b.symbolSize-4))),b.qrVersion=r.version,b.isText=u.isText,b.isCompressed=u.compressed,b.stats.framesWithQR++;const s=Ss(n.payload);if(b.dedup.has(s))return!0;b.dedup.add(s),b.stats.acceptedPackets++,b.receivedPackets++;try{b.decoder||(b.decoder=await sr.create(b.dataLength,b.symbolSize));const h=b.decoder.push(n.payload);h&&cn(b,h)}catch(h){ar||(ar=!0,self.postMessage({type:"error",message:`RaptorQ WASM unavailable: ${h.message??String(h)}`}))}return!0}function Cs(r){const n=r.decoder,i=new Map;for(const s of Array.from(r.solvedGenerations)){const h=n.getSourceSymbols(s);if(!h){self.postMessage({type:"error",message:`Generation ${s} reported solved but has no source symbols`});return}i.set(s,h.map(v=>new Uint8Array(v)))}let u;try{u=ds(i,r.totalGenerations,r.dataLength,r.symbolSize)}catch(s){self.postMessage({type:"error",message:`Reassembly failed: ${s.message??String(s)}`});return}cn(r,u)}function cn(r,n){let i;if(r.isCompressed)try{i=No(n)}catch{self.postMessage({type:"error",message:"Decompression failed — data may be corrupted"});return}else i=n;let u="",s="application/octet-stream";if(!r.isText)try{if(i.length>=2){const h=i[0];if(i.length>=2+h){const v=i[1+h],g=2+h+v;i.length>=g&&(u=new TextDecoder().decode(i.slice(1,1+h)),s=new TextDecoder().decode(i.slice(2+h,g)),i=i.slice(g))}}}catch{}if(r.isText){const h=new TextDecoder().decode(i);self.postMessage({type:"complete",isText:!0,text:h,autoStop:!0})}else self.postMessage({type:"complete",isText:!1,data:i.buffer,filename:u||`recovered-${Date.now().toString(36)}`,mime:s||"application/octet-stream",autoStop:!0},{transfer:[i.buffer]});r.completed=!0}function Vr(r){const n=r.totalGenerations,i=r.codec==="js-rlnc"?r.solvedGenerations.size:r.completed?1:0,u=r.stats.framesWithQR,s=r.dedup.size,h=r.codec==="js-rlnc"?r.sourceGenerations>0?ze*r.sourceGenerations:0:r.sourceGenerations;self.postMessage({type:"progress",totalFrames:r.stats.totalFrames,framesWithQR:u,uniquePackets:s,duplicatePackets:Math.max(0,u-s),acceptedPackets:r.stats.acceptedPackets,neededPackets:h,receivedPackets:r.receivedPackets,solvedGenerations:i,totalGenerations:n,sourceGenerations:r.sourceGenerations,dataLength:r.dataLength,symbolSize:r.symbolSize,qrVersion:r.qrVersion,fecCodec:r.codec,status:r.codec==="wasm-raptorq"?`Receiving RaptorQ (${s}/${h} packets)`:n>0?`Receiving (${i}/${r.sourceGenerations} gens)`:"Receiving…"})}function $s(r){return Ct==="auto"||Ct===r}function lr(r){nr||(nr=!0,self.postMessage({type:"error",message:`Received ${r} packet while FEC codec is set to ${Ct}.`}))}function Ss(r){if(r.length<4)throw new Error("RaptorQ packet payload is too short for a payload id.");return`${r[0]}:${r[1]}:${r[2]}:${r[3]}`}
