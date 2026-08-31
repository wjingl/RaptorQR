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
    var cands = detectFinders(dg, dw, dh);
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
class $r{__destroy_into_raw(){const o=this.__wbg_ptr;return this.__wbg_ptr=0,At.unregister(this),o}free(){const o=this.__destroy_into_raw();v.__wbg_qrrenderer_free(o,0)}buf_len(){return v.qrrenderer_buf_len(this.__wbg_ptr)>>>0}buf_ptr(){return v.qrrenderer_buf_ptr(this.__wbg_ptr)>>>0}last_matrix_size(){return v.qrrenderer_last_matrix_size(this.__wbg_ptr)>>>0}matrix_len(){return v.qrrenderer_matrix_len(this.__wbg_ptr)>>>0}matrix_ptr(){return v.qrrenderer_matrix_ptr(this.__wbg_ptr)>>>0}constructor(){const o=v.qrrenderer_new();return this.__wbg_ptr=o,At.register(this,this.__wbg_ptr,this),this}render(o,d,p,u){try{const y=v.__wbindgen_add_to_stack_pointer(-16),x=Nr(o,v.__wbindgen_export),I=Wr;v.qrrenderer_render(y,this.__wbg_ptr,x,I,d,p,u);var g=H().getInt32(y+0,!0),w=H().getInt32(y+4,!0),R=H().getInt32(y+8,!0);if(R)throw Lr(w);return g>>>0}finally{v.__wbindgen_add_to_stack_pointer(16)}}render_matrix(o,d,p){try{const R=v.__wbindgen_add_to_stack_pointer(-16),y=Nr(o,v.__wbindgen_export),x=Wr;v.qrrenderer_render_matrix(R,this.__wbg_ptr,y,x,d,p);var u=H().getInt32(R+0,!0),g=H().getInt32(R+4,!0),w=H().getInt32(R+8,!0);if(w)throw Lr(g);return u>>>0}finally{v.__wbindgen_add_to_stack_pointer(16)}}render_rgba(o,d,p,u){try{const y=v.__wbindgen_add_to_stack_pointer(-16),x=Nr(o,v.__wbindgen_export),I=Wr;v.qrrenderer_render_rgba(y,this.__wbg_ptr,x,I,d,p,u);var g=H().getInt32(y+0,!0),w=H().getInt32(y+4,!0),R=H().getInt32(y+8,!0);if(R)throw Lr(w);return g>>>0}finally{v.__wbindgen_add_to_stack_pointer(16)}}rgba_len(){return v.qrrenderer_rgba_len(this.__wbg_ptr)>>>0}rgba_ptr(){return v.qrrenderer_rgba_ptr(this.__wbg_ptr)>>>0}}Symbol.dispose&&($r.prototype[Symbol.dispose]=$r.prototype.free);function kn(){return{__proto__:null,"./raptorqr_fast_qr_wasm_bg.js":{__proto__:null,__wbg___wbindgen_throw_344f42d3211c4765:function(o,d){throw new Error(Rt(o,d))},__wbindgen_cast_0000000000000001:function(o,d){const p=Rt(o,d);return jn(p)}}}}const At=typeof FinalizationRegistry>"u"?{register:()=>{},unregister:()=>{}}:new FinalizationRegistry(a=>v.__wbg_qrrenderer_free(a,1));function jn(a){dr===V.length&&V.push(V.length+1);const o=dr;return dr=V[o],V[o]=a,o}function Nn(a){a<1028||(V[a]=dr,dr=a)}let er=null;function H(){return(er===null||er.buffer.detached===!0||er.buffer.detached===void 0&&er.buffer!==v.memory.buffer)&&(er=new DataView(v.memory.buffer)),er}function Rt(a,o){return Vn(a>>>0,o)}let fr=null;function Tt(){return(fr===null||fr.byteLength===0)&&(fr=new Uint8Array(v.memory.buffer)),fr}function Ln(a){return V[a]}let V=new Array(1024).fill(void 0);V.push(void 0,null,!0,!1);let dr=V.length;function Nr(a,o){const d=o(a.length*1,1)>>>0;return Tt().set(a,d/1),Wr=a.length,d}function Lr(a){const o=Ln(a);return Nn(a),o}let Dr=new TextDecoder("utf-8",{ignoreBOM:!0,fatal:!0});Dr.decode();const Hn=2146435072;let Hr=0;function Vn(a,o){return Hr+=o,Hr>=Hn&&(Dr=new TextDecoder("utf-8",{ignoreBOM:!0,fatal:!0}),Dr.decode(),Hr=o),Dr.decode(Tt().subarray(a,a+o))}let Wr=0,v;function Gn(a,o){return v=a.exports,er=null,fr=null,v}async function Zn(a,o){if(typeof Response=="function"&&a instanceof Response){if(typeof WebAssembly.instantiateStreaming=="function")try{return await WebAssembly.instantiateStreaming(a,o)}catch(u){if(a.ok&&d(a.type)&&a.headers.get("Content-Type")!=="application/wasm")console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n",u);else throw u}const p=await a.arrayBuffer();return await WebAssembly.instantiate(p,o)}else{const p=await WebAssembly.instantiate(a,o);return p instanceof WebAssembly.Instance?{instance:p,module:a}:p}function d(p){switch(p){case"basic":case"cors":case"default":return!0}return!1}}async function Xn(a){if(v!==void 0)return v;a!==void 0&&(Object.getPrototypeOf(a)===Object.prototype?{module_or_path:a}=a:console.warn("using deprecated parameters for the initialization function; pass a single object instead")),a===void 0&&(a=new URL(""+new URL(__RQR_WASM_URL("raptorqr_fast_qr_wasm_bg-DEFhihBP.wasm"),import.meta.url).href,import.meta.url));const o=kn();(typeof a=="string"||typeof Request=="function"&&a instanceof Request||typeof URL=="function"&&a instanceof URL)&&(a=fetch(a));const{instance:d,module:p}=await Zn(await a,o);return Gn(d)}let Ir=null,Sr=null;function Zr(){return"fast_qr WASM artifacts are not installed. Run packages/raptorqr-fast-qr-wasm/src/build_fast_qr_wasm_colab.py in Google Colab, then copy the generated files into packages/raptorqr-fast-qr-wasm/src/wasm."}async function Et(){Ir||(Ir=Promise.resolve(Xn()).then(a=>{Sr=a}).catch(a=>{throw Ir=null,a instanceof Error?a:new Error(String(a))})),await Ir}function xt(){return Sr!==null}function It(){if(!Sr)throw new Error("fast_qr WASM not initialized — call ensureFastQrWasm() first.");return Sr.memory}var O=[["All","*","*","     ",0,"All"],["AllReadable","*","r","     ",0,"All Readable"],["AllCreatable","*","w","     ",0,"All Creatable"],["AllLinear","*","l","     ",0,"All Linear"],["AllMatrix","*","m","     ",0,"All Matrix"],["AllGS1","*","G","     ",0,"All GS1"],["AllRetail","*","R","     ",0,"All Retail"],["AllIndustrial","*","I","     ",0,"All Industrial"],["Codabar","F"," ","lrw  ",18,"Codabar"],["Code39","A"," ","lrw I",8,"Code 39"],["Code39Std","A","s","lrw I",8,"Code 39 Standard"],["Code39Ext","A","e","lr  I",9,"Code 39 Extended"],["Code32","A","2","lr  I",129,"Code 32"],["PZN","A","p","lr  I",52,"Pharmazentralnummer"],["Code93","G"," ","lrw I",25,"Code 93"],["Code128","C"," ","lrwGI",20,"Code 128"],["ITF","I"," ","lrw I",3,"ITF"],["ITF14","I","4","lr  I",89,"ITF-14"],["DataBar","e"," ","lr GR",29,"DataBar"],["DataBarOmni","e","o","lr GR",29,"DataBar Omni"],["DataBarStk","e","s","lr GR",79,"DataBar Stacked"],["DataBarStkOmni","e","O","lr GR",80,"DataBar Stacked Omni"],["DataBarLtd","e","l","lr GR",30,"DataBar Limited"],["DataBarExp","e","e","lr GR",31,"DataBar Expanded"],["DataBarExpStk","e","E","lr GR",81,"DataBar Expanded Stacked"],["EANUPC","E"," ","lr  R",15,"EAN/UPC"],["EAN13","E","1","lrw R",15,"EAN-13"],["EAN8","E","8","lrw R",10,"EAN-8"],["EAN5","E","5","l   R",12,"EAN-5"],["EAN2","E","2","l   R",11,"EAN-2"],["ISBN","E","i","lr  R",69,"ISBN"],["UPCA","E","a","lrw R",34,"UPC-A"],["UPCE","E","e","lrw R",37,"UPC-E"],["Telepen","B"," ","lr  I",32,"Telepen"],["TelepenAlpha","B","0","lr  I",32,"Telepen Alpha"],["TelepenNumeric","B","1","lr  I",87,"Telepen Numeric"],["OtherBarcode","X"," "," r   ",0,"Other barcode"],["DXFilmEdge","X","x","lr   ",147,"DX Film Edge"],["PDF417","L"," ","mrw  ",55,"PDF417"],["CompactPDF417","L","c","mr   ",56,"Compact PDF417"],["MicroPDF417","L","m","mr   ",84,"MicroPDF417"],["Aztec","z"," ","mr G ",92,"Aztec"],["AztecCode","z","c","mrwG ",92,"Aztec Code"],["AztecRune","z","r","mr   ",128,"Aztec Rune"],["QRCode","Q"," ","mrwG ",58,"QR Code"],["QRCodeModel1","Q","1","mr   ",0,"QR Code Model 1"],["QRCodeModel2","Q","2","mr   ",58,"QR Code Model 2"],["MicroQRCode","Q","m","mr   ",97,"Micro QR Code"],["RMQRCode","Q","r","mr G ",145,"rMQR Code"],["DataMatrix","d"," ","mrwG ",71,"Data Matrix"],["MaxiCode","U"," ","mr   ",57,"MaxiCode"]],Yn={DataBarExpanded:"DataBarExp",DataBarLimited:"DataBarLtd","Linear-Codes":"AllLinear","Matrix-Codes":"AllMatrix",Any:"All",rMQRCode:"RMQRCode"};O.map(a=>a[5]);O.filter(a=>a[1]==="*").map(a=>a[0]);O.filter(a=>a[1]!=="*").map(a=>a[0]);O.filter(a=>a[2]===" ").map(a=>a[0]);O.filter(a=>a[3][0]==="l").map(a=>a[0]);O.filter(a=>a[3][0]==="m").map(a=>a[0]);O.filter(a=>a[3][1]==="r").map(a=>a[0]);O.filter(a=>a[3][2]==="w"||a[4]!==0).map(a=>a[0]);O.filter(a=>a[3][3]==="G").map(a=>a[0]);O.filter(a=>a[3][4]==="R").map(a=>a[0]);O.filter(a=>a[3][4]==="I").map(a=>a[0]);function Kn(a){var o;return(o=Yn[a])==null?a:o}var Jn={formats:[]};function Ct(a){var o;return{...a,image:(o=a.image&&new Blob([a.image],{type:"image/png"}))==null?null:o}}var $={format:"QRCode",readerInit:!1,forceSquareDataMatrix:!1,ecLevel:"",scale:1,sizeHint:0,rotate:0,invert:!1,withHRT:!1,withQuietZones:!0,addHRT:!1,addQuietZones:!0,options:""};function ra(a=$){var o,d;let{format:p=$.format,sizeHint:u=$.sizeHint,readerInit:g=$.readerInit,forceSquareDataMatrix:w=$.forceSquareDataMatrix,ecLevel:R=$.ecLevel,withHRT:y,withQuietZones:x,addHRT:I,addQuietZones:S,options:Q=$.options,scale:q,rotate:hr=$.rotate,invert:G=$.invert}=a,U=Q.split(",").map(Y=>Y.trim()).filter(Boolean),nr=Y=>{let gr=Y.split("=")[0];U.some(wr=>wr.split("=")[0]===gr)||U.push(Y)};g&&nr("readerInit"),w&&nr("forceSquare"),R&&nr(`ecLevel=${R}`);let pr=q??(u>0?-Math.trunc(Math.abs(u)):$.scale);return{format:Kn(p),options:U.join(","),scale:pr,rotate:hr,invert:G,addHRT:(o=I??y)==null?$.addHRT:o,addQuietZones:(d=S??x)==null?$.addQuietZones:d}}var ta={locateFile:(a,o)=>{let d=a.match(/_(.+?)\.wasm$/);return d?`https://fastly.jsdelivr.net/npm/zxing-wasm@3.1.0/dist/${d[1]}/${a}`:o+a}},Vr=new WeakMap;function ea(a,o){return Object.is(a,o)||Object.keys(a).length===Object.keys(o).length&&Object.keys(a).every(d=>Object.hasOwn(o,d)&&a[d]===o[d])}function Mt(a,{overrides:o,equalityFn:d=ea,fireImmediately:p=!1}={}){var u,g;let[w,R]=(u=Vr.get(a))==null?[ta]:u,y=o??w,x;if(p){if(R&&(x=d(w,y)))return R;let I=a({...y});return Vr.set(a,[y,I]),I}((g=x)==null?d(w,y):g)||Vr.set(a,[y])}async function na(a,o,d=$){let p=ra(d),u=await Mt(a,{fireImmediately:!0});if(typeof o=="string")return Ct(u.writeBarcodeFromText(o,p));let{byteLength:g}=o,w=u._malloc(g);if(!w)throw Error(`Failed to allocate ${g} bytes in WASM memory`);try{return u.HEAPU8.set(o,w),Ct(u.writeBarcodeFromBytes(w,g,p))}finally{u._free(w)}}[...Jn.formats];({...$});async function Dt(a={}){var o,d,p,u=a,g=!!globalThis.window,w=typeof Bun<"u",R=!!globalThis.WorkerGlobalScope;!((d=globalThis.process)==null||(d=d.versions)==null)&&d.node&&((p=globalThis.process)==null||p.type);var y="./this.program",x,I="";function S(r){return u.locateFile?u.locateFile(r,I):I+r}var Q,q;if(g||R||w){try{I=new URL(".",x).href}catch{}R&&(q=r=>{var t=new XMLHttpRequest;return t.open("GET",r,!1),t.responseType="arraybuffer",t.send(null),new Uint8Array(t.response)}),Q=async r=>{var t=await fetch(r,{credentials:"same-origin"});if(t.ok)return t.arrayBuffer();throw Error(t.status+" : "+t.url)}}var hr=console.log.bind(console),G=console.error.bind(console),U,nr=!1,pr,Y,gr=!1;function wr(){var r=Tr.buffer;K=new Int8Array(r),yr=new Int16Array(r),u.HEAPU8=z=new Uint8Array(r),sr=new Uint16Array(r),or=new Int32Array(r),_=new Uint32Array(r),Xr=new Float32Array(r),Yr=new Float64Array(r)}function Wt(){if(u.preRun)for(typeof u.preRun=="function"&&(u.preRun=[u.preRun]);u.preRun.length;)kt(u.preRun.shift());Kr(rt)}function Ft(){gr=!0,Er.oa()}function $t(){if(u.postRun)for(typeof u.postRun=="function"&&(u.postRun=[u.postRun]);u.postRun.length;)zt(u.postRun.shift());Kr(Jr)}function Pr(r){var t,e;(t=u.onAbort)==null||t.call(u,r),r="Aborted("+r+")",G(r),nr=!0,r+=". Build with -sASSERTIONS for more info.";var n=new WebAssembly.RuntimeError(r);throw(e=Y)==null||e(n),n}var mr;function St(){return S("zxing_writer.wasm")}function Pt(r){if(r==mr&&U)return new Uint8Array(U);if(q)return q(r);throw"both async and sync fetching of the wasm failed"}async function Qt(r){if(!U)try{var t=await Q(r);return new Uint8Array(t)}catch{}return Pt(r)}async function Bt(r,t){try{var e=await Qt(r);return await WebAssembly.instantiate(e,t)}catch(n){G(`failed to asynchronously prepare wasm: ${n}`),Pr(n)}}async function Ot(r,t,e){if(!r&&WebAssembly.instantiateStreaming)try{var n=fetch(t,{credentials:"same-origin"});return await WebAssembly.instantiateStreaming(n,e)}catch(i){G(`wasm streaming compile failed: ${i}`),G("falling back to ArrayBuffer instantiation")}return Bt(t,e)}function qt(){return{a:wn}}async function Ut(){function r(n,i){return Er=n.exports,gn(Er),wr(),Er}function t(n){return r(n.instance)}var e=qt();return u.instantiateWasm?new Promise((n,i)=>{u.instantiateWasm(e,(s,l)=>{n(r(s))})}):(mr!=null||(mr=St()),t(await Ot(U,mr,e)))}var yr,or,K,Xr,Yr,sr,_,z,Kr=r=>{for(;r.length>0;)r.shift()(u)},Jr=[],zt=r=>Jr.push(r),rt=[],kt=r=>rt.push(r),C=r=>gt(r),T=()=>wt(),vr=[],_r=0,jt=r=>{var t=new Qr(r);return t.get_caught()||(t.set_caught(!0),_r--),t.set_rethrown(!1),vr.push(t),vt(r)},k=0,Nt=()=>{b(0,0);var r=vr.pop();mt(r.excPtr),k=0};class Qr{constructor(t){this.excPtr=t,this.ptr=t-24}set_type(t){_[this.ptr+4>>2]=t}get_type(){return _[this.ptr+4>>2]}set_destructor(t){_[this.ptr+8>>2]=t}get_destructor(){return _[this.ptr+8>>2]}set_caught(t){t=+!!t,K[this.ptr+12]=t}get_caught(){return K[this.ptr+12]!=0}set_rethrown(t){t=+!!t,K[this.ptr+13]=t}get_rethrown(){return K[this.ptr+13]!=0}init(t,e){this.set_adjusted_ptr(0),this.set_type(t),this.set_destructor(e)}set_adjusted_ptr(t){_[this.ptr+16>>2]=t}get_adjusted_ptr(){return _[this.ptr+16>>2]}}var br=r=>pt(r),Br=r=>{var t=k;if(!t)return br(0),0;var e=new Qr(t);e.set_adjusted_ptr(t);var n=e.get_type();if(!n)return br(0),t;for(var i of r){if(i===0||i===n)break;var s=e.ptr+16;if(yt(i,n,s))return br(i),t}return br(n),t},Lt=()=>Br([]),Ht=r=>Br([r]),Vt=(r,t)=>Br([r,t]),Gt=()=>{var r=vr.pop();r||Pr("no exception to throw");var t=r.excPtr;throw r.get_rethrown()||(vr.push(r),r.set_rethrown(!0),r.set_caught(!1),_r++),jr(t),k=t,k},Zt=(r,t,e)=>{throw new Qr(r).init(t,e),jr(r),k=r,_r++,k},Xt=()=>_r,Yt=r=>{throw k||(k=r),k},tt=globalThis.TextDecoder&&new TextDecoder,et=(r,t,e,n)=>{var i=t+e;if(n)return i;for(;r[t]&&!(t>=i);)++t;return t},nt=function(r){let t=arguments.length>1&&arguments[1]!==void 0?arguments[1]:0,e=arguments.length>2?arguments[2]:void 0,n=arguments.length>3?arguments[3]:void 0;var i=et(r,t,e,n);if(i-t>16&&r.buffer&&tt)return tt.decode(r.subarray(t,i));for(var s="";t<i;){var l=r[t++];if(!(l&128)){s+=String.fromCharCode(l);continue}var c=r[t++]&63;if((l&224)==192){s+=String.fromCharCode((l&31)<<6|c);continue}var f=r[t++]&63;if(l=(l&240)==224?(l&15)<<12|c<<6|f:(l&7)<<18|c<<12|f<<6|r[t++]&63,l<65536)s+=String.fromCharCode(l);else{var h=l-65536;s+=String.fromCharCode(55296|h>>10,56320|h&1023)}}return s},Kt=(r,t,e)=>r?nt(z,r,t,e):"";function Jt(r,t,e){return 0}function re(r,t,e){return 0}var te=(r,t,e)=>{};function ee(r,t,e,n){}var ne=(r,t)=>{},ae=()=>Pr(""),Ar={},Or=r=>{for(;r.length;){var t=r.pop();r.pop()(t)}};function Rr(r){return this.fromWireType(_[r>>2])}var ar={},J={},Cr={},ie=class extends Error{constructor(r){super(r),this.name="InternalError"}},at=r=>{throw new ie(r)},it=(r,t,e)=>{r.forEach(c=>Cr[c]=t);function n(c){var f=e(c);f.length!==r.length&&at("Mismatched type converter count");for(var h=0;h<r.length;++h)j(r[h],f[h])}var i=Array(t.length),s=[],l=0;{let c=t;for(let f=0;f<c.length;++f){let h=c[f];J.hasOwnProperty(h)?i[f]=J[h]:(s.push(h),ar.hasOwnProperty(h)||(ar[h]=[]),ar[h].push(()=>{i[f]=J[h],++l,l===s.length&&n(i)}))}}s.length===0&&n(i)},oe=r=>{var t=Ar[r];delete Ar[r];var e=t.rawConstructor,n=t.rawDestructor,i=t.fields,s=i.map(l=>l.getterReturnType).concat(i.map(l=>l.setterArgumentType));it([r],s,l=>{var c={};{let f=i;for(let h=0;h<f.length;++h){let m=f[h],E=l[h],D=m.getter,W=m.getterContext,M=l[h+i.length],F=m.setter,cr=m.setterContext;c[m.fieldName]={read:L=>E.fromWireType(D(W,L)),write:(L,X)=>{var xr=[];F(cr,L,M.toWireType(xr,X)),Or(xr)},optional:E.optional}}}return[{name:t.name,fromWireType:f=>{var h={};for(var m in c)h[m]=c[m].read(f);return n(f),h},toWireType:(f,h)=>{for(var m in c)if(!(m in h)&&!c[m].optional)throw TypeError(`Missing field: "${m}"`);var E=e();for(m in c)c[m].write(E,h[m]);return f!==null&&f.push(n,E),E},readValueFromPointer:Rr,destructorFunction:n}]})},se=(r,t,e,n,i)=>{},P=r=>{for(var t="";;){var e=z[r++];if(!e)return t;t+=String.fromCharCode(e)}},ue=class extends Error{constructor(r){super(r),this.name="BindingError"}},B=r=>{throw new ue(r)};function le(r,t){let e=arguments.length>2&&arguments[2]!==void 0?arguments[2]:{};var n=t.name;if(r||B(`type "${n}" must have a positive integer typeid pointer`),J.hasOwnProperty(r)){if(e.ignoreDuplicateRegistrations)return;B(`Cannot register type '${n}' twice`)}if(J[r]=t,delete Cr[r],ar.hasOwnProperty(r)){var i=ar[r];delete ar[r],i.forEach(s=>s())}}function j(r,t){return le(r,t,arguments.length>2&&arguments[2]!==void 0?arguments[2]:{})}var ce=(r,t,e,n)=>{t=P(t),j(r,{name:t,fromWireType:function(i){return!!i},toWireType:function(i,s){return s?e:n},readValueFromPointer:function(i){return this.fromWireType(z[i])},destructorFunction:null})},ot=[],rr=[0,1,,1,null,1,!0,1,!1,1],qr=r=>{r>9&&--rr[r+1]===0&&(rr[r]=void 0,ot.push(r))},N={toValue:r=>(r||B(`Cannot use deleted val. handle = ${r}`),rr[r]),toHandle:r=>{switch(r){case void 0:return 2;case null:return 4;case!0:return 6;case!1:return 8;default:{let t=ot.pop()||rr.length;return rr[t]=r,rr[t+1]=1,t}}}},fe={name:"emscripten::val",fromWireType:r=>{var t=N.toValue(r);return qr(r),t},toWireType:(r,t)=>N.toHandle(t),readValueFromPointer:Rr,destructorFunction:null},de=r=>j(r,fe),he=(r,t)=>{switch(t){case 4:return function(e){return this.fromWireType(Xr[e>>2])};case 8:return function(e){return this.fromWireType(Yr[e>>3])};default:throw TypeError(`invalid float width (${t}): ${r}`)}},pe=(r,t,e)=>{t=P(t),j(r,{name:t,fromWireType:n=>n,toWireType:(n,i)=>i,readValueFromPointer:he(t,e),destructorFunction:null})},st=(r,t)=>Object.defineProperty(t,"name",{value:r});function ge(r){for(var t=1;t<r.length;++t)if(r[t]!==null&&r[t].destructorFunction===void 0)return!0;return!1}function we(r,t,e,n,i,s){var l=t.length;l<2&&B("argTypes array size mismatch! Must at least get return value and 'this' types!"),t[1];var c=ge(t),f=!t[0].isVoid,h=l-2,m=Array(h),E=[],D=[];return st(r,function(){D.length=0;var W;E.length=1,E[0]=i;for(var M=0;M<h;++M)m[M]=t[M+2].toWireType(D,M<0||arguments.length<=M?void 0:arguments[M]),E.push(m[M]);var F=n(...E);function cr(L){if(c)Or(D);else for(var X=2;X<t.length;X++){var xr=X===1?W:m[X-2];t[X].destructorFunction!==null&&t[X].destructorFunction(xr)}if(f)return t[0].fromWireType(L)}return cr(F)})}var me=(r,t,e)=>{if(r[t].overloadTable===void 0){var n=r[t];r[t]=function(){var i=[...arguments];return r[t].overloadTable.hasOwnProperty(i.length)||B(`Function '${e}' called with an invalid number of arguments (${i.length}) - expects one of (${r[t].overloadTable})!`),r[t].overloadTable[i.length].apply(this,i)},r[t].overloadTable=[],r[t].overloadTable[n.argCount]=n}},ye=(r,t,e)=>{u.hasOwnProperty(r)?((e===void 0||u[r].overloadTable!==void 0&&u[r].overloadTable[e]!==void 0)&&B(`Cannot register public name '${r}' twice`),me(u,r,r),u[r].overloadTable.hasOwnProperty(e)&&B(`Cannot register multiple overloads of a function with the same number of arguments (${e})!`),u[r].overloadTable[e]=t):(u[r]=t,u[r].argCount=e)},ve=(r,t)=>{for(var e=[],n=0;n<r;n++)e.push(_[t+n*4>>2]);return e},_e=(r,t,e)=>{u.hasOwnProperty(r)||at("Replacing nonexistent public symbol"),u[r].overloadTable!==void 0&&e!==void 0?u[r].overloadTable[e]=t:(u[r]=t,u[r].argCount=e)},tr={},be=(r,t,e)=>{r=r.replace(/p/g,"i");var n=tr[r];return n(t,...e)},ut=[],A=r=>{var t=ut[r];return t||(ut[r]=t=bt.get(r)),t},Ae=function(r,t){let e=arguments.length>2&&arguments[2]!==void 0?arguments[2]:[];if(r.includes("j"))return be(r,t,e);var n=A(t)(...e);function i(s){return s}return n},Re=function(r,t){let e=arguments.length>2&&arguments[2]!==void 0?arguments[2]:!1;return function(){return Ae(r,t,[...arguments],e)}},ur=function(r,t){r=P(r);function e(){return r.includes("j")?Re(r,t):A(t)}var n=e();return typeof n!="function"&&B(`unknown function pointer with signature ${r}: ${t}`),n};class Ce extends Error{}var lt=r=>{var t=ht(r),e=P(t);return Z(t),e},Te=(r,t)=>{var e=[],n={};function i(s){if(!n[s]&&!J[s]){if(Cr[s]){Cr[s].forEach(i);return}e.push(s),n[s]=!0}}throw t.forEach(i),new Ce(`${r}: `+e.map(lt).join([", "]))},Ee=r=>{r=r.trim();let t=r.indexOf("(");return t===-1?r:r.slice(0,t)},xe=(r,t,e,n,i,s,l,c)=>{var f=ve(t,e);r=P(r),r=Ee(r),i=ur(n,i),ye(r,function(){Te(`Cannot call ${r} due to unbound types`,f)},t-1),it([],f,h=>{var m=[h[0],null].concat(h.slice(1));return _e(r,we(r,m,null,i,s),t-1),[]})},Ie=(r,t,e)=>{switch(t){case 1:return e?n=>K[n]:n=>z[n];case 2:return e?n=>yr[n>>1]:n=>sr[n>>1];case 4:return e?n=>or[n>>2]:n=>_[n>>2];default:throw TypeError(`invalid integer width (${t}): ${r}`)}},Me=(r,t,e,n,i)=>{t=P(t);let s=n===0,l=f=>f;if(s){var c=32-8*e;l=f=>f<<c>>>c,i=l(i)}j(r,{name:t,fromWireType:l,toWireType:(f,h)=>h,readValueFromPointer:Ie(t,e,n!==0),destructorFunction:null})},De=(r,t,e)=>{var n=[Int8Array,Uint8Array,Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array][t];function i(s){var l=_[s>>2],c=_[s+4>>2];return new n(K.buffer,c,l)}e=P(e),j(r,{name:e,fromWireType:i,readValueFromPointer:i},{ignoreDuplicateRegistrations:!0})},We=(r,t,e,n)=>{if(!(n>0))return 0;for(var i=e,s=e+n-1,l=0;l<r.length;++l){var c=r.codePointAt(l);if(c<=127){if(e>=s)break;t[e++]=c}else if(c<=2047){if(e+1>=s)break;t[e++]=192|c>>6,t[e++]=128|c&63}else if(c<=65535){if(e+2>=s)break;t[e++]=224|c>>12,t[e++]=128|c>>6&63,t[e++]=128|c&63}else{if(e+3>=s)break;t[e++]=240|c>>18,t[e++]=128|c>>12&63,t[e++]=128|c>>6&63,t[e++]=128|c&63,l++}}return t[e]=0,e-i},ir=(r,t,e)=>We(r,z,t,e),ct=r=>{for(var t=0,e=0;e<r.length;++e){var n=r.charCodeAt(e);n<=127?t++:n<=2047?t+=2:n>=55296&&n<=57343?(t+=4,++e):t+=3}return t},Fe=(r,t)=>{t=P(t),j(r,{name:t,fromWireType(e){var n=_[e>>2],i=e+4,s;return s=Kt(i,n,!0),Z(e),s},toWireType(e,n){n instanceof ArrayBuffer&&(n=new Uint8Array(n));var i,s=typeof n=="string";s||ArrayBuffer.isView(n)&&n.BYTES_PER_ELEMENT==1||B("Cannot pass non-string to std::string"),i=s?ct(n):n.length;var l=kr(4+i+1),c=l+4;return _[l>>2]=i,s?ir(n,c,i+1):z.set(n,c),e!==null&&e.push(Z,l),l},readValueFromPointer:Rr,destructorFunction(e){Z(e)}})},ft=globalThis.TextDecoder?new TextDecoder("utf-16le"):void 0,$e=(r,t,e)=>{var n=r>>1,i=et(sr,n,t/2,e);if(i-n>16&&ft)return ft.decode(sr.subarray(n,i));for(var s="",l=n;l<i;++l){var c=sr[l];s+=String.fromCharCode(c)}return s},Se=(r,t,e)=>{if(e!=null||(e=2147483647),e<2)return 0;e-=2;for(var n=t,i=e<r.length*2?e/2:r.length,s=0;s<i;++s){var l=r.charCodeAt(s);yr[t>>1]=l,t+=2}return yr[t>>1]=0,t-n},Pe=r=>r.length*2,Qe=(r,t,e)=>{for(var n="",i=r>>2,s=0;!(s>=t/4);s++){var l=_[i+s];if(!l&&!e)break;n+=String.fromCodePoint(l)}return n},Be=(r,t,e)=>{if(e!=null||(e=2147483647),e<4)return 0;for(var n=t,i=n+e-4,s=0;s<r.length;++s){var l=r.codePointAt(s);if(l>65535&&s++,or[t>>2]=l,t+=4,t+4>i)break}return or[t>>2]=0,t-n},Oe=r=>{for(var t=0,e=0;e<r.length;++e)r.codePointAt(e)>65535&&e++,t+=4;return t},qe=(r,t,e)=>{e=P(e);var n,i,s;t===2?(n=$e,i=Se,s=Pe):(n=Qe,i=Be,s=Oe),j(r,{name:e,fromWireType:l=>{var c=_[l>>2],f=n(l+4,c*t,!0);return Z(l),f},toWireType:(l,c)=>{typeof c!="string"&&B(`Cannot pass non-string to C++ string type ${e}`);var f=s(c),h=kr(4+f+t);return _[h>>2]=f/t,i(c,h+4,f+t),l!==null&&l.push(Z,h),h},readValueFromPointer:Rr,destructorFunction(l){Z(l)}})},Ue=(r,t,e,n,i,s)=>{Ar[r]={name:P(t),rawConstructor:ur(e,n),rawDestructor:ur(i,s),fields:[]}},ze=(r,t,e,n,i,s,l,c,f,h)=>{Ar[r].fields.push({fieldName:P(t),getterReturnType:e,getter:ur(n,i),getterContext:s,setterArgumentType:l,setter:ur(c,f),setterContext:h})},ke=(r,t)=>{t=P(t),j(r,{isVoid:!0,name:t,fromWireType:()=>{},toWireType:(e,n)=>{}})},Ur=[],je=r=>{var t=Ur.length;return Ur.push(r),t},Ne=(r,t)=>{var e=J[r];return e===void 0&&B(`${t} has unknown type ${lt(r)}`),e},Le=(r,t)=>{for(var e=Array(r),n=0;n<r;++n)e[n]=Ne(_[t+n*4>>2],`parameter ${n}`);return e},He=(r,t,e)=>{var n=[],i=r(n,e);return n.length&&(_[t>>2]=N.toHandle(n)),i},Ve={},dt=r=>{var t=Ve[r];return t===void 0?P(r):t},Ge=(r,t,e)=>{var n=8,[i,...s]=Le(r,t),l=i.toWireType.bind(i),c=s.map(h=>h.readValueFromPointer.bind(h));r--;var f=Array(r);return je(st(`methodCaller<(${s.map(h=>h.name)}) => ${i.name}>`,(h,m,E,D)=>{for(var W=0,M=0;M<r;++M)f[M]=c[M](D+W),W+=n;var F;switch(e){case 0:F=N.toValue(h).apply(null,f);break;case 2:F=Reflect.construct(N.toValue(h),f);break;case 3:F=f[0];break;case 1:F=N.toValue(h)[dt(m)](...f);break}return He(l,E,F)}))},Ze=r=>r?(r=dt(r),N.toHandle(globalThis[r])):N.toHandle(globalThis),Xe=r=>{r>9&&(rr[r+1]+=1)},Ye=(r,t,e,n,i)=>Ur[r](t,e,n,i),Ke=r=>{Or(N.toValue(r)),qr(r)},Je=(r,t,e,n)=>{var i=new Date().getFullYear(),s=new Date(i,0,1),l=new Date(i,6,1),c=s.getTimezoneOffset(),f=l.getTimezoneOffset(),h=Math.max(c,f);_[r>>2]=h*60,or[t>>2]=+(c!=f);var m=W=>{var M=W>=0?"-":"+",F=Math.abs(W);return`UTC${M}${String(Math.floor(F/60)).padStart(2,"0")}${String(F%60).padStart(2,"0")}`},E=m(c),D=m(f);f<c?(ir(E,e,17),ir(D,n,17)):(ir(E,n,17),ir(D,e,17))},rn=()=>2147483648,tn=(r,t)=>Math.ceil(r/t)*t,en=r=>{var t=(r-Tr.buffer.byteLength+65535)/65536|0;try{return Tr.grow(t),wr(),1}catch{}},nn=r=>{var t=z.length;r>>>=0;var e=rn();if(r>e)return!1;for(var n=1;n<=4;n*=2){var i=t*(1+.2/n);if(i=Math.min(i,r+100663296),en(Math.min(e,tn(Math.max(r,i),65536))))return!0}return!1},zr={},an=()=>y||"./this.program",lr=()=>{if(!lr.strings){var r,t,e={USER:"web_user",LOGNAME:"web_user",PATH:"/",PWD:"/",HOME:"/home/web_user",LANG:((r=(t=globalThis.navigator)==null?void 0:t.language)==null?"C":r).replace("-","_")+".UTF-8",_:an()};for(var n in zr)zr[n]===void 0?delete e[n]:e[n]=zr[n];var i=[];for(var n in e)i.push(`${n}=${e[n]}`);lr.strings=i}return lr.strings},on=(r,t)=>{var e=0,n=0;for(var i of lr()){var s=t+e;_[r+n>>2]=s,e+=ir(i,s,1/0)+1,n+=4}return 0},sn=(r,t)=>{var e=lr();_[r>>2]=e.length;var n=0;for(var i of e)n+=ct(i)+1;return _[t>>2]=n,0},un=r=>52,ln=(r,t,e,n)=>52;function cn(r,t,e,n,i){return 70}var fn=[null,[],[]],dn=(r,t)=>{var e=fn[r];t===0||t===10?((r===1?hr:G)(nt(e)),e.length=0):e.push(t)},hn=(r,t,e,n)=>{for(var i=0,s=0;s<e;s++){var l=_[t>>2],c=_[t+4>>2];t+=8;for(var f=0;f<c;f++)dn(r,z[l+f]);i+=c}return _[n>>2]=i,0},pn=r=>r;if(u.noExitRuntime&&u.noExitRuntime,u.print&&(hr=u.print),u.printErr&&(G=u.printErr),u.wasmBinary&&(U=u.wasmBinary),u.arguments&&u.arguments,u.thisProgram&&(y=u.thisProgram),u.preInit)for(typeof u.preInit=="function"&&(u.preInit=[u.preInit]);u.preInit.length>0;)u.preInit.shift()();var ht,kr,Z,b,pt,gt,wt,mt,jr,yt,vt,_t,Tr,bt;function gn(r){ht=r.pa,kr=u._malloc=r.ra,Z=u._free=r.sa,b=r.ta,pt=r.ua,gt=r.va,wt=r.wa,mt=r.xa,jr=r.ya,yt=r.za,vt=r.Aa,tr.jiji=r.Ba,tr.viijii=r.Ca,_t=tr.jiiii=r.Da,tr.iiiiij=r.Ea,tr.iiiiijj=r.Fa,tr.iiiiiijj=r.Ga,Tr=r.na,bt=r.qa}var wn={t:jt,u:Nt,a:Lt,g:Ht,v:Vt,_:Gt,p:Zt,Z:Xt,e:Yt,L:Jt,da:re,ba:te,ea:ee,aa:ne,U:ae,ka:oe,T:se,ia:ce,ga:de,M:pe,N:xe,s:Me,n:De,ha:Fe,E:qe,F:Ue,la:ze,ja:ke,C:Ge,ma:qr,Q:Ze,G:Xe,A:Ye,W:Ke,V:Je,$:nn,X:on,Y:sn,J:un,ca:ln,S:cn,K:hn,H:Pn,O:Tn,I:Sn,l:Qn,b:Rn,c:bn,f:Cn,j:Mn,D:Dn,r:Fn,B:$n,x:On,R:Un,k:An,i:mn,d:vn,h:_n,o:yn,y:Wn,z:xn,q:Bn,fa:In,m:En,w:qn,P:pn};function mn(r,t){var e=T();try{A(r)(t)}catch(n){if(C(e),n!==n+0)throw n;b(1,0)}}function yn(r,t,e,n,i){var s=T();try{A(r)(t,e,n,i)}catch(l){if(C(s),l!==l+0)throw l;b(1,0)}}function vn(r,t,e){var n=T();try{A(r)(t,e)}catch(i){if(C(n),i!==i+0)throw i;b(1,0)}}function _n(r,t,e,n){var i=T();try{A(r)(t,e,n)}catch(s){if(C(i),s!==s+0)throw s;b(1,0)}}function bn(r,t,e){var n=T();try{return A(r)(t,e)}catch(i){if(C(n),i!==i+0)throw i;b(1,0)}}function An(r){var t=T();try{A(r)()}catch(e){if(C(t),e!==e+0)throw e;b(1,0)}}function Rn(r,t){var e=T();try{return A(r)(t)}catch(n){if(C(e),n!==n+0)throw n;b(1,0)}}function Cn(r,t,e,n){var i=T();try{return A(r)(t,e,n)}catch(s){if(C(i),s!==s+0)throw s;b(1,0)}}function Tn(r,t,e,n,i,s){var l=T();try{return A(r)(t,e,n,i,s)}catch(c){if(C(l),c!==c+0)throw c;b(1,0)}}function En(r,t,e,n,i,s,l,c,f,h,m){var E=T();try{A(r)(t,e,n,i,s,l,c,f,h,m)}catch(D){if(C(E),D!==D+0)throw D;b(1,0)}}function xn(r,t,e,n,i,s,l){var c=T();try{A(r)(t,e,n,i,s,l)}catch(f){if(C(c),f!==f+0)throw f;b(1,0)}}function In(r,t,e,n,i,s,l,c,f){var h=T();try{A(r)(t,e,n,i,s,l,c,f)}catch(m){if(C(h),m!==m+0)throw m;b(1,0)}}function Mn(r,t,e,n,i){var s=T();try{return A(r)(t,e,n,i)}catch(l){if(C(s),l!==l+0)throw l;b(1,0)}}function Dn(r,t,e,n,i,s){var l=T();try{return A(r)(t,e,n,i,s)}catch(c){if(C(l),c!==c+0)throw c;b(1,0)}}function Wn(r,t,e,n,i,s){var l=T();try{A(r)(t,e,n,i,s)}catch(c){if(C(l),c!==c+0)throw c;b(1,0)}}function Fn(r,t,e,n,i,s,l){var c=T();try{return A(r)(t,e,n,i,s,l)}catch(f){if(C(c),f!==f+0)throw f;b(1,0)}}function $n(r,t,e,n,i,s,l,c){var f=T();try{return A(r)(t,e,n,i,s,l,c)}catch(h){if(C(f),h!==h+0)throw h;b(1,0)}}function Sn(r,t,e,n){var i=T();try{return A(r)(t,e,n)}catch(s){if(C(i),s!==s+0)throw s;b(1,0)}}function Pn(r,t,e,n){var i=T();try{return A(r)(t,e,n)}catch(s){if(C(i),s!==s+0)throw s;b(1,0)}}function Qn(r){var t=T();try{return A(r)()}catch(e){if(C(t),e!==e+0)throw e;b(1,0)}}function Bn(r,t,e,n,i,s,l,c){var f=T();try{A(r)(t,e,n,i,s,l,c)}catch(h){if(C(f),h!==h+0)throw h;b(1,0)}}function On(r,t,e,n,i,s,l,c,f,h,m,E){var D=T();try{return A(r)(t,e,n,i,s,l,c,f,h,m,E)}catch(W){if(C(D),W!==W+0)throw W;b(1,0)}}function qn(r,t,e,n,i,s,l,c,f,h,m,E,D,W,M,F){var cr=T();try{A(r)(t,e,n,i,s,l,c,f,h,m,E,D,W,M,F)}catch(L){if(C(cr),L!==L+0)throw L;b(1,0)}}function Un(r,t,e,n,i){var s=T();try{return _t(r,t,e,n,i)}catch(l){if(C(s),l!==l+0)throw l;b(1,0)}}function zn(){Wt();function r(){var t,e;u.calledRun=!0,!nr&&(Ft(),(t=pr)==null||t(u),(e=u.onRuntimeInitialized)==null||e.call(u),$t())}u.setStatus?(u.setStatus("Running..."),setTimeout(()=>{setTimeout(()=>u.setStatus(""),1),r()},1)):r()}var Er=await Ut();return zn(),o=gr?u:new Promise((r,t)=>{pr=r,Y=t}),o}function aa(a){return Mt(Dt,a)}async function ia(a,o){return na(Dt,a,o)}var oa=""+new URL(__RQR_WASM_URL("zxing_writer-NQHybxPU.wasm"),import.meta.url).href;const sa=[[1,26,19],[1,26,16],[1,26,13],[1,26,9],[1,44,34],[1,44,28],[1,44,22],[1,44,16],[1,70,55],[1,70,44],[2,35,17],[2,35,13],[1,100,80],[2,50,32],[2,50,24],[4,25,9],[1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],[2,86,68],[4,43,27],[4,43,19],[4,43,15],[2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],[2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],[4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],[4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],[3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],[5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],[5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],[1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],[5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],[3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],[3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],[4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],[2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],[4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],[6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],[8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],[10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],[8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],[3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],[7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],[5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],[13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],[17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],[17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],[13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],[12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],[6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],[17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],[4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],[20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],[19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]],ua={L:0,M:1,Q:2,H:3},la=20;function ca(a,o){return fa(a,o,la)}function fa(a,o,d){const p=da(a,o),g=4+(a<=9?8:16)+d;return Math.max(0,Math.floor((p*8-g)/8))}function da(a,o){const d=(a-1)*4+ua[o],p=sa[d];if(!p)throw new Error(`No RS block table entry for V${a}-${o}`);let u=0;for(let g=0;g<p.length;g+=3)u+=p[g]*p[g+2];return u}let Gr=null;async function ha(a,o,d,p){const u=await pa(a,o,d,p),g=o*4+17;if(u.width===g&&u.height===g)return ma(u,p);const w=va(o,p);if(u.width===w&&u.height===w)return wa(u);throw new Error(`ZXing QR writer returned ${u.width}x${u.height}, expected ${g}x${g} modules or ${w}x${w} pixels for V${o}-${d} at scale ${p}.`)}async function pa(a,o,d,p){ya(o,d,p,a.length),await ga();const u={format:"QRCode",options:`version=${o},ecLevel=${d}`,scale:p,addQuietZones:!0,addHRT:!1},g=await ia(a,u);if(g.error)throw new Error(`ZXing QR writer failed: ${g.error}`);return g.symbol}function ga(){return Gr||(Gr=Promise.resolve(aa({overrides:{locateFile:a=>a.endsWith(".wasm")?oa:a},equalityFn:Object.is,fireImmediately:!0}))),Gr}function wa(a){if(a.data.length!==a.width*a.height)throw new Error(`ZXing QR symbol buffer size mismatch: ${a.data.length} bytes for ${a.width}x${a.height}.`);const o=new Uint8ClampedArray(a.width*a.height*4);for(let d=0;d<a.data.length;d++){const p=a.data[d]===0?0:255,u=d*4;o[u]=p,o[u+1]=p,o[u+2]=p,o[u+3]=255}return new ImageData(o,a.width,a.height)}function ma(a,o){if(a.data.length!==a.width*a.height)throw new Error(`ZXing QR symbol buffer size mismatch: ${a.data.length} bytes for ${a.width}x${a.height}.`);const d=4,p=(a.width+d*2)*o,u=new Uint8ClampedArray(p*p*4);u.fill(255);for(let g=0;g<a.height;g++)for(let w=0;w<a.width;w++){if(a.data[g*a.width+w]!==0)continue;const R=(w+d)*o,y=(g+d)*o;for(let x=0;x<o;x++){const I=((y+x)*p+R)*4;for(let S=0;S<o;S++){const Q=I+S*4;u[Q]=0,u[Q+1]=0,u[Q+2]=0,u[Q+3]=255}}}return new ImageData(u,p,p)}function ya(a,o,d,p){if(!Number.isInteger(a)||a<1||a>40)throw new RangeError(`Invalid QR version: ${a}. Must be 1-40.`);if(o!=="L"&&o!=="M"&&o!=="Q"&&o!=="H")throw new RangeError(`Invalid QR ECC level: ${o}.`);if(!Number.isInteger(d)||d<1)throw new RangeError(`Invalid QR render scale: ${d}.`);if(p!==void 0){const u=ca(a,o);if(p>u)throw new Error(`Data too large for ZXing QR writer V${a}-${o}. Maximum ${u} bytes for binary Uint8Array payload, got ${p}.`)}}function va(a,o){return(a*4+17+8)*o}const _a="fast-qr-wasm";function ba(a){switch(a){case"fast-qr-wasm":case"fast_qr_wasm":case"fastQrWasm":return"fast-qr-wasm";case"zxing-wasm":case"zxing":case"zxingWasm":return"zxing-wasm";case"color-cimbar":case"colorCimbar":return"color-cimbar";default:return _a}}const Aa={L:0,M:1,Q:2,H:3};let Mr=null;async function Ra(a,o,d,p,u="fast-qr-wasm"){switch(u){case"fast-qr-wasm":return Ta(a,o,d,p);case"zxing-wasm":return ha(a,o,d,p)}}async function Ca(){Mr||(Mr=Et().then(()=>new $r).catch(o=>{Mr=null;const d=o instanceof Error?o.message:String(o);throw new Error(`${Zr()} ${d}`)}));const a=await Mr;if(!a||!xt())throw new Error(Zr());return a}async function Ta(a,o,d,p){const u=await Ca(),g=Aa[d],w=u.render_rgba(a,o,g,p),R=w*w*4,y=It(),x=u.rgba_ptr(),I=new Uint8ClampedArray(y.buffer,x,R),S=new Uint8ClampedArray(R);return S.set(I),new ImageData(S,w,w)}const Ea={L:0,M:1,Q:2,H:3};let Fr=null;const xa=Et().then(()=>(Fr=new $r,Fr)).catch(()=>(Fr=null,null));self.onmessage=a=>{const o=a.data;o.type==="render"&&Ia(o)};async function Ia(a){try{const o=new Uint8Array(a.packet),d=ba(a.qrEncoder);let p,u,g;if(d==="color-cimbar"){const r0=CimQR.render(o,a.scale||1);p=r0.data.buffer,u=r0.width,g=r0.height}else if(Ma(d)){const w=Fr??await xa;if(xt()&&w!==null){const R=Ea[a.ecc],y=w.render_rgba(o,a.version,R,a.scale),x=y*y*4,I=It(),S=w.rgba_ptr(),Q=new Uint8ClampedArray(I.buffer,S,x),q=new Uint8ClampedArray(x);q.set(Q),p=q.buffer,u=y,g=y}else throw new Error(Zr())}else{const w=await Ra(o,a.version,a.ecc,a.scale,d);p=w.data.buffer.slice(w.data.byteOffset,w.data.byteOffset+w.data.byteLength),u=w.width,g=w.height}self.postMessage({type:"rendered",buffer:p,width:u,height:g,jobId:a.jobId},{transfer:[p]})}catch(o){self.postMessage({type:"error",message:o instanceof Error?o.message:String(o),jobId:a.jobId})}}function Ma(a){const o=String(a);return o==="fast-qr-wasm"||o==="fast_qr_wasm"||o==="fastQrWasm"}
