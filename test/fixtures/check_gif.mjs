/* ============================================================================
 * CimQR — 彩色 cimbar/QR 混合编解码器（RaptorQR 彩色化核心）
 *
 * 设计要点（借鉴 libcimbar/sz3 与标准 QR）：
 *  1) 固定识别位置（沿用现有黑白的 QR 定位）：三个角寻像图形 1:1:3:1:1
 *     + 分隔带 + 顶部/左侧时序图形，全部为黑白高对比图形；
 *  2) 彩色数据区（cimbar 风格）：8×8 子图案（16 符号 = 4bit）+ 4 色
 *     （2bit）= 6bit/格，非纯色设计（每格是图案而非纯色块），抗模糊；
 *  3) 布局与尺寸（QR 版本式阶梯，与 libcimbar 同思路）：格 8px、间距 9px、
 *     偏移 8px 对所有档位固定不变（模板/采样机制与尺寸无关），改变的是
 *     网格每边格数与画布尺寸：112×112 标准（数据格 12032 → 7241 B/帧）
 *     到 40×40（1232 格 → 616 B/帧）。固定渲染尺寸下低档格子自动放大
 *     （40 档格子 2.8×），信息密度真实下降，相机采集负担同比减轻；
 *  3b) 尺寸自描述：TL 角保留区内 5 模块标记码（4bit 尺寸索引 + 1bit 偶校验，
 *     位置对所有档位固定），解码端在 RS 解码前读取；帧头格式字节 = 索引+1
 *     （0x01 = 112×112，向后兼容旧帧）；
 *  4) 纠错：GF(256) 本原多项式 0x187 的 RS(155,125,30)，数据按 155 分块、
 *     2 分区交织（抗局部损坏），块数随档位容量伸缩；
 *  5) 帧内封装：[2B 长度][2B magic 0x51 0x43][1B 格式][4B 保留]
 *     + 传输包（RaptorQ 包裹包，长度 ≤ 档位容量），与现有协议完全兼容。
 *
 * 运行环境：浏览器/Worker/Node 通用（无依赖、无 import）。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CimQR = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- 常量 ----------
  var CELL = 8;        // 格子像素尺寸（所有档位一致 → 模板/采样机制与尺寸无关）
  var PITCH = 9;       // 格子中心间距（所有档位一致）
  var OFFSET = 8;      // 网格起始偏移
  var CP = 7;          // 四角保留区（格；corner 9×9 格 + 时序线 r=6，所有档位一致）
  var RS_N = 155, RS_K = 125, RS_PARITY = 30;
  var COLOR_BITS = 2, SYMBOL_BITS = 4, BITS_PER_CELL = 6;
  var MAGIC = [0x51, 0x43]; // "QC"

  // 尺寸阶梯（QR 版本式，libcimbar 同思路：固定格/间距，改网格与画布尺寸）。
  // idx 0 = 112×112（格式字节 0x01，向后兼容）；idx 7 = 40×40（最易采集）。
  // 数据格 = g² - 4·9² - 2·(g-18)；流字节 = ⌈格·6/8⌉；RS 块 = ⌊流/155⌋；负载 = 块·125-9
  var SIZES = (function () {
    var grids = [112, 104, 96, 80, 64, 56, 48, 40, 32, 28, 24], out = [], i, g;
    for (i = 0; i < grids.length; i++) {
      g = grids[i];
      var cells = g * g - 4 * 81 - 2 * (g - 18);
      var stream = Math.ceil(cells * BITS_PER_CELL / 8);
      var blocks = Math.floor(stream / RS_N);
      out.push({ grid: g, img: g * PITCH + 2 * OFFSET, total: g * PITCH + 2 * OFFSET + 64,
                 cells: cells, stream: stream, blocks: blocks, packet: blocks * RS_K - 9 });
    }
    return out;
  })();
  // 默认档 = 112（旧常量保持默认值，兼容既有调用）
  var GRID = SIZES[0].grid, IMG = SIZES[0].img, DATA_CELLS = SIZES[0].cells, MAX_PACKET = SIZES[0].packet;
  var FORMAT = 0x01; // 帧头格式字节 = 尺寸索引 + 1

  // 尺寸标记码：TL 角保留区 5 个 8×8 模块（4bit 索引 MSB 在前 + 1bit 偶校验），
  // 位置对所有档位固定（corner 排除区恒 9 格 = 像素 8..88，标记行 y∈[72,80]）
  var SIZE_MARK_X = [12, 28, 44, 60, 76], SIZE_MARK_Y = 72;

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

  // ---------- 格位置与交织（按尺寸索引缓存）----------
  // 数据格列表（行主序）：跳过四角块（9×9×4）与时序带（r=6/c=6）
  var posCache = [], permCache = [], invPermCache = [];
  function getCellPos(idx) {
    if (posCache[idx]) return posCache[idx];
    var g = SIZES[idx].grid, list = [], c, r;
    for (r = 0; r < g; r++) {
      for (c = 0; c < g; c++) {
        var corner = (c <= 8 && r <= 8) ||
                     (c >= g - 9 && r <= 8) ||
                     (c <= 8 && r >= g - 9) ||
                     (c >= g - 9 && r >= g - 9);
        var timing = (r === CP - 1 && c >= CP) || (c === CP - 1 && r >= CP);
        if (!corner && !timing) list.push(c + r * g);
      }
    }
    if (list.length !== SIZES[idx].cells) throw new Error("cellPos length mismatch: " + list.length + " vs " + SIZES[idx].cells);
    posCache[idx] = list;
    return list;
  }

  // 交织排列：把流位置 k 映射到数据格列表下标 perm[k]
  function getPerm(idx) {
    if (permCache[idx]) return permCache[idx];
    var N = SIZES[idx].cells, parts = 2, chunks = RS_N;
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
    permCache[idx] = p;
    return p;
  }

  function getInvPerm(idx) {
    if (invPermCache[idx]) return invPermCache[idx];
    var N = SIZES[idx].cells, inv = new Uint32Array(N), i;
    var p = getPerm(idx);
    for (i = 0; i < N; i++) inv[p[i]] = i;
    invPermCache[idx] = inv;
    return inv;
  }

  // 默认档（112×112）兼容引用
  var cellPos = getCellPos(0), perm = getPerm(0), invPerm = getInvPerm(0);

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
    // 交集规则绘制（与解码端 floor 采样一致）：像素 py 归属模块 floor(py/8R)，
    // 无间隙、比例精确；旧实现用整数模块位置在非整数倍率下会错位/断裂
    R = R || 1;
    var span = Math.ceil(7 * 8 * R);
    for (var py = 0; py < span; py++) {
      var my = Math.min(6, Math.floor(py / (8 * R)));
      for (var px = 0; px < span; px++) {
        var mx = Math.min(6, Math.floor(px / (8 * R)));
        var dark = (my === 0 || my === 6 || mx === 0 || mx === 6) || (my >= 2 && my <= 4 && mx >= 2 && mx <= 4);
        if (!dark) continue;
        var o = ((y0 + py) * stride + (x0 + px)) * 4;
        buf[o] = 0; buf[o + 1] = 0; buf[o + 2] = 0; buf[o + 3] = 255;
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

  function renderFrame(packet, scale, sIdx) {
    sIdx = sIdx | 0;
    if (sIdx < 0 || sIdx >= SIZES.length) sIdx = 0;
    var SZ = SIZES[sIdx];
    var R = scale || 1; // 渲染倍率：W2 = 画布边长(含静区) × R
    var W2 = Math.round(SZ.total * R);
    var buf = new Uint8ClampedArray(W2 * W2 * 4);
    var x, y, o;
    // 背景白（静区）
    for (o = 0; o < buf.length; o += 4) { buf[o] = 255; buf[o + 1] = 255; buf[o + 2] = 255; buf[o + 3] = 255; }
    var M = Math.round(MARGIN * R);

    // 三个寻像图形（位置随画布缩放，模块尺寸恒 8px）
    drawFinder(buf, M, M, W2, R);                                      // TL
    drawFinder(buf, M + Math.floor((SZ.img - 64) * R), M, W2, R);      // TR
    drawFinder(buf, M, M + Math.floor((SZ.img - 64) * R), W2, R);      // BL
    // 分隔带（白）
    drawSolid(buf, M + Math.floor(56 * R), M, Math.floor(8 * R), Math.floor(64 * R), 255, W2);
    drawSolid(buf, M, M + Math.floor(56 * R), Math.floor(64 * R), Math.floor(8 * R), 255, W2);
    drawSolid(buf, M + Math.floor((SZ.img - 72) * R), M, Math.floor(8 * R), Math.floor(64 * R), 255, W2);
    drawSolid(buf, M + Math.floor((SZ.img - 64) * R), M + Math.floor(56 * R), Math.floor(64 * R), Math.floor(8 * R), 255, W2);
    drawSolid(buf, M, M + Math.floor((SZ.img - 72) * R), Math.floor(64 * R), Math.floor(8 * R), 255, W2);
    drawSolid(buf, M + Math.floor(56 * R), M + Math.floor((SZ.img - 64) * R), Math.floor(8 * R), Math.floor(64 * R), 255, W2);

    // 时序图形（顶部 y=56..64；左侧 x=56..64）黑白交替，随画布伸缩
    for (var k = 0; 64 + k * 8 < SZ.img - 72; k++) {
      var dk = (k % 2 === 0);
      drawSolid(buf, M + Math.floor((64 + k * 8) * R), M + Math.floor(56 * R), Math.floor(8 * R), Math.floor(8 * R), dk ? 0 : 255, W2);
      drawSolid(buf, M + Math.floor(56 * R), M + Math.floor((64 + k * 8) * R), Math.floor(8 * R), Math.floor(8 * R), dk ? 0 : 255, W2);
    }
    // BR 辅助标记（QR 对齐图案 5×5，位于 BR 角排除区内，不影响数据格）
    // 模块位置用仿射一致规则（floor((952+8x)·R)，与数据格/解码端符号坐标一致）——
    // 旧实现 floor(952R)+floor(x·8R) 累计取整误差会把标记中心偏 1-2px，
    // 解码端 BR 精化据此重解单应 → 整幅映射被扭曲（非整数倍率下尤其明显）
    {
      for (y = 0; y < 5; y++)
        for (x = 0; x < 5; x++) {
          var bd = (y === 0 || y === 4 || x === 0 || x === 4) || (y === 2 && x === 2);
          var bv = bd ? 0 : 255;
          drawSolid(buf, M + Math.floor((SZ.img - 72 + x * 8) * R), M + Math.floor((SZ.img - 72 + y * 8) * R), Math.max(1, Math.floor(8 * R)), Math.max(1, Math.floor(8 * R)), bv, W2);
        }
    }

    // 数据流：帧头 + 包裹包 → RS → 交织 → 6bit/格
    var hdr = new Uint8Array(9);
    hdr[0] = packet.length & 255; hdr[1] = (packet.length >> 8) & 255;
    hdr[2] = MAGIC[0]; hdr[3] = MAGIC[1]; hdr[4] = sIdx + 1; // 格式字节 = 尺寸索引+1
    // [5..8] 保留 0
    var rsData = new Uint8Array(SZ.blocks * RS_K);
    rsData.set(hdr, 0);
    rsData.set(packet, 9);
    // 逐块 RS 编码
    var coded = new Uint8Array(SZ.blocks * RS_N);
    for (var blk = 0; blk < SZ.blocks; blk++) {
      var cw = rsEncode(rsData.subarray(blk * RS_K, blk * RS_K + RS_K));
      coded.set(cw, blk * RS_N);
    }
    // 补齐到格流字节数（剩余 0 填充）
    var streamBytes = new Uint8Array(SZ.stream);
    streamBytes.set(coded, 0);
    // 写入格值
    var bw = new BitWriter();
    for (var i = 0; i < streamBytes.length; i++) bw.write(streamBytes[i], 8);
    var bitArr = bw.finish();
    var cellVals = new Uint8Array(SZ.cells);
    var br = new BitReader(streamBytes);
    for (i = 0; i < SZ.cells; i++) cellVals[i] = br.read(BITS_PER_CELL);

    // 绘制数据格（流位置 i → 数据格下标 perm[i] → 网格坐标）
    // 交集规则：图像像素 k 显示"其符号区间 [floor((k-M)/R), floor((k-M)/R)+1/R) 与格符号范围
    // 交集下界"对应的 tile 像素——与解码端 floor(M+符号×R) 采样精确对齐，任意 R 一致
    var gpos = getCellPos(sIdx), gperm = getPerm(sIdx);
    for (i = 0; i < SZ.cells; i++) {
      var gridIdx = gpos[gperm[i]];
      var cc = gridIdx % SZ.grid, cr = (gridIdx / SZ.grid) | 0;
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

    // 尺寸标记码（TL 角保留区；解码端 RS 前读取：4bit 索引 + 1bit 偶校验）
    var pcIdx = 0, tt = sIdx;
    while (tt) { pcIdx++; tt &= tt - 1; }
    for (var mi = 0; mi < 5; mi++) {
      var mb = mi < 4 ? ((sIdx >> (3 - mi)) & 1) : (pcIdx & 1);
      if (mb) drawSolid(buf, M + Math.floor(SIZE_MARK_X[mi] * R), M + Math.floor(SIZE_MARK_Y * R),
                        Math.max(1, Math.floor(8 * R)), Math.max(1, Math.floor(8 * R)), 0, W2);
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
            var modRatioOK = d1 / t.module > 16 && d1 / t.module < 220; // 下界 16：24×24 最小档 ratio≈21
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
    var R = 4.2 * module; // 覆盖完整 7 模块 finder（3.2 会截断尾段暗环）
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

  // 模板缓存：按 NSP/INNER/渲染倍率桶 分档。相位感知映射（替代旧 floor(pxv)/低倍率
  // 奇偶模板）：非整数倍率下采样像素显示的图案像素 = floor((floor(φ+q·R)-φ)/R)，
  // φ 为格起点图像相位（M=round(32R) 取整后抵消，用实测 finder 中心对齐），
  // q 为格内采样符号位置；越界（图案不可见=背景）按未点亮处理。
  // 整数/半倍率下自动退化为旧 floor/奇偶行为（φ=0 时序列即 floor(pxv)）。
  // 检测缓存：同帧同 SCALE 复用 finder 候选（阶梯各层同降采样尺寸时省重复检测/精化）
  var detToken = 0, detCacheKey = '', detCands = [];
  function phaseOf(x) { return x - Math.floor(x); }
  var phaseCacheMap = {};
  // 图案行位表（NUMBER 运算，热循环免 BigInt）
  var rows8 = (function () {
    var rows = [];
    for (var s = 0; s < 16; s++) {
      var rs = [];
      for (var ry = 0; ry < 8; ry++) rs.push(Number((PATTERNS[s] >> BigInt(56 - ry * 8)) & 255n));
      rows.push(rs);
    }
    return rows;
  })();
  // 采样序列内容：每样本实际显示的图案像素（255=背景）；x/y 轴序列不同
  // （q%NSP vs q/NSP|0），故分轴计算
  function seqContentOf(NSP, INNER, H0, Ra, Rb, M_est, Rg, gsx, useY) {
    // 采样像素 = floor(H0 + p·Ra + q·Rb)：Ra 为本轴局部倍率，Rb 为另一轴耦合梯度
    // （H 的 y 耦合使逐列近似在行方向偏移，故逐格用 H.map 的局部线性模型）。
    // 图案索引 = floor((像素 - M_est)/Rg) - gsx：Rg 必须用全局倍率（渲染端 R），
    // 局部倍率会跨符号累积 1-2 图案像素的漂移。+1e-9 防 FP 边界错位。
    var off = (8 - INNER) / 2, nsq = NSP * NSP, out = new Array(nsq);
    for (var q = 0; q < nsq; q++) {
      var pxv = off + ((q % NSP) + 0.5) / NSP * INNER;
      var pyv = off + ((q / NSP | 0) + 0.5) / NSP * INNER;
      var pos = useY ? pyv : pxv, cross = useY ? pxv : pyv;
      var v = Math.floor((Math.floor(H0 + pos * Ra + cross * Rb) - M_est) / Rg + 1e-9) - gsx;
      out[q] = (v < 0 || v > 7) ? 255 : v;
    }
    return out.join(',');
  }
  var seqCache = {}, pairCache = {};
  // 旧式相位盲模板（R-mode 3 兜底：H 中心误差大时相位模板过拟合，退化到旧行为）
  var legacyTplCache = {};
  function getLegacyTpl(NSP, INNER, lowRes, parity) {
    var key = NSP + '_' + INNER + '_' + (lowRes ? 'L' : 'H') + '_' + parity;
    var p = legacyTplCache[key];
    if (p) return p;
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
    p = { tpl: tpl, softLit: softLit };
    legacyTplCache[key] = p;
    return p;
  }
  // 序列内容 → 全局 id（相机静止时 R 抖动不产生新内容 → 模板复用）
  function seqIdOf(content) {
    var id = seqCache[content];
    if (id === undefined) { id = seqCache[content] = Object.keys(seqCache).length; }
    return id;
  }
  // (x,y) 序列对 → 模板（16 图案 × hi/lo 掩码 + 软判决表），按内容全局缓存
  function pairOf(NSP, INNER, sx, sy) {
    var key = NSP + '_' + INNER + '_' + sx + '_' + sy;
    var p = pairCache[key];
    if (!p) {
      var ax = sx.split(','), ay = sy.split(',');
      var tpl = [], softLit = [];
      for (var s = 0; s < 16; s++) {
        var hi = 0, lo = 0, mhi = 0, mlo = 0, lc = 0, rows = rows8[s];
        for (var q = 0; q < ax.length; q++) {
          var px = ax[q] | 0, py = ay[q] | 0;
          var bit = (px < 255 && py < 255) ? (rows[py] >> (7 - px)) & 1 : 0;
          hi = (hi << 1) | ((lo >>> 31) & 1);
          lo = ((lo << 1) | bit) >>> 0;
          mhi = (mhi << 1) | ((mlo >>> 31) & 1);
          mlo = ((mlo << 1) | bit) >>> 0;
          if (bit) lc++;
        }
        tpl.push([hi >>> 0, lo]);
        softLit.push([mhi >>> 0, mlo, lc]);
      }
      p = { tpl: tpl, softLit: softLit };
      pairCache[key] = p;
    }
    return p;
  }

  // 由寻像图形几何直接估计档位（无需先读标记码，规避 H 的尺寸歧义）：
  // TL↔TR 中心间距在符号坐标 = img-64；模块尺寸恒 8 → 间距/模块 = (img-64)/8
  function sizeFromSpan(spanPx, modPx) {
    var img = Math.round(spanPx / modPx) * 8 + 64;
    var best = 0, bestD = 1e9, i;
    for (i = 0; i < SIZES.length; i++) {
      var d = Math.abs(SIZES[i].img - img);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // 读取 TL 角尺寸标记码（5 模块：4bit 尺寸索引 + 1bit 偶校验）：
  // 3×3 邻域亮度平均判黑白；校验失败或索引越界返回 null（调用方回退几何估计/上次档）
  function readSizeMark(rgba, w, h, H) {
    var stride = w * 4, bits = 0, mi, dark = 0;
    for (mi = 0; mi < 5; mi++) {
      var p = H.map(SIZE_MARK_X[mi] + 4, SIZE_MARK_Y + 4);
      var lum = 0, nv = 0;
      for (var dy = -1; dy <= 1; dy++)
        for (var dx = -1; dx <= 1; dx++) {
          var x = Math.floor(p[0] + dx), y = Math.floor(p[1] + dy);
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          var o = y * stride + x * 4;
          lum += rgba[o] * 299 + rgba[o + 1] * 587 + rgba[o + 2] * 114; nv += 1000;
        }
      if (!nv) return null;
      dark = lum / nv < 128;
      if (mi < 4) bits = (bits << 1) | (dark ? 1 : 0);
    }
    var pc = 0, t = bits;
    while (t) { pc++; t &= t - 1; }
    if ((pc & 1) !== (dark ? 1 : 0)) return null; // 偶校验失败
    if (bits >= SIZES.length) return null;
    return bits;
  }

  // 全局色相偏移（白平衡校正，decodeFrame 每帧估计一次）
  // 4 色各自的白平衡色相偏移（与 hueTable 的 colorIdx 对齐：0绿 1青 2黄 3品红）。
  // 真实相机 AWB 是乘性通道增益，各颜色色相偏移方向和幅度不同（如偏暖时青 -12°、品红 +12°），
  // 单一全局偏移无法同时校正；逐颜色估计后分类时取"到 4 个校正中心的最小距离"。
  var HUE_EXPECTED = [120, 180, 60, 300];
  var hueOffsets = [0, 0, 0, 0];
  function estimateHueOffsets(rgba, w, h) {
    var step = Math.max(4, Math.floor(Math.max(w, h) / 160));
    var stride = w * 4;
    var offs = [0, 0, 0, 0];
    for (var e = 0; e < 4; e++) {
      var sumW = 0, sumH = 0;
      var lo = HUE_EXPECTED[e] - 28, hi = HUE_EXPECTED[e] + 28;
      for (var y = 0; y < h; y += step) {
        for (var x = 0; x < w; x += step) {
          var o = y * stride + x * 4;
          var r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
          var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
          var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
          var ch = mx - mn;
          if (ch < 40 || mx < 50) continue;
          var hue;
          if (mx === r) hue = ((g - b) / ch) * 60;
          else if (mx === g) hue = 120 + ((b - r) / ch) * 60;
          else hue = 240 + ((r - g) / ch) * 60;
          if (hue < 0) hue += 360;
          if (hue >= lo && hue <= hi) { sumW += ch; sumH += ch * hue; }
        }
      }
      if (sumW > 0) {
        var d = sumH / sumW - HUE_EXPECTED[e];
        if (d > 26) d = 26; else if (d < -26) d = -26;
        offs[e] = d;
      }
    }
    return offs;
  }
  // 分类：hue → 距 4 个校正中心（期望+各自偏移）最近的颜色；超过 maxDev 判为无色
  function hueClassify(hue, maxDev) {
    var best = -1, bestD = 1e9;
    for (var e = 0; e < 4; e++) {
      var dc = Math.abs(hue - (HUE_EXPECTED[e] + hueOffsets[e]));
      if (dc > 180) dc = 360 - dc;
      if (dc < bestD) { bestD = dc; best = e; }
    }
    return bestD <= maxDev ? best : -1;
  }

  // 单次解码尝试：detTarget=检测用降采样目标边长，INNER=格内采样跨度（越小越抗模糊/混色），
  // soft=软判决匹配，useMarker=用 BR 对齐标记作第 4 角点（否则平行四边形估计）
  function decodeAttempt(rgba, w, h, detTarget, INNER, soft, useMarker, rMode) {
    // 灰度
    var gray = new Uint8Array(w * h);
    var i, o = 0;
    for (i = 0; i < w * h; i++, o += 4)
      gray[i] = (rgba[o] * 299 + rgba[o + 1] * 587 + rgba[o + 2] * 114) / 1000;

    // 检测降采样目标按帧尺寸自适应：并行网格大画布（如 2176×2176）每符号像素被摊薄，
    // 检测目标随帧边长同比例提升（基准 768 → detTarget，下限 512 上限 2048）
    // 小帧（<768px）直接全分辨率检测：降采样最近邻会在 4-5px finder 上产生混叠假候选
    var effDet = Math.max(Math.max(w, h) < 768 ? Math.max(w, h) : 512, Math.min(2048, Math.round(detTarget * Math.max(w, h) / 1088)));
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
    // 尺寸自描述：先用 finder 几何（间距/模块 → 画布边长）估计档位并构建 H，
    // 再读 TL 角标记码确认/纠正（失败保留几何估计）；档位决定采样/RS/帧头
    var spanPx = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    var sIdx = sizeFromSpan(spanPx, modFull);
    var SZ = SIZES[sIdx];
    var IMG2 = SZ.img;
    var symTL = [28, 28], symTR = [IMG2 - 36, 28], symBL = [28, IMG2 - 36], symBR = [IMG2 - 36, IMG2 - 36];
    var imgTL = [tl.x, tl.y], imgTR = [tr.x, tr.y], imgBL = [bl.x, bl.y];
    // BR 用平行四边形估计
    var imgBR = [tl.x + (tr.x - tl.x) + (bl.x - tl.x), tl.y + (tr.y - tl.y) + (bl.y - tl.y)];
    var H = solveHomography([symTL, symTR, symBL, symBR], [imgTL, imgTR, imgBL, imgBR]);
    if (!H) { cands = dropTriple(cands, sel); continue; }
    var sm = readSizeMark(rgba, w, h, H);
    if (sm !== null) sIdx = sm;
    SZ = SIZES[sIdx];
    IMG2 = SZ.img;
    // BR 对齐标记精化：检测第 4 角的真实位置（5×5 对齐图案，符号坐标中心 img-52），
    // 用 4 个真实角点重解单应 → 透视不再是平行四边形近似。
    // 判据：中心暗 + 半径 1 mod 处 8 点白色环带（数据区不存在 18px 宽白域，强区分）
    if (useMarker) try {
      // 预测用仿射估计（DLT 在 BR 角外推误差可达 10%+，窗口会错过真实标记）
      var p0 = [tl.x + (tr.x - tl.x) * (IMG2 - 80) / (IMG2 - 64), tl.y + (bl.y - tl.y) * (IMG2 - 80) / (IMG2 - 64)];
      var mstride = w * 4; // 注意：不能用的 stride（此处尚未赋值，var 提升为 undefined）
      var markC = null;
      var SR2 = 5.2 * modFull;
      var bx0 = Math.max(2, Math.round(p0[0] - SR2)), bx1 = Math.min(w - 3, Math.round(p0[0] + SR2));
      var by0 = Math.max(2, Math.round(p0[1] - SR2)), by1 = Math.min(h - 3, Math.round(p0[1] + SR2));
      var best2 = null, bestScore2 = -1;
      for (var cy2 = by0; cy2 <= by1; cy2 += 1)
        for (var cx2 = bx0; cx2 <= bx1; cx2 += 1) {
          var o5 = cy2 * mstride + cx2 * 4;
          var l5 = (rgba[o5] * 299 + rgba[o5 + 1] * 587 + rgba[o5 + 2] * 114) / 1000;
          if (l5 >= 110) continue;
          var hits5 = 0;
          for (var a5 = 0; a5 < 8; a5++) {
            // 环半径 1.5×mod：亮环位于 1~2 模块处（0.92×mod 落在暗环内，小倍率下命中失败）
            var sx5 = Math.round(cx2 + 1.5 * modFull * Math.cos(a5 * 0.7853981633974483));
            var sy5 = Math.round(cy2 + 1.5 * modFull * Math.sin(a5 * 0.7853981633974483));
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
        // 暗点质心精化：窗口以预测点为中心（粗搜索的环命中偏向偏移候选，
        // 窗口随粗候选偏移会漏掉标记暗心），半径 2.5 mod 覆盖暗心+外环（对称→质心=中心）
        var RAD5 = Math.max(5, modFull * 2.5);
        var wx0 = Math.max(0, Math.round(p0[0] - RAD5)), wx1 = Math.min(w - 1, Math.round(p0[0] + RAD5));
        var wy0 = Math.max(0, Math.round(p0[1] - RAD5)), wy1 = Math.min(h - 1, Math.round(p0[1] + RAD5));
        var accW2 = 0, accX2 = 0, accY2 = 0;
        for (var my = wy0; my <= wy1; my++)
          for (var mx = wx0; mx <= wx1; mx++) {
            var mo = my * mstride + mx * 4;
            var mlum = (rgba[mo] * 299 + rgba[mo + 1] * 587 + rgba[mo + 2] * 114) / 1000;
            if (mlum < 110) { var wg = 128 - mlum; accX2 += mx * wg; accY2 += my * wg; accW2 += wg; }
          }
        if (accW2 > 4) {
          var cmx = accX2 / accW2 + 0.5, cmy = accY2 / accW2 + 0.5;
          if (Math.hypot(cmx - p0[0], cmy - p0[1]) < modFull * 2.0) markC = [cmx, cmy]; // 收紧：远离预测的标记视为误检，保留平行四边形 H
        }
      }
      if (markC) {
        var H2 = solveHomography([symTL, symTR, symBL, [IMG2 - 52, IMG2 - 52]], [imgTL, imgTR, imgBL, markC]);
        if (H2) H = H2;
      }
      if (typeof self !== "undefined" && self.__CIMQR_DEBUG__) self.__CIMQR_DEBUG__({ phase: 'br', refined: !!markC, mark: markC, pred: p0 });
    } catch (e) {}
    if (typeof self !== "undefined" && self.__CIMQR_DEBUG__) self.__CIMQR_DEBUG__({ phase: 'h', SCALE: SCALE, tl: [tl.x, tl.y], tr: [tr.x, tr.y], bl: [bl.x, bl.y], h: H.h, sample0: H.map(71.5, 8.5) });

    // 读取格值（分辨率自适应：按格子的图像像素尺寸决定采样密度；网格几何按档位）
    var vals = new Uint8Array(SZ.cells);
    var stride = w * 4;
    var gpos = getCellPos(sIdx), gperm = getPerm(sIdx);
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
    // 相位感知模板：按格起点图像相位映射采样点（非整数倍率下与渲染像素精确对齐），
    // M 用实测 H 映射（H.map(0,0)，与采样同一坐标系）；序列按内容全局缓存
    var R_loc = cellPx / 8;
    // M 与渲染端一致：round(32·R)。R 候选：0=局部测量（相机路径默认），
    // 1=finder 中心跨度（精化误差更小），2=帧尺寸（纯净渲染精确）。R 测量误差
    // 会跨符号累积图案索引漂移（远角可达 1 图案像素），故硬帧逐模式兜底
    var Rg = R_loc;
    if (rMode === 1) { var tlf = H.map(28, 28), trf = H.map(IMG2 - 36, 28); Rg = Math.hypot(trf[0] - tlf[0], trf[1] - tlf[1]) / (IMG2 - 64); }
    else if (rMode === 2) {
      Rg = w / SZ.total;
      // 帧尺寸倍率 = 纯渲染场景：用 finder 中心直接构造仿射 H（DLT 在 BR 角外推
      // 误差可达 10%+，把采样像素带偏 1-2 图案像素）
      var sxA = (tr.x - tl.x) / (IMG2 - 64), syA = (bl.y - tl.y) / (IMG2 - 64);
      var hA = [sxA, 0, tl.x - 28 * sxA, 0, syA, tl.y - 28 * syA, 0, 0];
      H = { h: hA, map: function (x, y) { return [hA[0] * x + hA[2], hA[4] * y + hA[5]]; } };
    }
    var M_est = Math.round(32 * Rg);
    var seqIdMap = {}, seqIdList = [], framePairs = {};
    // 帧内相位类：按 (round(H0·64), round(Ra·1024), round(Rb·1024)) 键缓存——
    // 相邻格共享类，1/128px 量化下边界翻转率 ~1%（软判决+RS 可吸收）
    function frameSeqId(H0, Ra, Rb, gsx, useY) {
      var key = ((Math.round(H0 * 64) * 4096 + Math.round(Ra * 1024)) * 8192 + Math.round(Rb * 1024)) * 2 + (useY ? 1 : 0);
      var id = seqIdMap[key];
      if (id === undefined) {
        id = seqIdList.length;
        seqIdMap[key] = id;
        seqIdList.push([H0, Ra, Rb, gsx, useY]);
      }
      return id;
    }
    function framePair(ix, iy) {
      var k = ix * 2048 + iy;
      var p = framePairs[k];
      if (!p) {
        var sx = seqIdList[ix], sy = seqIdList[iy];
        p = pairOf(NSP, INNER, seqContentOf(NSP, INNER, sx[0], sx[1], sx[2], M_est, Rg, sx[3], sx[4]), seqContentOf(NSP, INNER, sy[0], sy[1], sy[2], M_est, Rg, sy[3], sy[4]));
        framePairs[k] = p;
      }
      return p;
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
    var sR = soft ? new Float64Array(nsq) : null, sG = soft ? new Float64Array(nsq) : null, sB = soft ? new Float64Array(nsq) : null, sC = soft ? new Float64Array(nsq) : null;
    for (i = 0; i < SZ.cells; i++) {
      var gridIdx = gpos[i];
      var cc = gridIdx % SZ.grid, cr = (gridIdx / SZ.grid) | 0;
      var ox = OFFSET + cc * PITCH, oy = OFFSET + cr * PITCH;
      var p0m = H.map(ox, oy), p8x = H.map(ox + 8, oy), p8y = H.map(ox, oy + 8);
      var Rcx = Math.hypot(p8x[0] - p0m[0], p8x[1] - p0m[1]) / 8;
      var Rcy = Math.hypot(p8y[0] - p0m[0], p8y[1] - p0m[1]) / 8;
      var PT = rMode === 3
        ? getLegacyTpl(NSP, INNER, cellPx < 5.5, (cr & 1) * 2 + (cc & 1))
        : framePair(
            frameSeqId(p0m[0], Rcx, (p8y[0] - p0m[0]) / 8, ox, 0),
            frameSeqId(p0m[1], Rcy, (p8x[1] - p0m[1]) / 8, oy, 1));
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
          var L = PT.softLit[s3];
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
          var ci2 = hueClassify(hue2, 12);
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
          var cIdx = hueClassify(hue, 12);
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
      var tplT = PT.tpl;
      for (var s = 0; s < 16; s++) {
        var d = pop32((patHi ^ tplT[s][0]) >>> 0) + pop32((patLo ^ tplT[s][1]) >>> 0);
        if (d < bestD) { bestD = d; bestSym = s; }
      }
      vals[i] = (bestC << SYMBOL_BITS) | bestSym;
    }
    // 反交织 → 位流 → 字节流
    var stream = new Uint8Array(SZ.stream);
    var bw = new BitWriter();
    var failCount = 0;
    for (i = 0; i < SZ.cells; i++) {
      var val = vals[gperm[i]];
      if (val === 255) failCount++;
      bw.write(val === 255 ? 0 : val, BITS_PER_CELL);
    }
    if (typeof self !== "undefined" && self.__CIMQR_DEBUG__) self.__CIMQR_DEBUG__({ phase: 'cells', fail: failCount, total: SZ.cells });
    var bytes = new Uint8Array(bw.finish());
    if (typeof self !== "undefined" && self.__CIMQR_DEBUG__) self.__CIMQR_DEBUG__({ phase: 'vals', first: Array.from(vals.slice(0, 6)), permFirst: Array.from(gperm.slice(0, 6)) });
    // RS 解码（块数随档位）
    var rsOut = new Uint8Array(SZ.blocks * RS_K);
    var anyFail = false, failBlk = -1;
    for (var blk = 0; blk < SZ.blocks; blk++) {
      var dec = rsDecode(bytes.subarray(blk * RS_N, blk * RS_N + RS_N));
      if (!dec) { anyFail = true; failBlk = blk; break; }
      rsOut.set(dec, blk * RS_K);
    }
    if (typeof self !== "undefined" && self.__CIMQR_DEBUG__) self.__CIMQR_DEBUG__({ phase: 'rs', anyFail: anyFail, failBlk: failBlk, bytes: Array.from(bytes.subarray(0, 8)) });
    if (anyFail) { cands = dropTriple(cands, sel); continue; }
    // 解析帧头（格式字节必须与标记码档位一致 → 双保险）
    var plen = rsOut[0] | (rsOut[1] << 8);
    if (plen > SZ.packet || plen < 12) { cands = dropTriple(cands, sel); continue; }
    if (rsOut[2] !== MAGIC[0] || rsOut[3] !== MAGIC[1] || rsOut[4] !== sIdx + 1) { cands = dropTriple(cands, sel); continue; }
    var packet = new Uint8Array(plen);
    packet.set(rsOut.subarray(9, 9 + plen), 0);
    packets.push(packet);
    if (!firstH) firstH = H; // 记录首个符号的单应（供帧间复用）
    cands = dropTriple(cands, sel); // 该符号已解出，移除其 3 个寻像候选
    } // for symN
    _lastH = packets.length === 1 ? firstH : null; // 仅单符号帧缓存单应（并行帧每次全检测）
    _lastSizeIdx = packets.length === 1 ? sIdx : _lastSizeIdx; // 同时缓存档位（tracking 复用）
    return packets;
  }

  // —— 帧间复用：跳过检测，直接用缓存单应采样解码（相机静止/微抖时相邻帧画面几乎不变）——
  // 复制精简版采样+RS+帧头流程（单符号），命中 ~15-25ms/帧
  var _lastH = null; // {x..} 由 decodeAttempt 成功时写入；decodeFrame 优先尝试
  var _lastSizeIdx = 0; // 档位随单应缓存（tracking 复用；标记码失败时兜底）
  function decodeFromH(rgba, w, h, H, INNER, soft, sIdx) {
    // 画面可能已切换到其它档位：重读标记码（失败沿用传入档位）
    var sm = readSizeMark(rgba, w, h, H);
    if (sm !== null) sIdx = sm;
    if (sIdx < 0 || sIdx >= SIZES.length) sIdx = 0;
    var SZ = SIZES[sIdx];
    var gpos = getCellPos(sIdx), gperm = getPerm(sIdx);
    var i;
    var vals = new Uint8Array(SZ.cells);
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
    var R_loc = cellPx / 8;
    // M 与渲染端一致：round(32·R)（H.map(0,0) 含 finder 精化偏移误差 ~0.5px，
    // 会整体平移图案索引导致边界样本错位）
    var M_est = Math.round(32 * R_loc);
    var seqIdMap = {}, seqIdList = [], framePairs = {};
    // 帧内相位类：按 (round(H0·64), round(Ra·1024), round(Rb·1024)) 键缓存——
    // 相邻格共享类，1/128px 量化下边界翻转率 ~1%（软判决+RS 可吸收）
    function frameSeqId(H0, Ra, Rb, gsx, useY) {
      var key = ((Math.round(H0 * 64) * 4096 + Math.round(Ra * 1024)) * 8192 + Math.round(Rb * 1024)) * 2 + (useY ? 1 : 0);
      var id = seqIdMap[key];
      if (id === undefined) {
        id = seqIdList.length;
        seqIdMap[key] = id;
        seqIdList.push([H0, Ra, Rb, gsx, useY]);
      }
      return id;
    }
    function framePair(ix, iy) {
      var k = ix * 2048 + iy;
      var p = framePairs[k];
      if (!p) {
        var sx = seqIdList[ix], sy = seqIdList[iy];
        p = pairOf(NSP, INNER, seqContentOf(NSP, INNER, sx[0], sx[1], sx[2], M_est, R_loc, sx[3], sx[4]), seqContentOf(NSP, INNER, sy[0], sy[1], sy[2], M_est, R_loc, sy[3], sy[4]));
        framePairs[k] = p;
      }
      return p;
    }
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
    var sR = soft ? new Float64Array(nsq) : null, sG = soft ? new Float64Array(nsq) : null, sB = soft ? new Float64Array(nsq) : null, sC = soft ? new Float64Array(nsq) : null;
    for (i = 0; i < SZ.cells; i++) {
      var gridIdx = gpos[i];
      var cc = gridIdx % SZ.grid, cr = (gridIdx / SZ.grid) | 0;
      var ox = OFFSET + cc * PITCH, oy = OFFSET + cr * PITCH;
      var p0m = H.map(ox, oy), p8x = H.map(ox + 8, oy), p8y = H.map(ox, oy + 8);
      var Rcx = Math.hypot(p8x[0] - p0m[0], p8x[1] - p0m[1]) / 8;
      var Rcy = Math.hypot(p8y[0] - p0m[0], p8y[1] - p0m[1]) / 8;
      var PT = rMode === 3
        ? getLegacyTpl(NSP, INNER, cellPx < 5.5, (cr & 1) * 2 + (cc & 1))
        : framePair(
            frameSeqId(p0m[0], Rcx, (p8y[0] - p0m[0]) / 8, ox, 0),
            frameSeqId(p0m[1], Rcy, (p8x[1] - p0m[1]) / 8, oy, 1));
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
          var L = PT.softLit[s3];
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
          var ci2 = hueClassify(hue2, 12);
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
          var cIdx = hueClassify(hue, 12);
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
      var tplT = PT.tpl;
      for (var s = 0; s < 16; s++) {
        var d = pop32((patHi ^ tplT[s][0]) >>> 0) + pop32((patLo ^ tplT[s][1]) >>> 0);
        if (d < bestD) { bestD = d; bestSym = s; }
      }
      vals[i] = (bestC << SYMBOL_BITS) | bestSym;
    }
    // 反交织 → 位流 → 字节流
    var bw = new BitWriter();
    var failCount = 0;
    for (i = 0; i < SZ.cells; i++) {
      var val = vals[gperm[i]];
      if (val === 255) failCount++;
      bw.write(val === 255 ? 0 : val, BITS_PER_CELL);
    }
    var bytes = new Uint8Array(bw.finish());
    var rsOut = new Uint8Array(SZ.blocks * RS_K);
    for (var blk = 0; blk < SZ.blocks; blk++) {
      var dec = rsDecode(bytes.subarray(blk * RS_N, blk * RS_N + RS_N));
      if (!dec) return [];
      rsOut.set(dec, blk * RS_K);
    }
    var plen = rsOut[0] | (rsOut[1] << 8);
    if (plen > SZ.packet || plen < 12) return [];
    if (rsOut[2] !== MAGIC[0] || rsOut[3] !== MAGIC[1] || rsOut[4] !== sIdx + 1) return [];
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
    [512, 7.5, false, true, 0],
    [512, 6, true, true, 0],
    [768, 7.5, false, true, 0],
    [512, 6, false, true, 0],
    [512, 6, true, false, 0],
    [512, 7.5, false, false, 0],
    [512, 4.5, true, true, 0],
    [768, 6, true, true, 0],
    // 并行网格大画布（如 2176×2176）：每符号像素被摊薄，需更高检测分辨率
    [2048, 6, true, true, 0],
    [2048, 7.5, false, true, 0],
    // R 备选：finder 精化误差导致 R_loc 偏移时，用 finder 跨度 / 帧尺寸倍率兜底；
    // 无标记变体：标记误检时平行四边形 H（仅 3 角，无 5-10px 标记误差）
    [512, 6, true, true, 1],
    [512, 6, true, true, 2],
    [2048, 6, true, true, 1],
    [2048, 6, true, true, 2],
    [512, 6, true, false, 2],
    [2048, 6, true, false, 2],
    // 旧式相位盲模板兜底（H 中心误差大时相位感知模板过拟合；INNER=7.5+hard 同旧阶梯首层）
    [512, 7.5, false, true, 3],
    [2048, 7.5, false, true, 3],
    [2048, 7.5, false, false, 3]
  ];
  function decodeFrame(rgba, w, h) {
    detToken++;
    // 白平衡色相校正（真实相机 AWB 偏暖/偏冷会平移色相；黑白 QR 帧不会走到这里）
    hueOffsets = estimateHueOffsets(rgba, w, h);
    // 帧间复用：相邻帧画面几乎不变（相机静止/微抖），直接沿用上次成功单应采样
    if (_lastH) {
      var fast;
      try { fast = decodeFromH(rgba, w, h, _lastH, 6, true, _lastSizeIdx); } catch (e) { fast = []; }
      if (fast && fast.length) return fast;
      // 复用失败（画面变化/切包）：继续完整检测，_lastH 会被新成功帧刷新
    }
    for (var a = 0; a < ATTEMPTS.length; a++) {
      var out;
      try { out = decodeAttempt(rgba, w, h, ATTEMPTS[a][0], ATTEMPTS[a][1], ATTEMPTS[a][2], ATTEMPTS[a][3], ATTEMPTS[a][4]); } catch (e) { out = null; }
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
    SIZES: SIZES, // 尺寸阶梯：{grid,img,total,cells,stream,blocks,packet}（idx 0=112）
    maybeColor: maybeColor,
    render: renderFrame,
    decode: decodeFrame, _decodeAttempt: decodeAttempt,
    readSizeMark: readSizeMark,
    _hueOffset: function(){ return hueOffset; },
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
var Y=[["All","*","*","     ",0,"All"],["AllReadable","*","r","     ",0,"All Readable"],["AllCreatable","*","w","     ",0,"All Creatable"],["AllLinear","*","l","     ",0,"All Linear"],["AllMatrix","*","m","     ",0,"All Matrix"],["AllGS1","*","G","     ",0,"All GS1"],["AllRetail","*","R","     ",0,"All Retail"],["AllIndustrial","*","I","     ",0,"All Industrial"],["Codabar","F"," ","lrw  ",18,"Codabar"],["Code39","A"," ","lrw I",8,"Code 39"],["Code39Std","A","s","lrw I",8,"Code 39 Standard"],["Code39Ext","A","e","lr  I",9,"Code 39 Extended"],["Code32","A","2","lr  I",129,"Code 32"],["PZN","A","p","lr  I",52,"Pharmazentralnummer"],["Code93","G"," ","lrw I",25,"Code 93"],["Code128","C"," ","lrwGI",20,"Code 128"],["ITF","I"," ","lrw I",3,"ITF"],["ITF14","I","4","lr  I",89,"ITF-14"],["DataBar","e"," ","lr GR",29,"DataBar"],["DataBarOmni","e","o","lr GR",29,"DataBar Omni"],["DataBarStk","e","s","lr GR",79,"DataBar Stacked"],["DataBarStkOmni","e","O","lr GR",80,"DataBar Stacked Omni"],["DataBarLtd","e","l","lr GR",30,"DataBar Limited"],["DataBarExp","e","e","lr GR",31,"DataBar Expanded"],["DataBarExpStk","e","E","lr GR",81,"DataBar Expanded Stacked"],["EANUPC","E"," ","lr  R",15,"EAN/UPC"],["EAN13","E","1","lrw R",15,"EAN-13"],["EAN8","E","8","lrw R",10,"EAN-8"],["EAN5","E","5","l   R",12,"EAN-5"],["EAN2","E","2","l   R",11,"EAN-2"],["ISBN","E","i","lr  R",69,"ISBN"],["UPCA","E","a","lrw R",34,"UPC-A"],["UPCE","E","e","lrw R",37,"UPC-E"],["Telepen","B"," ","lr  I",32,"Telepen"],["TelepenAlpha","B","0","lr  I",32,"Telepen Alpha"],["TelepenNumeric","B","1","lr  I",87,"Telepen Numeric"],["OtherBarcode","X"," "," r   ",0,"Other barcode"],["DXFilmEdge","X","x","lr   ",147,"DX Film Edge"],["PDF417","L"," ","mrw  ",55,"PDF417"],["CompactPDF417","L","c","mr   ",56,"Compact PDF417"],["MicroPDF417","L","m","mr   ",84,"MicroPDF417"],["Aztec","z"," ","mr G ",92,"Aztec"],["AztecCode","z","c","mrwG ",92,"Aztec Code"],["AztecRune","z","r","mr   ",128,"Aztec Rune"],["QRCode","Q"," ","mrwG ",58,"QR Code"],["QRCodeModel1","Q","1","mr   ",0,"QR Code Model 1"],["QRCodeModel2","Q","2","mr   ",58,"QR Code Model 2"],["MicroQRCode","Q","m","mr   ",97,"Micro QR Code"],["RMQRCode","Q","r","mr G ",145,"rMQR Code"],["DataMatrix","d"," ","mrwG ",71,"Data Matrix"],["MaxiCode","U"," ","mr   ",57,"MaxiCode"]],Ln={DataBarExpanded:"DataBarExp",DataBarLimited:"DataBarLtd","Linear-Codes":"AllLinear","Matrix-Codes":"AllMatrix",Any:"All",rMQRCode:"RMQRCode"};Y.map(e=>e[5]);Y.filter(e=>e[1]==="*").map(e=>e[0]);Y.filter(e=>e[1]!=="*").map(e=>e[0]);Y.filter(e=>e[2]===" ").map(e=>e[0]);Y.filter(e=>e[3][0]==="l").map(e=>e[0]);Y.filter(e=>e[3][0]==="m").map(e=>e[0]);Y.filter(e=>e[3][1]==="r").map(e=>e[0]);Y.filter(e=>e[3][2]==="w"||e[4]!==0).map(e=>e[0]);Y.filter(e=>e[3][3]==="G").map(e=>e[0]);Y.filter(e=>e[3][4]==="R").map(e=>e[0]);Y.filter(e=>e[3][4]==="I").map(e=>e[0]);function jn(e){var i;return(i=Ln[e])==null?e:i}var Gn={formats:[]};function Mr(e){var i;return{...e,image:(i=e.image&&new Blob([e.image],{type:"image/png"}))==null?null:i}}var j={format:"QRCode",readerInit:!1,forceSquareDataMatrix:!1,ecLevel:"",scale:1,sizeHint:0,rotate:0,invert:!1,withHRT:!1,withQuietZones:!0,addHRT:!1,addQuietZones:!0,options:""};function Hn(e=j){var i,c;let{format:l=j.format,sizeHint:o=j.sizeHint,readerInit:h=j.readerInit,forceSquareDataMatrix:w=j.forceSquareDataMatrix,ecLevel:m=j.ecLevel,withHRT:y,withQuietZones:b,addHRT:_,addQuietZones:A,options:$=j.options,scale:q,rotate:z=j.rotate,invert:B=j.invert}=e,P=$.split(",").map(W=>W.trim()).filter(Boolean),D=W=>{let C=W.split("=")[0];P.some(S=>S.split("=")[0]===C)||P.push(W)};h&&D("readerInit"),w&&D("forceSquare"),m&&D(`ecLevel=${m}`);let H=q??(o>0?-Math.trunc(Math.abs(o)):j.scale);return{format:jn(l),options:P.join(","),scale:H,rotate:z,invert:B,addHRT:(i=_??y)==null?j.addHRT:i,addQuietZones:(c=A??b)==null?j.addQuietZones:c}}var Zn={locateFile:(e,i)=>{let c=e.match(/_(.+?)\.wasm$/);return c?`https://fastly.jsdelivr.net/npm/zxing-wasm@3.1.0/dist/${c[1]}/${e}`:i+e}},Zt=new WeakMap;function Xn(e,i){return Object.is(e,i)||Object.keys(e).length===Object.keys(i).length&&Object.keys(e).every(c=>Object.hasOwn(i,c)&&e[c]===i[c])}function Pr(e,{overrides:i,equalityFn:c=Xn,fireImmediately:l=!1}={}){var o,h;let[w,m]=(o=Zt.get(e))==null?[Zn]:o,y=i??w,b;if(l){if(m&&(b=c(w,y)))return m;let _=e({...y});return Zt.set(e,[y,_]),_}((h=b)==null?c(w,y):h)||Zt.set(e,[y])}async function Yn(e,i,c=j){let l=Hn(c),o=await Pr(e,{fireImmediately:!0});if(typeof i=="string")return Mr(o.writeBarcodeFromText(i,l));let{byteLength:h}=i,w=o._malloc(h);if(!w)throw Error(`Failed to allocate ${h} bytes in WASM memory`);try{return o.HEAPU8.set(i,w),Mr(o.writeBarcodeFromBytes(w,h,l))}finally{o._free(w)}}[...Gn.formats];({...j});async function Wr(e={}){var i,c,l,o=e,h=!!globalThis.window,w=typeof Bun<"u",m=!!globalThis.WorkerGlobalScope;!((c=globalThis.process)==null||(c=c.versions)==null)&&c.node&&((l=globalThis.process)==null||l.type);var y="./this.program",b,_="";function A(t){return o.locateFile?o.locateFile(t,_):_+t}var $,q;if(h||m||w){try{_=new URL(".",b).href}catch{}m&&(q=t=>{var r=new XMLHttpRequest;return r.open("GET",t,!1),r.responseType="arraybuffer",r.send(null),new Uint8Array(r.response)}),$=async t=>{var r=await fetch(t,{credentials:"same-origin"});if(r.ok)return r.arrayBuffer();throw Error(r.status+" : "+r.url)}}var z=console.log.bind(console),B=console.error.bind(console),P,D=!1,H,W,C=!1;function S(){var t=Ft.buffer;ct=new Int8Array(t),xt=new Int16Array(t),o.HEAPU8=tt=new Uint8Array(t),vt=new Uint16Array(t),yt=new Int32Array(t),E=new Uint32Array(t),nr=new Float32Array(t),ar=new Float64Array(t)}function V(){if(o.preRun)for(typeof o.preRun=="function"&&(o.preRun=[o.preRun]);o.preRun.length;)Lr(o.preRun.shift());ir(sr)}function J(){C=!0,$t.oa()}function Z(){if(o.postRun)for(typeof o.postRun=="function"&&(o.postRun=[o.postRun]);o.postRun.length;)Nr(o.postRun.shift());ir(or)}function U(t){var r,n;(r=o.onAbort)==null||r.call(o,t),t="Aborted("+t+")",B(t),D=!0,t+=". Build with -sASSERTIONS for more info.";var a=new WebAssembly.RuntimeError(t);throw(n=W)==null||n(a),a}var K;function mt(){return A("zxing_writer.wasm")}function N(t){if(t==K&&P)return new Uint8Array(P);if(q)return q(t);throw"both async and sync fetching of the wasm failed"}async function zt(t){if(!P)try{var r=await $(t);return new Uint8Array(r)}catch{}return N(t)}async function zr(t,r){try{var n=await zt(t);return await WebAssembly.instantiate(n,r)}catch(a){B(`failed to asynchronously prepare wasm: ${a}`),U(a)}}async function Ur(t,r,n){if(!t&&WebAssembly.instantiateStreaming)try{var a=fetch(r,{credentials:"same-origin"});return await WebAssembly.instantiateStreaming(a,n)}catch(s){B(`wasm streaming compile failed: ${s}`),B("falling back to ArrayBuffer instantiation")}return zr(r,n)}function kr(){return{a:vn}}async function Vr(){function t(a,s){return $t=a.exports,yn($t),S(),$t}function r(a){return t(a.instance)}var n=kr();return o.instantiateWasm?new Promise((a,s)=>{o.instantiateWasm(n,(u,f)=>{a(t(u))})}):(K!=null||(K=mt()),r(await Ur(P,K,n)))}var xt,yt,ct,nr,ar,vt,E,tt,ir=t=>{for(;t.length>0;)t.shift()(o)},or=[],Nr=t=>or.push(t),sr=[],Lr=t=>sr.push(t),I=t=>Ar(t),M=()=>Rr(),Ct=[],Tt=0,jr=t=>{var r=new Ut(t);return r.get_caught()||(r.set_caught(!0),Tt--),r.set_rethrown(!1),Ct.push(r),Cr(t)},rt=0,Gr=()=>{x(0,0);var t=Ct.pop();Er(t.excPtr),rt=0};class Ut{constructor(r){this.excPtr=r,this.ptr=r-24}set_type(r){E[this.ptr+4>>2]=r}get_type(){return E[this.ptr+4>>2]}set_destructor(r){E[this.ptr+8>>2]=r}get_destructor(){return E[this.ptr+8>>2]}set_caught(r){r=+!!r,ct[this.ptr+12]=r}get_caught(){return ct[this.ptr+12]!=0}set_rethrown(r){r=+!!r,ct[this.ptr+13]=r}get_rethrown(){return ct[this.ptr+13]!=0}init(r,n){this.set_adjusted_ptr(0),this.set_type(r),this.set_destructor(n)}set_adjusted_ptr(r){E[this.ptr+16>>2]=r}get_adjusted_ptr(){return E[this.ptr+16>>2]}}var It=t=>br(t),kt=t=>{var r=rt;if(!r)return It(0),0;var n=new Ut(r);n.set_adjusted_ptr(r);var a=n.get_type();if(!a)return It(0),r;for(var s of t){if(s===0||s===a)break;var u=n.ptr+16;if(xr(s,a,u))return It(s),r}return It(a),r},Hr=()=>kt([]),Zr=t=>kt([t]),Xr=(t,r)=>kt([t,r]),Yr=()=>{var t=Ct.pop();t||U("no exception to throw");var r=t.excPtr;throw t.get_rethrown()||(Ct.push(t),t.set_rethrown(!0),t.set_caught(!1),Tt++),Ht(r),rt=r,rt},Kr=(t,r,n)=>{throw new Ut(t).init(r,n),Ht(t),rt=t,Tt++,rt},Jr=()=>Tt,te=t=>{throw rt||(rt=t),rt},ur=globalThis.TextDecoder&&new TextDecoder,lr=(t,r,n,a)=>{var s=r+n;if(a)return s;for(;t[r]&&!(r>=s);)++r;return r},cr=function(t){let r=arguments.length>1&&arguments[1]!==void 0?arguments[1]:0,n=arguments.length>2?arguments[2]:void 0,a=arguments.length>3?arguments[3]:void 0;var s=lr(t,r,n,a);if(s-r>16&&t.buffer&&ur)return ur.decode(t.subarray(r,s));for(var u="";r<s;){var f=t[r++];if(!(f&128)){u+=String.fromCharCode(f);continue}var d=t[r++]&63;if((f&224)==192){u+=String.fromCharCode((f&31)<<6|d);continue}var g=t[r++]&63;if(f=(f&240)==224?(f&15)<<12|d<<6|g:(f&7)<<18|d<<12|g<<6|t[r++]&63,f<65536)u+=String.fromCharCode(f);else{var p=f-65536;u+=String.fromCharCode(55296|p>>10,56320|p&1023)}}return u},re=(t,r,n)=>t?cr(tt,t,r,n):"";function ee(t,r,n){return 0}function ne(t,r,n){return 0}var ae=(t,r,n)=>{};function ie(t,r,n,a){}var oe=(t,r)=>{},se=()=>U(""),Mt={},Vt=t=>{for(;t.length;){var r=t.pop();t.pop()(r)}};function Bt(t){return this.fromWireType(E[t>>2])}var gt={},ft={},Dt={},ue=class extends Error{constructor(t){super(t),this.name="InternalError"}},fr=t=>{throw new ue(t)},dr=(t,r,n)=>{t.forEach(d=>Dt[d]=r);function a(d){var g=n(d);g.length!==t.length&&fr("Mismatched type converter count");for(var p=0;p<t.length;++p)et(t[p],g[p])}var s=Array(r.length),u=[],f=0;{let d=r;for(let g=0;g<d.length;++g){let p=d[g];ft.hasOwnProperty(p)?s[g]=ft[p]:(u.push(p),gt.hasOwnProperty(p)||(gt[p]=[]),gt[p].push(()=>{s[g]=ft[p],++f,f===u.length&&a(s)}))}}u.length===0&&a(s)},le=t=>{var r=Mt[t];delete Mt[t];var n=r.rawConstructor,a=r.rawDestructor,s=r.fields,u=s.map(f=>f.getterReturnType).concat(s.map(f=>f.setterArgumentType));dr([t],u,f=>{var d={};{let g=s;for(let p=0;p<g.length;++p){let v=g[p],F=f[p],O=v.getter,k=v.getterContext,Q=f[p+s.length],L=v.setter,At=v.setterContext;d[v.fieldName]={read:at=>F.fromWireType(O(k,at)),write:(at,ut)=>{var St=[];L(At,at,Q.toWireType(St,ut)),Vt(St)},optional:F.optional}}}return[{name:r.name,fromWireType:g=>{var p={};for(var v in d)p[v]=d[v].read(g);return a(g),p},toWireType:(g,p)=>{for(var v in d)if(!(v in p)&&!d[v].optional)throw TypeError(`Missing field: "${v}"`);var F=n();for(v in d)d[v].write(F,p[v]);return g!==null&&g.push(a,F),F},readValueFromPointer:Bt,destructorFunction:a}]})},ce=(t,r,n,a,s)=>{},G=t=>{for(var r="";;){var n=tt[t++];if(!n)return r;r+=String.fromCharCode(n)}},fe=class extends Error{constructor(t){super(t),this.name="BindingError"}},X=t=>{throw new fe(t)};function de(t,r){let n=arguments.length>2&&arguments[2]!==void 0?arguments[2]:{};var a=r.name;if(t||X(`type "${a}" must have a positive integer typeid pointer`),ft.hasOwnProperty(t)){if(n.ignoreDuplicateRegistrations)return;X(`Cannot register type '${a}' twice`)}if(ft[t]=r,delete Dt[t],gt.hasOwnProperty(t)){var s=gt[t];delete gt[t],s.forEach(u=>u())}}function et(t,r){return de(t,r,arguments.length>2&&arguments[2]!==void 0?arguments[2]:{})}var he=(t,r,n,a)=>{r=G(r),et(t,{name:r,fromWireType:function(s){return!!s},toWireType:function(s,u){return u?n:a},readValueFromPointer:function(s){return this.fromWireType(tt[s])},destructorFunction:null})},hr=[],dt=[0,1,,1,null,1,!0,1,!1,1],Nt=t=>{t>9&&--dt[t+1]===0&&(dt[t]=void 0,hr.push(t))},nt={toValue:t=>(t||X(`Cannot use deleted val. handle = ${t}`),dt[t]),toHandle:t=>{switch(t){case void 0:return 2;case null:return 4;case!0:return 6;case!1:return 8;default:{let r=hr.pop()||dt.length;return dt[r]=t,dt[r+1]=1,r}}}},we={name:"emscripten::val",fromWireType:t=>{var r=nt.toValue(t);return Nt(t),r},toWireType:(t,r)=>nt.toHandle(r),readValueFromPointer:Bt,destructorFunction:null},ge=t=>et(t,we),pe=(t,r)=>{switch(r){case 4:return function(n){return this.fromWireType(nr[n>>2])};case 8:return function(n){return this.fromWireType(ar[n>>3])};default:throw TypeError(`invalid float width (${r}): ${t}`)}},me=(t,r,n)=>{r=G(r),et(t,{name:r,fromWireType:a=>a,toWireType:(a,s)=>s,readValueFromPointer:pe(r,n),destructorFunction:null})},wr=(t,r)=>Object.defineProperty(r,"name",{value:t});function ye(t){for(var r=1;r<t.length;++r)if(t[r]!==null&&t[r].destructorFunction===void 0)return!0;return!1}function ve(t,r,n,a,s,u){var f=r.length;f<2&&X("argTypes array size mismatch! Must at least get return value and 'this' types!"),r[1];var d=ye(r),g=!r[0].isVoid,p=f-2,v=Array(p),F=[],O=[];return wr(t,function(){O.length=0;var k;F.length=1,F[0]=s;for(var Q=0;Q<p;++Q)v[Q]=r[Q+2].toWireType(O,Q<0||arguments.length<=Q?void 0:arguments[Q]),F.push(v[Q]);var L=a(...F);function At(at){if(d)Vt(O);else for(var ut=2;ut<r.length;ut++){var St=ut===1?k:v[ut-2];r[ut].destructorFunction!==null&&r[ut].destructorFunction(St)}if(g)return r[0].fromWireType(at)}return At(L)})}var _e=(t,r,n)=>{if(t[r].overloadTable===void 0){var a=t[r];t[r]=function(){var s=[...arguments];return t[r].overloadTable.hasOwnProperty(s.length)||X(`Function '${n}' called with an invalid number of arguments (${s.length}) - expects one of (${t[r].overloadTable})!`),t[r].overloadTable[s.length].apply(this,s)},t[r].overloadTable=[],t[r].overloadTable[a.argCount]=a}},be=(t,r,n)=>{o.hasOwnProperty(t)?((n===void 0||o[t].overloadTable!==void 0&&o[t].overloadTable[n]!==void 0)&&X(`Cannot register public name '${t}' twice`),_e(o,t,t),o[t].overloadTable.hasOwnProperty(n)&&X(`Cannot register multiple overloads of a function with the same number of arguments (${n})!`),o[t].overloadTable[n]=r):(o[t]=r,o[t].argCount=n)},Ae=(t,r)=>{for(var n=[],a=0;a<t;a++)n.push(E[r+a*4>>2]);return n},Re=(t,r,n)=>{o.hasOwnProperty(t)||fr("Replacing nonexistent public symbol"),o[t].overloadTable!==void 0&&n!==void 0?o[t].overloadTable[n]=r:(o[t]=r,o[t].argCount=n)},ht={},Ee=(t,r,n)=>{t=t.replace(/p/g,"i");var a=ht[t];return a(r,...n)},gr=[],T=t=>{var r=gr[t];return r||(gr[t]=r=Ir.get(t)),r},xe=function(t,r){let n=arguments.length>2&&arguments[2]!==void 0?arguments[2]:[];if(t.includes("j"))return Ee(t,r,n);var a=T(r)(...n);function s(u){return u}return a},Ce=function(t,r){let n=arguments.length>2&&arguments[2]!==void 0?arguments[2]:!1;return function(){return xe(t,r,[...arguments],n)}},_t=function(t,r){t=G(t);function n(){return t.includes("j")?Ce(t,r):T(r)}var a=n();return typeof a!="function"&&X(`unknown function pointer with signature ${t}: ${r}`),a};class Te extends Error{}var pr=t=>{var r=_r(t),n=G(r);return st(r),n},Ie=(t,r)=>{var n=[],a={};function s(u){if(!a[u]&&!ft[u]){if(Dt[u]){Dt[u].forEach(s);return}n.push(u),a[u]=!0}}throw r.forEach(s),new Te(`${t}: `+n.map(pr).join([", "]))},Me=t=>{t=t.trim();let r=t.indexOf("(");return r===-1?t:t.slice(0,r)},Be=(t,r,n,a,s,u,f,d)=>{var g=Ae(r,n);t=G(t),t=Me(t),s=_t(a,s),be(t,function(){Ie(`Cannot call ${t} due to unbound types`,g)},r-1),dr([],g,p=>{var v=[p[0],null].concat(p.slice(1));return Re(t,ve(t,v,null,s,u),r-1),[]})},De=(t,r,n)=>{switch(r){case 1:return n?a=>ct[a]:a=>tt[a];case 2:return n?a=>xt[a>>1]:a=>vt[a>>1];case 4:return n?a=>yt[a>>2]:a=>E[a>>2];default:throw TypeError(`invalid integer width (${r}): ${t}`)}},Fe=(t,r,n,a,s)=>{r=G(r);let u=a===0,f=g=>g;if(u){var d=32-8*n;f=g=>g<<d>>>d,s=f(s)}et(t,{name:r,fromWireType:f,toWireType:(g,p)=>p,readValueFromPointer:De(r,n,a!==0),destructorFunction:null})},$e=(t,r,n)=>{var a=[Int8Array,Uint8Array,Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array][r];function s(u){var f=E[u>>2],d=E[u+4>>2];return new a(ct.buffer,d,f)}n=G(n),et(t,{name:n,fromWireType:s,readValueFromPointer:s},{ignoreDuplicateRegistrations:!0})},Se=(t,r,n,a)=>{if(!(a>0))return 0;for(var s=n,u=n+a-1,f=0;f<t.length;++f){var d=t.codePointAt(f);if(d<=127){if(n>=u)break;r[n++]=d}else if(d<=2047){if(n+1>=u)break;r[n++]=192|d>>6,r[n++]=128|d&63}else if(d<=65535){if(n+2>=u)break;r[n++]=224|d>>12,r[n++]=128|d>>6&63,r[n++]=128|d&63}else{if(n+3>=u)break;r[n++]=240|d>>18,r[n++]=128|d>>12&63,r[n++]=128|d>>6&63,r[n++]=128|d&63,f++}}return r[n]=0,n-s},pt=(t,r,n)=>Se(t,tt,r,n),mr=t=>{for(var r=0,n=0;n<t.length;++n){var a=t.charCodeAt(n);a<=127?r++:a<=2047?r+=2:a>=55296&&a<=57343?(r+=4,++n):r+=3}return r},Pe=(t,r)=>{r=G(r),et(t,{name:r,fromWireType(n){var a=E[n>>2],s=n+4,u;return u=re(s,a,!0),st(n),u},toWireType(n,a){a instanceof ArrayBuffer&&(a=new Uint8Array(a));var s,u=typeof a=="string";u||ArrayBuffer.isView(a)&&a.BYTES_PER_ELEMENT==1||X("Cannot pass non-string to std::string"),s=u?mr(a):a.length;var f=Gt(4+s+1),d=f+4;return E[f>>2]=s,u?pt(a,d,s+1):tt.set(a,d),n!==null&&n.push(st,f),f},readValueFromPointer:Bt,destructorFunction(n){st(n)}})},yr=globalThis.TextDecoder?new TextDecoder("utf-16le"):void 0,We=(t,r,n)=>{var a=t>>1,s=lr(vt,a,r/2,n);if(s-a>16&&yr)return yr.decode(vt.subarray(a,s));for(var u="",f=a;f<s;++f){var d=vt[f];u+=String.fromCharCode(d)}return u},Qe=(t,r,n)=>{if(n!=null||(n=2147483647),n<2)return 0;n-=2;for(var a=r,s=n<t.length*2?n/2:t.length,u=0;u<s;++u){var f=t.charCodeAt(u);xt[r>>1]=f,r+=2}return xt[r>>1]=0,r-a},Oe=t=>t.length*2,qe=(t,r,n)=>{for(var a="",s=t>>2,u=0;!(u>=r/4);u++){var f=E[s+u];if(!f&&!n)break;a+=String.fromCodePoint(f)}return a},ze=(t,r,n)=>{if(n!=null||(n=2147483647),n<4)return 0;for(var a=r,s=a+n-4,u=0;u<t.length;++u){var f=t.codePointAt(u);if(f>65535&&u++,yt[r>>2]=f,r+=4,r+4>s)break}return yt[r>>2]=0,r-a},Ue=t=>{for(var r=0,n=0;n<t.length;++n)t.codePointAt(n)>65535&&n++,r+=4;return r},ke=(t,r,n)=>{n=G(n);var a,s,u;r===2?(a=We,s=Qe,u=Oe):(a=qe,s=ze,u=Ue),et(t,{name:n,fromWireType:f=>{var d=E[f>>2],g=a(f+4,d*r,!0);return st(f),g},toWireType:(f,d)=>{typeof d!="string"&&X(`Cannot pass non-string to C++ string type ${n}`);var g=u(d),p=Gt(4+g+r);return E[p>>2]=g/r,s(d,p+4,g+r),f!==null&&f.push(st,p),p},readValueFromPointer:Bt,destructorFunction(f){st(f)}})},Ve=(t,r,n,a,s,u)=>{Mt[t]={name:G(r),rawConstructor:_t(n,a),rawDestructor:_t(s,u),fields:[]}},Ne=(t,r,n,a,s,u,f,d,g,p)=>{Mt[t].fields.push({fieldName:G(r),getterReturnType:n,getter:_t(a,s),getterContext:u,setterArgumentType:f,setter:_t(d,g),setterContext:p})},Le=(t,r)=>{r=G(r),et(t,{isVoid:!0,name:r,fromWireType:()=>{},toWireType:(n,a)=>{}})},Lt=[],je=t=>{var r=Lt.length;return Lt.push(t),r},Ge=(t,r)=>{var n=ft[t];return n===void 0&&X(`${r} has unknown type ${pr(t)}`),n},He=(t,r)=>{for(var n=Array(t),a=0;a<t;++a)n[a]=Ge(E[r+a*4>>2],`parameter ${a}`);return n},Ze=(t,r,n)=>{var a=[],s=t(a,n);return a.length&&(E[r>>2]=nt.toHandle(a)),s},Xe={},vr=t=>{var r=Xe[t];return r===void 0?G(t):r},Ye=(t,r,n)=>{var a=8,[s,...u]=He(t,r),f=s.toWireType.bind(s),d=u.map(p=>p.readValueFromPointer.bind(p));t--;var g=Array(t);return je(wr(`methodCaller<(${u.map(p=>p.name)}) => ${s.name}>`,(p,v,F,O)=>{for(var k=0,Q=0;Q<t;++Q)g[Q]=d[Q](O+k),k+=a;var L;switch(n){case 0:L=nt.toValue(p).apply(null,g);break;case 2:L=Reflect.construct(nt.toValue(p),g);break;case 3:L=g[0];break;case 1:L=nt.toValue(p)[vr(v)](...g);break}return Ze(f,F,L)}))},Ke=t=>t?(t=vr(t),nt.toHandle(globalThis[t])):nt.toHandle(globalThis),Je=t=>{t>9&&(dt[t+1]+=1)},tn=(t,r,n,a,s)=>Lt[t](r,n,a,s),rn=t=>{Vt(nt.toValue(t)),Nt(t)},en=(t,r,n,a)=>{var s=new Date().getFullYear(),u=new Date(s,0,1),f=new Date(s,6,1),d=u.getTimezoneOffset(),g=f.getTimezoneOffset(),p=Math.max(d,g);E[t>>2]=p*60,yt[r>>2]=+(d!=g);var v=k=>{var Q=k>=0?"-":"+",L=Math.abs(k);return`UTC${Q}${String(Math.floor(L/60)).padStart(2,"0")}${String(L%60).padStart(2,"0")}`},F=v(d),O=v(g);g<d?(pt(F,n,17),pt(O,a,17)):(pt(F,a,17),pt(O,n,17))},nn=()=>2147483648,an=(t,r)=>Math.ceil(t/r)*r,on=t=>{var r=(t-Ft.buffer.byteLength+65535)/65536|0;try{return Ft.grow(r),S(),1}catch{}},sn=t=>{var r=tt.length;t>>>=0;var n=nn();if(t>n)return!1;for(var a=1;a<=4;a*=2){var s=r*(1+.2/a);if(s=Math.min(s,t+100663296),on(Math.min(n,an(Math.max(t,s),65536))))return!0}return!1},jt={},un=()=>y||"./this.program",bt=()=>{if(!bt.strings){var t,r,n={USER:"web_user",LOGNAME:"web_user",PATH:"/",PWD:"/",HOME:"/home/web_user",LANG:((t=(r=globalThis.navigator)==null?void 0:r.language)==null?"C":t).replace("-","_")+".UTF-8",_:un()};for(var a in jt)jt[a]===void 0?delete n[a]:n[a]=jt[a];var s=[];for(var a in n)s.push(`${a}=${n[a]}`);bt.strings=s}return bt.strings},ln=(t,r)=>{var n=0,a=0;for(var s of bt()){var u=r+n;E[t+a>>2]=u,n+=pt(s,u,1/0)+1,a+=4}return 0},cn=(t,r)=>{var n=bt();E[t>>2]=n.length;var a=0;for(var s of n)a+=mr(s)+1;return E[r>>2]=a,0},fn=t=>52,dn=(t,r,n,a)=>52;function hn(t,r,n,a,s){return 70}var wn=[null,[],[]],gn=(t,r)=>{var n=wn[t];r===0||r===10?((t===1?z:B)(cr(n)),n.length=0):n.push(r)},pn=(t,r,n,a)=>{for(var s=0,u=0;u<n;u++){var f=E[r>>2],d=E[r+4>>2];r+=8;for(var g=0;g<d;g++)gn(t,tt[f+g]);s+=d}return E[a>>2]=s,0},mn=t=>t;if(o.noExitRuntime&&o.noExitRuntime,o.print&&(z=o.print),o.printErr&&(B=o.printErr),o.wasmBinary&&(P=o.wasmBinary),o.arguments&&o.arguments,o.thisProgram&&(y=o.thisProgram),o.preInit)for(typeof o.preInit=="function"&&(o.preInit=[o.preInit]);o.preInit.length>0;)o.preInit.shift()();var _r,Gt,st,x,br,Ar,Rr,Er,Ht,xr,Cr,Tr,Ft,Ir;function yn(t){_r=t.pa,Gt=o._malloc=t.ra,st=o._free=t.sa,x=t.ta,br=t.ua,Ar=t.va,Rr=t.wa,Er=t.xa,Ht=t.ya,xr=t.za,Cr=t.Aa,ht.jiji=t.Ba,ht.viijii=t.Ca,Tr=ht.jiiii=t.Da,ht.iiiiij=t.Ea,ht.iiiiijj=t.Fa,ht.iiiiiijj=t.Ga,Ft=t.na,Ir=t.qa}var vn={t:jr,u:Gr,a:Hr,g:Zr,v:Xr,_:Yr,p:Kr,Z:Jr,e:te,L:ee,da:ne,ba:ae,ea:ie,aa:oe,U:se,ka:le,T:ce,ia:he,ga:ge,M:me,N:Be,s:Fe,n:$e,ha:Pe,E:ke,F:Ve,la:Ne,ja:Le,C:Ye,ma:Nt,Q:Ke,G:Je,A:tn,W:rn,V:en,$:sn,X:ln,Y:cn,J:fn,ca:dn,S:hn,K:pn,H:On,O:In,I:Qn,l:qn,b:Cn,c:En,f:Tn,j:Fn,D:$n,r:Pn,B:Wn,x:Un,R:Vn,k:xn,i:_n,d:An,h:Rn,o:bn,y:Sn,z:Bn,q:zn,fa:Dn,m:Mn,w:kn,P:mn};function _n(t,r){var n=M();try{T(t)(r)}catch(a){if(I(n),a!==a+0)throw a;x(1,0)}}function bn(t,r,n,a,s){var u=M();try{T(t)(r,n,a,s)}catch(f){if(I(u),f!==f+0)throw f;x(1,0)}}function An(t,r,n){var a=M();try{T(t)(r,n)}catch(s){if(I(a),s!==s+0)throw s;x(1,0)}}function Rn(t,r,n,a){var s=M();try{T(t)(r,n,a)}catch(u){if(I(s),u!==u+0)throw u;x(1,0)}}function En(t,r,n){var a=M();try{return T(t)(r,n)}catch(s){if(I(a),s!==s+0)throw s;x(1,0)}}function xn(t){var r=M();try{T(t)()}catch(n){if(I(r),n!==n+0)throw n;x(1,0)}}function Cn(t,r){var n=M();try{return T(t)(r)}catch(a){if(I(n),a!==a+0)throw a;x(1,0)}}function Tn(t,r,n,a){var s=M();try{return T(t)(r,n,a)}catch(u){if(I(s),u!==u+0)throw u;x(1,0)}}function In(t,r,n,a,s,u){var f=M();try{return T(t)(r,n,a,s,u)}catch(d){if(I(f),d!==d+0)throw d;x(1,0)}}function Mn(t,r,n,a,s,u,f,d,g,p,v){var F=M();try{T(t)(r,n,a,s,u,f,d,g,p,v)}catch(O){if(I(F),O!==O+0)throw O;x(1,0)}}function Bn(t,r,n,a,s,u,f){var d=M();try{T(t)(r,n,a,s,u,f)}catch(g){if(I(d),g!==g+0)throw g;x(1,0)}}function Dn(t,r,n,a,s,u,f,d,g){var p=M();try{T(t)(r,n,a,s,u,f,d,g)}catch(v){if(I(p),v!==v+0)throw v;x(1,0)}}function Fn(t,r,n,a,s){var u=M();try{return T(t)(r,n,a,s)}catch(f){if(I(u),f!==f+0)throw f;x(1,0)}}function $n(t,r,n,a,s,u){var f=M();try{return T(t)(r,n,a,s,u)}catch(d){if(I(f),d!==d+0)throw d;x(1,0)}}function Sn(t,r,n,a,s,u){var f=M();try{T(t)(r,n,a,s,u)}catch(d){if(I(f),d!==d+0)throw d;x(1,0)}}function Pn(t,r,n,a,s,u,f){var d=M();try{return T(t)(r,n,a,s,u,f)}catch(g){if(I(d),g!==g+0)throw g;x(1,0)}}function Wn(t,r,n,a,s,u,f,d){var g=M();try{return T(t)(r,n,a,s,u,f,d)}catch(p){if(I(g),p!==p+0)throw p;x(1,0)}}function Qn(t,r,n,a){var s=M();try{return T(t)(r,n,a)}catch(u){if(I(s),u!==u+0)throw u;x(1,0)}}function On(t,r,n,a){var s=M();try{return T(t)(r,n,a)}catch(u){if(I(s),u!==u+0)throw u;x(1,0)}}function qn(t){var r=M();try{return T(t)()}catch(n){if(I(r),n!==n+0)throw n;x(1,0)}}function zn(t,r,n,a,s,u,f,d){var g=M();try{T(t)(r,n,a,s,u,f,d)}catch(p){if(I(g),p!==p+0)throw p;x(1,0)}}function Un(t,r,n,a,s,u,f,d,g,p,v,F){var O=M();try{return T(t)(r,n,a,s,u,f,d,g,p,v,F)}catch(k){if(I(O),k!==k+0)throw k;x(1,0)}}function kn(t,r,n,a,s,u,f,d,g,p,v,F,O,k,Q,L){var At=M();try{T(t)(r,n,a,s,u,f,d,g,p,v,F,O,k,Q,L)}catch(at){if(I(At),at!==at+0)throw at;x(1,0)}}function Vn(t,r,n,a,s){var u=M();try{return Tr(t,r,n,a,s)}catch(f){if(I(u),f!==f+0)throw f;x(1,0)}}function Nn(){V();function t(){var r,n;o.calledRun=!0,!D&&(J(),(r=H)==null||r(o),(n=o.onRuntimeInitialized)==null||n.call(o),Z())}o.setStatus?(o.setStatus("Running..."),setTimeout(()=>{setTimeout(()=>o.setStatus(""),1),t()},1)):t()}var $t=await Vr();return Nn(),i=C?o:new Promise((t,r)=>{H=t,W=r}),i}function Kn(e){return Pr(Wr,e)}async function Jn(e,i){return Yn(Wr,e,i)}var ta=""+new URL(__RQR_WASM_URL("zxing_writer-NQHybxPU.wasm"),import.meta.url).href;const ra=[[1,26,19],[1,26,16],[1,26,13],[1,26,9],[1,44,34],[1,44,28],[1,44,22],[1,44,16],[1,70,55],[1,70,44],[2,35,17],[2,35,13],[1,100,80],[2,50,32],[2,50,24],[4,25,9],[1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],[2,86,68],[4,43,27],[4,43,19],[4,43,15],[2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],[2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],[4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],[4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],[3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],[5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],[5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],[1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],[5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],[3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],[3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],[4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],[2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],[4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],[6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],[8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],[10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],[8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],[3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],[7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],[5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],[13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],[17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],[17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],[13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],[12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],[6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],[17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],[4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],[20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],[19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]],ea={L:0,M:1,Q:2,H:3},na=20;function aa(e,i){return ia(e,i,na)}function ia(e,i,c){const l=oa(e,i),h=4+(e<=9?8:16)+c;return Math.max(0,Math.floor((l*8-h)/8))}function oa(e,i){const c=(e-1)*4+ea[i],l=ra[c];if(!l)throw new Error(`No RS block table entry for V${e}-${i}`);let o=0;for(let h=0;h<l.length;h+=3)o+=l[h]*l[h+2];return o}let Xt=null;async function sa(e,i,c,l){const o=await ua(e,i,c,l),h=i*4+17;if(o.width===h&&o.height===h)return fa(o,l);const w=ha(i,l);if(o.width===w&&o.height===w)return ca(o);throw new Error(`ZXing QR writer returned ${o.width}x${o.height}, expected ${h}x${h} modules or ${w}x${w} pixels for V${i}-${c} at scale ${l}.`)}async function ua(e,i,c,l){da(i,c,l,e.length),await la();const o={format:"QRCode",options:`version=${i},ecLevel=${c}`,scale:l,addQuietZones:!0,addHRT:!1},h=await Jn(e,o);if(h.error)throw new Error(`ZXing QR writer failed: ${h.error}`);return h.symbol}function la(){return Xt||(Xt=Promise.resolve(Kn({overrides:{locateFile:e=>e.endsWith(".wasm")?ta:e},equalityFn:Object.is,fireImmediately:!0}))),Xt}function ca(e){if(e.data.length!==e.width*e.height)throw new Error(`ZXing QR symbol buffer size mismatch: ${e.data.length} bytes for ${e.width}x${e.height}.`);const i=new Uint8ClampedArray(e.width*e.height*4);for(let c=0;c<e.data.length;c++){const l=e.data[c]===0?0:255,o=c*4;i[o]=l,i[o+1]=l,i[o+2]=l,i[o+3]=255}return new ImageData(i,e.width,e.height)}function fa(e,i){if(e.data.length!==e.width*e.height)throw new Error(`ZXing QR symbol buffer size mismatch: ${e.data.length} bytes for ${e.width}x${e.height}.`);const c=4,l=(e.width+c*2)*i,o=new Uint8ClampedArray(l*l*4);o.fill(255);for(let h=0;h<e.height;h++)for(let w=0;w<e.width;w++){if(e.data[h*e.width+w]!==0)continue;const m=(w+c)*i,y=(h+c)*i;for(let b=0;b<i;b++){const _=((y+b)*l+m)*4;for(let A=0;A<i;A++){const $=_+A*4;o[$]=0,o[$+1]=0,o[$+2]=0,o[$+3]=255}}}return new ImageData(o,l,l)}function da(e,i,c,l){if(!Number.isInteger(e)||e<1||e>40)throw new RangeError(`Invalid QR version: ${e}. Must be 1-40.`);if(i!=="L"&&i!=="M"&&i!=="Q"&&i!=="H")throw new RangeError(`Invalid QR ECC level: ${i}.`);if(!Number.isInteger(c)||c<1)throw new RangeError(`Invalid QR render scale: ${c}.`);if(l!==void 0){const o=aa(e,i);if(l>o)throw new Error(`Data too large for ZXing QR writer V${e}-${i}. Maximum ${o} bytes for binary Uint8Array payload, got ${l}.`)}}function ha(e,i){return(e*4+17+8)*i}class rr{__destroy_into_raw(){const i=this.__wbg_ptr;return this.__wbg_ptr=0,Br.unregister(this),i}free(){const i=this.__destroy_into_raw();R.__wbg_qrrenderer_free(i,0)}buf_len(){return R.qrrenderer_buf_len(this.__wbg_ptr)>>>0}buf_ptr(){return R.qrrenderer_buf_ptr(this.__wbg_ptr)>>>0}last_matrix_size(){return R.qrrenderer_last_matrix_size(this.__wbg_ptr)>>>0}matrix_len(){return R.qrrenderer_matrix_len(this.__wbg_ptr)>>>0}matrix_ptr(){return R.qrrenderer_matrix_ptr(this.__wbg_ptr)>>>0}constructor(){const i=R.qrrenderer_new();return this.__wbg_ptr=i,Br.register(this,this.__wbg_ptr,this),this}render(i,c,l,o){try{const y=R.__wbindgen_add_to_stack_pointer(-16),b=Yt(i,R.__wbindgen_export),_=Ot;R.qrrenderer_render(y,this.__wbg_ptr,b,_,c,l,o);var h=it().getInt32(y+0,!0),w=it().getInt32(y+4,!0),m=it().getInt32(y+8,!0);if(m)throw Kt(w);return h>>>0}finally{R.__wbindgen_add_to_stack_pointer(16)}}render_matrix(i,c,l){try{const m=R.__wbindgen_add_to_stack_pointer(-16),y=Yt(i,R.__wbindgen_export),b=Ot;R.qrrenderer_render_matrix(m,this.__wbg_ptr,y,b,c,l);var o=it().getInt32(m+0,!0),h=it().getInt32(m+4,!0),w=it().getInt32(m+8,!0);if(w)throw Kt(h);return o>>>0}finally{R.__wbindgen_add_to_stack_pointer(16)}}render_rgba(i,c,l,o){try{const y=R.__wbindgen_add_to_stack_pointer(-16),b=Yt(i,R.__wbindgen_export),_=Ot;R.qrrenderer_render_rgba(y,this.__wbg_ptr,b,_,c,l,o);var h=it().getInt32(y+0,!0),w=it().getInt32(y+4,!0),m=it().getInt32(y+8,!0);if(m)throw Kt(w);return h>>>0}finally{R.__wbindgen_add_to_stack_pointer(16)}}rgba_len(){return R.qrrenderer_rgba_len(this.__wbg_ptr)>>>0}rgba_ptr(){return R.qrrenderer_rgba_ptr(this.__wbg_ptr)>>>0}}Symbol.dispose&&(rr.prototype[Symbol.dispose]=rr.prototype.free);function wa(){return{__proto__:null,"./raptorqr_fast_qr_wasm_bg.js":{__proto__:null,__wbg___wbindgen_throw_344f42d3211c4765:function(i,c){throw new Error(Dr(i,c))},__wbindgen_cast_0000000000000001:function(i,c){const l=Dr(i,c);return ga(l)}}}}const Br=typeof FinalizationRegistry>"u"?{register:()=>{},unregister:()=>{}}:new FinalizationRegistry(e=>R.__wbg_qrrenderer_free(e,1));function ga(e){Et===ot.length&&ot.push(ot.length+1);const i=Et;return Et=ot[i],ot[i]=e,i}function pa(e){e<1028||(ot[e]=Et,Et=e)}let wt=null;function it(){return(wt===null||wt.buffer.detached===!0||wt.buffer.detached===void 0&&wt.buffer!==R.memory.buffer)&&(wt=new DataView(R.memory.buffer)),wt}function Dr(e,i){return va(e>>>0,i)}let Rt=null;function Qr(){return(Rt===null||Rt.byteLength===0)&&(Rt=new Uint8Array(R.memory.buffer)),Rt}function ma(e){return ot[e]}let ot=new Array(1024).fill(void 0);ot.push(void 0,null,!0,!1);let Et=ot.length;function Yt(e,i){const c=i(e.length*1,1)>>>0;return Qr().set(e,c/1),Ot=e.length,c}function Kt(e){const i=ma(e);return pa(e),i}let Qt=new TextDecoder("utf-8",{ignoreBOM:!0,fatal:!0});Qt.decode();const ya=2146435072;let Jt=0;function va(e,i){return Jt+=i,Jt>=ya&&(Qt=new TextDecoder("utf-8",{ignoreBOM:!0,fatal:!0}),Qt.decode(),Jt=i),Qt.decode(Qr().subarray(e,e+i))}let Ot=0,R;function _a(e,i){return R=e.exports,wt=null,Rt=null,R}async function ba(e,i){if(typeof Response=="function"&&e instanceof Response){if(typeof WebAssembly.instantiateStreaming=="function")try{return await WebAssembly.instantiateStreaming(e,i)}catch(o){if(e.ok&&c(e.type)&&e.headers.get("Content-Type")!=="application/wasm")console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n",o);else throw o}const l=await e.arrayBuffer();return await WebAssembly.instantiate(l,i)}else{const l=await WebAssembly.instantiate(e,i);return l instanceof WebAssembly.Instance?{instance:l,module:e}:l}function c(l){switch(l){case"basic":case"cors":case"default":return!0}return!1}}async function Aa(e){if(R!==void 0)return R;e!==void 0&&(Object.getPrototypeOf(e)===Object.prototype?{module_or_path:e}=e:console.warn("using deprecated parameters for the initialization function; pass a single object instead")),e===void 0&&(e=new URL(""+new URL(__RQR_WASM_URL("raptorqr_fast_qr_wasm_bg-DEFhihBP.wasm"),import.meta.url).href,import.meta.url));const i=wa();(typeof e=="string"||typeof Request=="function"&&e instanceof Request||typeof URL=="function"&&e instanceof URL)&&(e=fetch(e));const{instance:c,module:l}=await ba(await e,i);return _a(c)}let Pt=null,qt=null;function Fr(){return"fast_qr WASM artifacts are not installed. Run packages/raptorqr-fast-qr-wasm/src/build_fast_qr_wasm_colab.py in Google Colab, then copy the generated files into packages/raptorqr-fast-qr-wasm/src/wasm."}async function Ra(){Pt||(Pt=Promise.resolve(Aa()).then(e=>{qt=e}).catch(e=>{throw Pt=null,e instanceof Error?e:new Error(String(e))})),await Pt}function Ea(){return qt!==null}function xa(){if(!qt)throw new Error("fast_qr WASM not initialized — call ensureFastQrWasm() first.");return qt.memory}const Ca="fast-qr-wasm";function Ta(e){switch(e){case"fast-qr-wasm":case"fast_qr_wasm":case"fastQrWasm":return"fast-qr-wasm";case"zxing-wasm":case"zxing":case"zxingWasm":return"zxing-wasm";case"color-cimbar":case"colorCimbar":return"color-cimbar";default:return Ca}}const Ia={L:0,M:1,Q:2,H:3};let Wt=null;async function Ma(e,i,c,l,o="fast-qr-wasm",s=1,z=0){switch(o){case"color-cimbar":{const r0=CimQR.render(new Uint8Array(e),s,z||0);return new ImageData(r0.data,r0.width,r0.height)}case"fast-qr-wasm":return Da(e,i,c,l);case"zxing-wasm":return sa(e,i,c,l)}}async function Ba(){Wt||(Wt=Ra().then(()=>new rr).catch(i=>{Wt=null;const c=i instanceof Error?i.message:String(i);throw new Error(`${Fr()} ${c}`)}));const e=await Wt;if(!e||!Ea())throw new Error(Fr());return e}async function Da(e,i,c,l){const o=await Ba(),h=Ia[c],w=o.render_rgba(e,i,h,l),m=w*w*4,y=xa(),b=o.rgba_ptr(),_=new Uint8ClampedArray(y.buffer,b,m),A=new Uint8ClampedArray(m);return A.set(_),new ImageData(A,w,w)}var Fa={trailer:59};function Or(e=256){let i=0,c=new Uint8Array(e);return{get buffer(){return c.buffer},reset(){i=0},bytesView(){return c.subarray(0,i)},bytes(){return c.slice(0,i)},writeByte(o){l(i+1),c[i]=o,i++},writeBytes(o,h=0,w=o.length){l(i+w);for(let m=0;m<w;m++)c[i++]=o[m+h]},writeBytesView(o,h=0,w=o.byteLength){l(i+w),c.set(o.subarray(h,h+w),i),i+=w}};function l(o){var h=c.length;if(h>=o)return;var w=1024*1024;o=Math.max(o,h*(h<w?2:1.125)>>>0),h!=0&&(o=Math.max(o,256));let m=c;c=new Uint8Array(o),i>0&&c.set(m.subarray(0,i),0)}}var tr=12,$r=5003,$a=[0,1,3,7,15,31,63,127,255,511,1023,2047,4095,8191,16383,32767,65535];function Sa(e,i,c,l,o=Or(512),h=new Uint8Array(256),w=new Int32Array($r),m=new Int32Array($r)){let y=w.length,b=Math.max(2,l);h.fill(0),m.fill(0),w.fill(-1);let _=0,A=0,$=b+1,q=$,z=!1,B=q,P=(1<<B)-1,D=1<<$-1,H=D+1,W=D+2,C=0,S=c[0],V=0;for(let U=y;U<65536;U*=2)++V;V=8-V,o.writeByte(b),Z(D);let J=c.length;for(let U=1;U<J;U++)t:{let K=c[U],mt=(K<<tr)+S,N=K<<V^S;if(w[N]===mt){S=m[N];break t}let zt=N===0?1:y-N;for(;w[N]>=0;)if(N-=zt,N<0&&(N+=y),w[N]===mt){S=m[N];break t}Z(S),S=K,W<1<<tr?(m[N]=W++,w[N]=mt):(w.fill(-1),W=D+2,z=!0,Z(D))}return Z(S),Z(H),o.writeByte(0),o.bytesView();function Z(U){for(_&=$a[A],A>0?_|=U<<A:_=U,A+=B;A>=8;)h[C++]=_&255,C>=254&&(o.writeByte(C),o.writeBytesView(h,0,C),C=0),_>>=8,A-=8;if((W>P||z)&&(z?(B=q,P=(1<<B)-1,z=!1):(++B,P=B===tr?1<<B:(1<<B)-1)),U==H){for(;A>0;)h[C++]=_&255,C>=254&&(o.writeByte(C),o.writeBytesView(h,0,C),C=0),_>>=8,A-=8;C>0&&(o.writeByte(C),o.writeBytesView(h,0,C),C=0)}}}var Pa=Sa;function Wa(e={}){let{initialCapacity:i=4096,auto:c=!0}=e,l=Or(i),o=5003,h=new Uint8Array(256),w=new Int32Array(o),m=new Int32Array(o),y=!1;return{reset(){l.reset(),y=!1},finish(){l.writeByte(Fa.trailer)},bytes(){return l.bytes()},bytesView(){return l.bytesView()},get buffer(){return l.buffer},get stream(){return l},writeHeader:b,writeFrame(_,A,$,q={}){let{transparent:z=!1,transparentIndex:B=0,delay:P=0,palette:D=null,repeat:H=0,colorDepth:W=8,dispose:C=-1}=q,S=!1;if(c?y||(S=!0,b(),y=!0):S=!!q.first,A=Math.max(0,Math.floor(A)),$=Math.max(0,Math.floor($)),S){if(!D)throw new Error("First frame must include a { palette } option");Oa(l,A,$,D,W),Sr(l,D),H>=0&&qa(l,H)}let V=Math.round(P/10);Qa(l,C,V,z,B);let J=!!D&&!S;za(l,A,$,J?D:null),J&&Sr(l,D),Ua(l,_,A,$,W,h,w,m)}};function b(){qr(l,"GIF89a")}}function Qa(e,i,c,l,o){e.writeByte(33),e.writeByte(249),e.writeByte(4),o<0&&(o=0,l=!1);var h,w;l?(h=1,w=2):(h=0,w=0),i>=0&&(w=i&7),w<<=2,e.writeByte(0|w|0|h),lt(e,c),e.writeByte(o||0),e.writeByte(0)}function Oa(e,i,c,l,o=8){let h=1,w=0,m=er(l.length)-1,y=h<<7|o-1<<4|w<<3|m;lt(e,i),lt(e,c),e.writeBytes([y,0,0])}function qa(e,i){e.writeByte(33),e.writeByte(255),e.writeByte(11),qr(e,"NETSCAPE2.0"),e.writeByte(3),e.writeByte(1),lt(e,i),e.writeByte(0)}function Sr(e,i){let c=1<<er(i.length);for(let l=0;l<c;l++){let o=[0,0,0];l<i.length&&(o=i[l]),e.writeByte(o[0]),e.writeByte(o[1]),e.writeByte(o[2])}}function za(e,i,c,l){if(e.writeByte(44),lt(e,0),lt(e,0),lt(e,i),lt(e,c),l){let o=0,h=0,w=er(l.length)-1;e.writeByte(128|o|h|0|w)}else e.writeByte(0)}function Ua(e,i,c,l,o=8,h,w,m){Pa(c,l,i,o,e,h,w,m)}function lt(e,i){e.writeByte(i&255),e.writeByte(i>>8&255)}function qr(e,i){for(var c=0;c<i.length;c++)e.writeByte(i.charCodeAt(c))}function er(e){return Math.max(Math.ceil(Math.log2(e)),1)}const ka=[[255,255,255],[0,0,0]],Va=100;function Na(e){const i=e.length/4,c=new Uint8Array(i);for(let l=0;l<i;l++){const o=l*4,h=e[o]+e[o+1]+e[o+2];c[l]=h<384?1:0}return c}function La(e,i=Va,c,l){if(e.length===0)throw new Error("At least one frame is required");const o=typeof i=="number"?new Array(e.length).fill(i):i;if(o.length!==e.length)throw new Error(`Delay array length (${o.length}) must match frame count (${e.length})`);const h=Wa({auto:!0});for(let w=0;w<e.length;w++){const m=Na(new Uint8Array(e[w].buffer,e[w].byteOffset,e[w].byteLength)),y=w===0;h.writeFrame(m,c,l,{palette:y?ka:void 0,delay:o[w],repeat:y?0:void 0})}return h.finish(),h.bytes()}const ja=10,Ga="M",Ha=200;function Za(e,i){if(!Number.isInteger(e)||e<0)throw new RangeError(`Invalid packet count: ${e}`);return Math.max(1,Math.ceil(e/i))}function Xa(e,i,c,l){if(!Number.isInteger(e)||e<0)throw new RangeError(`Invalid packet count: ${e}`);if(!Number.isInteger(l)||l<0||l>=i)throw new RangeError(`Invalid tile index: ${l}`);const o=c*i+l;return o<e?o:null}function Ya(e,i,c,l){const o=Xa(e.length,i,c,l);return o===null?null:e[o]??null}self.onmessage=e=>{const i=e.data;i.type==="generate"&&(async()=>{try{const c=await Ka(i);self.postMessage(c,{transfer:[c.gifData]})}catch(c){self.postMessage({type:"error",message:c.message??String(c)})}})()};async function Ka(e){const{packets:i}=e,c=ni(e.packetOrder,i.length),l=Ja(e.frameDelayMs),o=ti(e.qrVersion),h=ri(e.eccLevel),w=Ta(e.qrEncoder),m=ei(e.parallelCount),y=o*4+17,b=360,A=y+8,$=Math.max(2,Math.round(b/A)),q=(w==="color-cimbar"?Math.round((CimQR.SIZES[e.cimSize||0]||CimQR.SIZES[0]).total*(e.scale||1)):A*$),z=ai(m),B=[],P=q*z.columns,D=q*z.rows,H=Za(c.length,m);for(let C=0;C<H;C++){const S=new Uint8ClampedArray(P*D*4);S.fill(255);for(let V=0;V<m;V++){const J=Ya(c,m,C,V);if(J===null)continue;const Z=await Ma(i[J],o,h,$,w,e.scale||1,e.cimSize||0),U=V%z.columns*q,K=Math.floor(V/z.columns)*q;ii(S,P,Z.data,Z.width,Z.height,U,K)}B.push(new Uint8Array(S.buffer))}const W=La(B,l,P,D);return{type:"gifReady",gifData:W.buffer.slice(W.byteOffset,W.byteOffset+W.byteLength),width:P,height:D,frameCount:B.length}}function Ja(e){return Number.isFinite(e)?Math.min(500,Math.max(17,Math.round(e))):Ha}function ti(e){if(e===void 0)return ja;if(!Number.isInteger(e)||e<1||e>40)throw new RangeError(`Invalid QR version: ${e}`);return e}function ri(e){return e??Ga}function ei(e){return e===1||e===2||e===4||e===6||e===8?e:4}function ni(e,i){if(!e)return Array.from({length:i},(l,o)=>o);if(e.length!==i)throw new RangeError(`Invalid GIF packet order length: ${e.length}, expected ${i}`);const c=new Set;for(const l of e){if(!Number.isInteger(l)||l<0||l>=i)throw new RangeError(`Invalid GIF packet index: ${l}`);if(c.has(l))throw new RangeError(`Duplicate GIF packet index: ${l}`);c.add(l)}return e}function ai(e){return e===1?{columns:1,rows:1}:e===2?{columns:2,rows:1}:e===4?{columns:2,rows:2}:e===6?{columns:3,rows:2}:{columns:4,rows:2}}function ii(e,i,c,l,o,h,w){for(let m=0;m<o;m++){const y=m*l*4,b=y+l*4,_=((w+m)*i+h)*4;e.set(c.subarray(y,b),_)}}
