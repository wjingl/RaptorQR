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
  var DATA_CELLS = 12152; // 数据格总数
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
    var list = [], c, r;
    for (r = 0; r < GRID; r++) {
      for (c = 0; c < GRID; c++) {
        var corner = (c < CP && r < CP) || (c >= GRID - CP && r < CP) || (c < CP && r >= GRID - CP) || (c >= GRID - CP && r >= GRID - CP);
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

  function drawFinder(buf, x0, y0, stride) {
    // 7×7 寻像图形，每模块 8px
    for (var y = 0; y < 7; y++) {
      for (var x = 0; x < 7; x++) {
        var dark = (y === 0 || y === 6 || x === 0 || x === 6) || (y >= 2 && y <= 4 && x >= 2 && x <= 4);
        var v = dark ? 0 : 255;
        for (var py = 0; py < 8; py++)
          for (var px = 0; px < 8; px++) {
            var o = ((y0 + y * 8 + py) * stride + (x0 + x * 8 + px)) * 4;
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

  function renderFrame(packet) {
    var buf = new Uint8ClampedArray(RENDER_IMG * RENDER_IMG * 4);
    var x, y, o;
    // 背景白（静区）
    for (o = 0; o < buf.length; o += 4) { buf[o] = 255; buf[o + 1] = 255; buf[o + 2] = 255; buf[o + 3] = 255; }
    var M = MARGIN;

    // 三个寻像图形
    drawFinder(buf, M + 0, M + 0, RENDER_IMG);       // TL
    drawFinder(buf, M + IMG - 64, M + 0, RENDER_IMG); // TR
    drawFinder(buf, M + 0, M + IMG - 64, RENDER_IMG); // BL
    // 分隔带（白）
    drawSolid(buf, M + 56, M + 0, 8, 64, 255, RENDER_IMG);
    drawSolid(buf, M + 0, M + 56, 64, 8, 255, RENDER_IMG);
    drawSolid(buf, M + 952, M + 0, 8, 64, 255, RENDER_IMG);
    drawSolid(buf, M + 960, M + 56, 64, 8, 255, RENDER_IMG);
    drawSolid(buf, M + 0, M + 952, 64, 8, 255, RENDER_IMG);
    drawSolid(buf, M + 56, M + 960, 8, 64, 255, RENDER_IMG);

    // 时序图形（顶部 y=56..64，x=64..952；左侧 x=56..64，y=64..952）黑白交替
    for (var k = 0; k < 111; k++) {
      var dk = (k % 2 === 0);
      if (64 + k * 8 < 952) drawSolid(buf, M + 64 + k * 8, M + 56, 8, 8, dk ? 0 : 255, RENDER_IMG);
      if (64 + k * 8 < 952) drawSolid(buf, M + 56, M + 64 + k * 8, 8, 8, dk ? 0 : 255, RENDER_IMG);
    }
    // BR 辅助标记（QR 对齐图案 5×5，不影响数据格——该区域被排除）
    {
      var bx = 952, by = 952;
      for (y = 0; y < 5; y++)
        for (x = 0; x < 5; x++) {
          var bd = (y === 0 || y === 4 || x === 0 || x === 4) || (y === 2 && x === 2);
          var bv = bd ? 0 : 255;
          drawSolid(buf, M + bx + x * 8, M + by + y * 8, 8, 8, bv, RENDER_IMG);
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
    for (i = 0; i < DATA_CELLS; i++) {
      var gridIdx = cellPos[perm[i]];
      var cc = gridIdx % GRID, cr = (gridIdx / GRID) | 0;
      var v = cellVals[i];
      var tile = tileCache[v >> SYMBOL_BITS][v & 15];
      var x0 = M + OFFSET + cc * PITCH, y0 = M + OFFSET + cr * PITCH;
      var ti = 0;
      for (y = 0; y < 8; y++) {
        var rowO = ((y0 + y) * RENDER_IMG + x0) * 4;
        for (x = 0; x < 8; x++) {
          var co = rowO + x * 4;
          var r = tile[ti], g2 = tile[ti + 1], b2 = tile[ti + 2], a2 = tile[ti + 3];
          if (a2) { buf[co] = r; buf[co + 1] = g2; buf[co + 2] = b2; buf[co + 3] = 255; }
          ti += 4;
        }
      }
    }
    return { data: buf, width: RENDER_IMG, height: RENDER_IMG };
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

  function detectFinders(gray, w, h) {
    var candidates = [];
    var i, j, x, y;
    var thr = 120;
    var MIN_MODULE = 2.5;
    for (y = 0; y < h; y += 1) {
      var prevDark = null, run = 0;
      var runs = [];
      var base = y * w;
      for (x = 0; x < w; x++) {
        var dark = gray[base + x] < thr;
        if (prevDark === null) { prevDark = dark; run = 1; }
        else if (dark === prevDark) run++;
        else { runs.push({ d: prevDark, l: run }); prevDark = dark; run = 1; }
      }
      if (run > 0) runs.push({ d: prevDark, l: run });
      for (i = 0; i + 4 < runs.length; i++) {
        if (!(runs[i].d && !runs[i + 1].d && runs[i + 2].d && !runs[i + 3].d && runs[i + 4].d)) continue;
        var lens = [runs[i].l, runs[i + 1].l, runs[i + 2].l, runs[i + 3].l, runs[i + 4].l];
        var module = lens[2] / 3;
        if (module < MIN_MODULE || !ratioOK(lens)) continue;
        var startX = 0;
        for (j = 0; j < i; j++) startX += runs[j].l;
        var centerX = startX + lens[0] + lens[1] + lens[2] / 2;
        // 相邻行验证：±1 模块处也应出现 1:1:3:1:1 且中心接近
        var rows = [y, Math.max(0, Math.round(y - module * 0.6)), Math.min(h - 1, Math.round(y + module * 0.6))];
        var accX = 0, accY = 0, accW = 0, matched = 0;
        for (j = 0; j < 3; j++) {
          var m = matchRow(gray, w, rows[j], centerX, module, thr);
          if (m) { accX += m.x; accY += rows[j]; accW++; matched++; }
        }
        if (matched < 2) continue;
        candidates.push({ x: accX / accW, y: accY / accW, module: module });
      }
    }
    // 合并相近候选（按模块尺寸加权平均）
    var merged = [];
    for (i = 0; i < candidates.length; i++) {
      var c1 = candidates[i], found = false;
      for (j = 0; j < merged.length; j++) {
        var c2 = merged[j];
        if (Math.abs(c1.x - c2.x) < c2.module * 1.8 && Math.abs(c1.y - c2.y) < c2.module * 1.8) {
          var n = c2.n || 1;
          c2.x = (c2.x * n + c1.x) / (n + 1);
          c2.y = (c2.y * n + c1.y) / (n + 1);
          c2.module = (c2.module * n + c1.module) / (n + 1);
          c2.n = n + 1; found = true; break;
        }
      }
      if (!found) merged.push({ x: c1.x, y: c1.y, module: c1.module, n: 1 });
    }
    return merged.filter(function (c) { return c.n >= 2; });
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

  // 全分辨率精化寻像中心（旋转鲁棒）：在估计位置附近的多行/多列匹配取加权平均
  function refineFinder(gray, w, h, cx, cy, module) {
    var thr = 120, i, row, col;
    var accX = 0, accY = 0, accW = 0;
    var offsets = [-1.2, -0.6, 0, 0.6, 1.2];
    for (i = 0; i < offsets.length; i++) {
      row = Math.round(cy + offsets[i] * module);
      if (row < 0 || row >= h) continue;
      var m = matchRow(gray, w, row, cx, module, thr);
      if (m) { accX += m.x * m.module; accY += row * m.module; accW += m.module; }
    }
    if (accW < module * 2) return null;
    var rx = accX / accW, ry = accY / accW;
    accX = 0; accY = 0; accW = 0;
    for (i = 0; i < offsets.length; i++) {
      col = Math.round(rx + offsets[i] * module);
      if (col < 0 || col >= w) continue;
      var m2 = matchCol(gray, w, h, col, ry, module, thr);
      if (m2) { accX += col * m2.module; accY += m2.y * m2.module; accW += m2.module; }
    }
    if (accW < module * 2) return null;
    return { x: accX / accW, y: accY / accW };
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
    // 检测目标随帧边长同比例提升（基准 1088 → detTarget，下限 512 上限 2048）
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
    var NSP = Math.max(2, Math.min(8, Math.round(cellPx)));
    if (typeof self !== "undefined" && self.__CIMQR_DEBUG__) { var __o = self.__CIMQR_DEBUG__({ phase: 'nsp', NSP: NSP, cellPx: cellPx }); if (self.__CIMQR_FORCE_NSP__) NSP = self.__CIMQR_FORCE_NSP__; }
    var nsq = NSP * NSP;
    // 采样格内圈：INNER<8 时采样点向格中心收缩，避开格边缘与 1px 空隙的混色/模糊污染
    var INNER_OFF = (8 - INNER) / 2;
    var px = new Float64Array(nsq), py = new Float64Array(nsq);
    for (i = 0; i < nsq; i++) { px[i] = INNER_OFF + ((i % NSP) + 0.5) / NSP * INNER; py[i] = INNER_OFF + ((i / NSP) + 0.5) / NSP * INNER; }
    // popcount 表（8 位）
    var pop8 = CimQR_POP8 || (function () {
      var t = new Uint8Array(256), i, j, c;
      for (i = 0; i < 256; i++) { c = 0; for (j = i; j; j &= j - 1) c++; t[i] = c; }
      CimQR_POP8 = t;
      return t;
    })();
    // 每个模板在 NSP×NSP 采样网格下的期望图案（预计算，与采样点一致），32 位双字
    var tpl = [];
    for (var s = 0; s < 16; s++) {
      var hi = 0, lo = 0;
      for (var sp = 0; sp < nsq; sp++) {
        var spx = Math.min(7, Math.floor((INNER_OFF + ((sp % NSP) + 0.5) / NSP * INNER)));
        var spy = Math.min(7, Math.floor((INNER_OFF + ((sp / NSP) + 0.5) / NSP * INNER)));
        var bit = Number((PATTERNS[s] >> BigInt(63 - (spy * 8 + spx))) & 1n);
        hi = (hi << 1) | ((lo >>> 31) & 1);
        lo = ((lo << 1) | bit) >>> 0;
      }
      tpl.push([hi >>> 0, lo]);
    }
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
    var softLit = null;
    if (soft) {
      softLit = [];
      for (var s2 = 0; s2 < 16; s2++) {
        var mhi = 0, mlo = 0, lc = 0;
        for (var sp2 = 0; sp2 < nsq; sp2++) {
          var spx2 = Math.min(7, Math.floor((INNER_OFF + ((sp2 % NSP) + 0.5) / NSP * INNER)));
          var spy2 = Math.min(7, Math.floor((INNER_OFF + ((sp2 / NSP) + 0.5) / NSP * INNER)));
          var bit2 = Number((PATTERNS[s2] >> BigInt(63 - (spy2 * 8 + spx2))) & 1n);
          mhi = (mhi << 1) | ((mlo >>> 31) & 1);
          mlo = ((mlo << 1) | bit2) >>> 0;
          if (bit2) lc++;
        }
        softLit.push([mhi >>> 0, mlo, lc]);
      }
    }
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
        var maxCh = 0;
        for (var q = 0; q < nsq; q++) {
          var pq = H.map(ox + px[q], oy + py[q]);
          var rq = 0, gq = 0, bq = 0, nv = 0;
          for (var dy2 = -1; dy2 <= 1; dy2 += 2)
            for (var dx2 = -1; dx2 <= 1; dx2 += 2) {
              var xq = Math.floor(pq[0] + dx2 * 0.5), yq = Math.floor(pq[1] + dy2 * 0.5);
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
          var L = softLit[s3];
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
        var p = H.map(ox + px[sp], oy + py[sp]);
        // floor 而非 round：round(x+0.5) 会偏到下一格（越界到格间空隙）
        var xi = Math.floor(p[0]), yi = Math.floor(p[1]);
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
      if (bad || cnt < Math.max(2, nsq * 0.08)) { vals[i] = 255; continue; } // 采样失败 → 用 RS 纠
      // 格子颜色 = 彩色点多数色
      var bestC = 0;
      for (var cl = 1; cl < 4; cl++) if (colVotes[cl] > colVotes[bestC]) bestC = cl;
      if (colVotes[bestC] < Math.max(1, nsq * 0.04)) { vals[i] = 255; continue; }
      // 匹配符号（16 模板，popcount Hamming）
      var bestSym = 0, bestD = nsq + 1;
      for (var s = 0; s < 16; s++) {
        var d = pop32((patHi ^ tpl[s][0]) >>> 0) + pop32((patLo ^ tpl[s][1]) >>> 0);
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
    cands = dropTriple(cands, sel); // 该符号已解出，移除其 3 个寻像候选
    } // for symN
    return packets;
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
    [768, 7.5, false, true],
    [512, 6, false, true],
    [512, 6, true, true],
    [512, 6, true, false],
    [512, 7.5, false, false],
    [512, 4.5, true, true],
    [768, 6, true, true],
    // 并行网格大画布（如 2176×2176）：每符号像素被摊薄，需更高检测分辨率
    [2048, 6, true, true],
    [2048, 7.5, false, true]
  ];
  function decodeFrame(rgba, w, h) {
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
