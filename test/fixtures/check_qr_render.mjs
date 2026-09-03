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
  // 最近一次单码识别遥测：不参与解码判定，不改变热路径；供接收端区分
  // "没有结构候选"、"已定位但格解析失败"、"已完成单码还原"。
  var lastInfo = {
    schemaVersion: 1, format: 'color-cimbar', codeType: 'color-cimbar', stage: 'idle',
    candidates: 0, finderCount: 0, selectedAnchors: 0, symbols: 0, symbolsPerFrame: 0,
    parallelCount: 1, attemptIndex: -1, attemptsTried: 0, source: 'full', markerUsed: false,
    timingScore: null, grid: null, symbolSize: null, informationDensity: null,
    samplingPoints: 0, unknownCells: 0, meanChroma: null, localIllumRange: null,
    glareRate: null, shapeMargin: null, colorMargin: null,
    wbGain: [1, 1, 1], hueOffsets: [0, 0, 0, 0]
  };
  function setInfo(p) {
    for (var k in p) lastInfo[k] = p[k];
  }

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
  // 方向无关 Finder 检测：把检测图按 θ 旋回 canonical 轴后复用 1:1:3:1:1
  // profile。它只在水平首层不足/失锁时启用，避免正常帧增加 36 次全图扫描成本。
  // 输出候选映射回原图，并保留 angle 供局部轴向精化和 BR 搜索使用。
  function rotateGrayForFinder(gray, w, h, angle) {
    var out = new Uint8Array(w * h), cx = (w - 1) * 0.5, cy = (h - 1) * 0.5;
    var ca = Math.cos(angle), sa = Math.sin(angle);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var dx = x - cx, dy = y - cy;
      // output = source rotated -angle，因此逆采样 source = R(angle)·output
      var sx = ca * dx - sa * dy + cx, sy = sa * dx + ca * dy + cy, o = y * w + x;
      if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) { out[o] = 255; continue; }
      var x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      var p = y0 * w + x0;
      out[o] = gray[p] * (1 - fx) * (1 - fy) + gray[p + 1] * fx * (1 - fy) + gray[p + w] * (1 - fx) * fy + gray[p + w + 1] * fx * fy;
    }
    return out;
  }
  function mapFinderFromRotated(c, w, h, angle) {
    var cx = (w - 1) * 0.5, cy = (h - 1) * 0.5, ca = Math.cos(angle), sa = Math.sin(angle);
    var dx = c.x - cx, dy = c.y - cy;
    // rotateGrayForFinder samples source at R(+angle)·p; map canonical candidate back with R(+angle).
    return { x: ca * dx - sa * dy + cx, y: sa * dx + ca * dy + cy, module: c.module, n: c.n, angle: angle, score: c.n };
  }
  function mergeDirectionalFinders(all) {
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var c = all[i], found = -1;
      for (var j = 0; j < out.length; j++) {
        var q = out[j], lim = Math.max(2, Math.min(c.module, q.module) * 1.8);
        if (Math.hypot(c.x - q.x, c.y - q.y) <= lim && Math.abs(c.module - q.module) <= Math.max(c.module, q.module) * 0.35) { found = j; break; }
      }
      if (found < 0) out.push(c);
      else if ((c.score || 0) > (out[found].score || 0)) out[found] = c;
    }
    return out;
  }
  function detectFindersDirectional(gray, w, h) {
    var all = [], cx = (w - 1) * 0.5, cy = (h - 1) * 0.5;
    // 5° 粗方向覆盖 0..175°；局部 refineFinder 会以候选方向消除剩余角度误差。
    for (var deg = 0; deg < 180; deg += 5) {
      var angle = deg * Math.PI / 180, rg = deg === 0 ? gray : rotateGrayForFinder(gray, w, h, angle);
      var cs = detectFinders(rg, w, h);
      for (var i = 0; i < cs.length; i++) all.push(mapFinderFromRotated(cs[i], w, h, angle));
    }
    return mergeDirectionalFinders(all);
  }

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
            var modRatioOK = d1 / t.module > 16 && d1 / t.module < 320; // 强透视下远近边长度会显著变化，仍保留候选交给后续锚点验证
            if (!modRatioOK || Math.abs(d) > 0.72 || legRatio > 0.72 || mRatio > 0.8) continue;
            // 透视感知评分而非硬等腿：直角/等腿只作为排序项，Timing/TL/BR/帧头负责最终裁决。
            var sc = Math.abs(d) * 0.7 + legRatio * 0.8 + mRatio * 0.5;
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
            // Finder 边向量直接给出符号 x 轴方向；不能只平均候选扫描角（轴向首层常为 0°）。
            best = { tl: tl, tr: tr, bl: bl, module: mod3, orient: cross > 0 ? 1 : -1,
                     angle: Math.atan2(tr.y - tl.y, tr.x - tl.x) };
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

  // 沿 Finder 自身方向精化中心：旋转/斜拍时不再把图像行列当作符号轴。
  function refineFinderOriented(gray, w, h, cx, cy, module, angle) {
    if (!angle || Math.abs(angle) < 0.015) return refineFinder(gray, w, h, cx, cy, module);
    var ca = Math.cos(angle), sa = Math.sin(angle), ux = ca, uy = sa, vx = -sa, vy = ca;
    function lumAt(x, y) {
      if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return 255;
      var x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, p = y0 * w + x0;
      return gray[p] * (1 - fx) * (1 - fy) + gray[p + 1] * fx * (1 - fy) + gray[p + w] * (1 - fx) * fy + gray[p + w + 1] * fx * fy;
    }
    function profile(axis, offset) {
      var R = Math.ceil(4.2 * module), lo = -R, hi = R, rd = [], rl = [], prev = -1, run = 0;
      for (var t = lo; t <= hi; t++) {
        var x = axis === 0 ? cx + ux * t + vx * offset : cx + ux * offset + vx * t;
        var y = axis === 0 ? cy + uy * t + vy * offset : cy + uy * offset + vy * t;
        var dark = lumAt(x, y) < 120 ? 1 : 0;
        if (prev < 0) { prev = dark; run = 1; }
        else if (dark === prev) run++;
        else { rd.push(prev); rl.push(run); prev = dark; run = 1; }
      }
      if (prev >= 0) { rd.push(prev); rl.push(run); }
      var best = null, bestErr = 1e9;
      for (var ri = 0; ri + 4 < rd.length; ri++) {
        if (!(rd[ri] && !rd[ri + 1] && rd[ri + 2] && !rd[ri + 3] && rd[ri + 4])) continue;
        var mm = rl[ri + 2] / 3;
        if (mm < 1.5 || !ratioOK([rl[ri], rl[ri + 1], rl[ri + 2], rl[ri + 3], rl[ri + 4]])) continue;
        var start = lo; for (var rj = 0; rj < ri; rj++) start += rl[rj];
        var center = start + rl[ri] + rl[ri + 1] + mm * 1.5, err = Math.abs(center);
        if (err < bestErr && err <= mm * 2.5) { bestErr = err; best = { center: center, module: mm }; }
      }
      return best;
    }
    var sx = 0, sy = 0, nx = 0, ny = 0;
    for (var off = -0.7 * module; off <= 0.7 * module + 1e-6; off += 0.7 * module) {
      var pxr = profile(0, off), pyr = profile(1, off);
      if (pxr) { sx += pxr.center; nx++; }
      if (pyr) { sy += pyr.center; ny++; }
    }
    if (nx < 2 || ny < 2) return refineFinder(gray, w, h, cx, cy, module);
    sx /= nx; sy /= ny;
    return { x: cx + sx * ux + sy * vx, y: cy + sx * uy + sy * vy };
  }

  // 模板缓存：按 NSP/INNER/渲染倍率桶 分档。相位感知映射（替代旧 floor(pxv)/低倍率
  // 奇偶模板）：非整数倍率下采样像素显示的图案像素 = floor((floor(φ+q·R)-φ)/R)，
  // φ 为格起点图像相位（M=round(32R) 取整后抵消，用实测 finder 中心对齐），
  // q 为格内采样符号位置；越界（图案不可见=背景）按未点亮处理。
  // 整数/半倍率下自动退化为旧 floor/奇偶行为（φ=0 时序列即 floor(pxv)）。
  // 检测缓存：同帧同 SCALE 复用 finder 候选（阶梯各层同降采样尺寸时省重复检测/精化）
  var detToken = 0, detCacheKey = '', detCands = [];
  // 相机标准化帧：结构定位使用 structureLuma，颜色采样使用 rawRGBA + localWB；
  // 同一帧的所有 ATTEMPT 复用，避免每次重算灰度，也明确划开采集与解析边界。
  var normalizedFrame = null;
  function prepareNormalizedFrame(rgba, w, h) {
    var gray = new Uint8Array(w * h), o = 0;
    for (var i = 0; i < w * h; i++, o += 4)
      gray[i] = (rgba[o] * 299 + rgba[o + 1] * 587 + rgba[o + 2] * 114) / 1000;
    var highlights = buildHighlightMask(rgba, gray, w, h);
    normalizedFrame = {
      rawRGBA: rgba,
      width: w,
      height: h,
      structureLuma: gray,
      enhancedLuma: null,
      correctedRGB: null,
      chroma: null,
      highlightMask: highlights.mask,
      qualityMap: highlights.quality,
      localWB: localWB,
      wbGain: wbGain.slice(),
      hueOffsets: hueOffsets.slice(),
      glareRate: highlights.glare / Math.max(1, w * h)
    };
    return normalizedFrame;
  }
  function getNormalizedFrame(rgba, w, h) {
    return normalizedFrame && normalizedFrame.rawRGBA === rgba && normalizedFrame.width === w && normalizedFrame.height === h
      ? normalizedFrame : prepareNormalizedFrame(rgba, w, h);
  }
  function buildHighlightMask(rgba, gray, w, h) {
    var n = w * h, mask = new Uint8Array(n), quality = new Uint8Array(n), bright = 0, glare = 0, o;
    for (var i = 0; i < n; i++) {
      o = i * 4;
      var r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
      var mx = Math.max(r, g, b), mn = Math.min(r, g, b), ch = mx - mn;
      if (gray[i] > 220) bright++;
      // 纯白背景/静区不是反光：只标记“比邻域突然变亮”的低色度饱和斑，
      // 这样白色背景不会把 glareRate 推到接近 1，也不会被采样器整片跳过。
      var x = i % w, y = (i / w) | 0, sum = gray[i], count = 1;
      // 十字邻域近似局部背景，足以区分屏幕反光的突变，又比每像素 5×5
      // 窗口便宜很多；精确采样仍由后面的 2×2/邻域逻辑完成。
      if (x > 0) { sum += gray[i - 1]; count++; }
      if (x + 1 < w) { sum += gray[i + 1]; count++; }
      if (y > 0) { sum += gray[i - w]; count++; }
      if (y + 1 < h) { sum += gray[i + w]; count++; }
      var localMean = sum / count;
      var isGlare = mx > 242 && ch < 34 && localMean < 190 && gray[i] - localMean > 24;
      if (isGlare) { mask[i] = 1; glare++; quality[i] = 72; }
      else quality[i] = 255;
    }
    return { mask: mask, quality: quality, bright: bright, glare: glare };
  }
  // 共享结构增强：3×3 局部均值 + 受限 unsharp。只用于定位/普通 QR 回退，
  // 不改原始 RGBA，不改变 CimQR 线上协议；彩色数据仍使用原始颜色视图。
  function enhancedLumaOf(gray, w, h) {
    var n = w * h, tmp = new Uint8Array(n), out = new Uint8ClampedArray(n), x, y, i;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var s = 0, c = 0;
        for (var dx = -1; dx <= 1; dx++) { var xx = x + dx; if (xx >= 0 && xx < w) { s += gray[y * w + xx]; c++; } }
        tmp[y * w + x] = s / c;
      }
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var s2 = 0, c2 = 0;
        for (var dy = -1; dy <= 1; dy++) { var yy = y + dy; if (yy >= 0 && yy < h) { s2 += tmp[yy * w + x]; c2++; } }
        var p = y * w + x, v = gray[p], blur = s2 / c2;
        // 1.25 倍高频增强，限幅 ±32，避免把相机噪声变成结构候选。
        out[p] = Math.max(0, Math.min(255, v + Math.max(-32, Math.min(32, (v - blur) * 1.25))));
      }
    }
    return out;
  }
  function getEnhancedLuma(frame) {
    if (!frame.enhancedLuma) frame.enhancedLuma = enhancedLumaOf(frame.structureLuma, frame.width, frame.height);
    return frame.enhancedLuma;
  }
  function enhanceImageData(rgba, w, h) {
    var f = getNormalizedFrame(rgba, w, h), e = getEnhancedLuma(f), out = new Uint8ClampedArray(w * h * 4), i, v;
    for (i = 0; i < w * h; i++) { v = e[i]; out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255; }
    return { data: out, width: w, height: h };
  }
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
  function sizeFromSpan(spanPx, modPx, spanY, modY) {
    var imgX = Math.round(spanPx / Math.max(0.5, modPx)) * 8 + 64;
    var imgY = spanY == null ? imgX : Math.round(spanY / Math.max(0.5, modY || modPx)) * 8 + 64;
    var best = 0, bestD = 1e9, i;
    for (i = 0; i < SIZES.length; i++) {
      var d = Math.abs(SIZES[i].img - imgX) + Math.abs(SIZES[i].img - imgY);
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
  // 相机→标准色彩第一步：从亮、低色度背景估计 RGB 增益，只纠正色偏，不改变曝光。
  var wbGain = [1, 1, 1];
  // 局部白点场：低分辨率网格只服务数据区颜色采样，结构定位仍使用原始灰度。
  // 每个格只查最近场节点，限幅防止反光/噪声被放大；没有足够中性点时退回全局增益。
  var localWB = null, localWBW = 0, localWBH = 0;
  function estimateLocalWB(rgba, w, h) {
    var gw = 16, gh = 16, stride = w * 4;
    var sum = new Float64Array(gw * gh * 3), cnt = new Uint16Array(gw * gh);
    var step = Math.max(2, Math.floor(Math.max(w, h) / 320));
    for (var y = 0; y < h; y += step) for (var x = 0; x < w; x += step) {
      var o = y * stride + x * 4, r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
      var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx < 110 || mx - mn > 82) continue;
      var ix = Math.min(gw - 1, (x * gw / w) | 0), iy = Math.min(gh - 1, (y * gh / h) | 0), q = iy * gw + ix;
      sum[q * 3] += r; sum[q * 3 + 1] += g; sum[q * 3 + 2] += b; cnt[q]++;
    }
    var valid = 0;
    // 先算全局白点，作为没有局部中性参考 tile 的安全回退。
    for (var q2 = 0; q2 < cnt.length; q2++) if (cnt[q2]) {
      var ar = sum[q2 * 3] / cnt[q2], ag = sum[q2 * 3 + 1] / cnt[q2], ab = sum[q2 * 3 + 2] / cnt[q2];
      var gr = 255 / Math.max(1, ar), gg = 255 / Math.max(1, ag), gb = 255 / Math.max(1, ab);
      var gm = Math.pow(gr * gg * gb, 1 / 3); gr /= gm; gg /= gm; gb /= gm;
      sum[q2 * 3] = Math.max(0.72, Math.min(1.4, gr));
      sum[q2 * 3 + 1] = Math.max(0.72, Math.min(1.4, gg));
      sum[q2 * 3 + 2] = Math.max(0.72, Math.min(1.4, gb));
      valid++;
    }
    if (valid < 4) { localWB = null; localWBW = gw; localWBH = gh; return valid; }
    // 填洞：反光/彩色数据区可能没有中性点，不能让未填 tile 的 0 增益污染采样。
    for (q2 = 0; q2 < cnt.length; q2++) if (!cnt[q2]) {
      var ix2 = q2 % gw, iy2 = (q2 / gw) | 0, best = -1, bd = 1e9;
      for (var q3 = 0; q3 < cnt.length; q3++) if (cnt[q3]) {
        var dx2 = (q3 % gw) - ix2, dy2 = ((q3 / gw) | 0) - iy2, dd = dx2 * dx2 + dy2 * dy2;
        if (dd < bd) { bd = dd; best = q3; }
      }
      if (best >= 0) { sum[q2 * 3] = sum[best * 3]; sum[q2 * 3 + 1] = sum[best * 3 + 1]; sum[q2 * 3 + 2] = sum[best * 3 + 2]; }
    }
    localWB = sum; localWBW = gw; localWBH = gh;
    return valid;
  }
  function localGainAt(w, h, x, y) {
    if (!localWB) return wbGain;
    var q = Math.min(localWBW - 1, (x * localWBW / w) | 0) + Math.min(localWBH - 1, (y * localWBH / h) | 0) * localWBW;
    return [localWB[q * 3], localWB[q * 3 + 1], localWB[q * 3 + 2]];
  }
  function localColor(rgba, w, h, o) {
    var r = rgba[o], g = rgba[o + 1], b = rgba[o + 2], p = o >> 2;
    var gain = localGainAt(w, h, p % w, (p / w) | 0);
    return [r * gain[0], g * gain[1], b * gain[2]];
  }
  function estimateWBGain(rgba, w, h) {
    var step = Math.max(4, Math.floor(Math.max(w, h) / 160)), stride = w * 4;
    var n = 0, sr = 0, sg = 0, sb = 0;
    for (var y = 0; y < h; y += step) for (var x = 0; x < w; x += step) {
      var o = y * stride + x * 4, r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
      var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx < 140 || mx - mn > 70) continue;
      sr += r; sg += g; sb += b; n++;
    }
    if (n < 16) { wbGain = [1, 1, 1]; return; }
    var gr = 255 / (sr / n), gg = 255 / (sg / n), gb = 255 / (sb / n);
    var gm = Math.pow(gr * gg * gb, 1 / 3);
    gr /= gm; gg /= gm; gb /= gm;
    wbGain = (gr > 0.6 && gr < 1.7 && gg > 0.6 && gg < 1.7 && gb > 0.6 && gb < 1.7) ? [gr, gg, gb] : [1, 1, 1];
  }
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
          var r = rgba[o] * wbGain[0], g = rgba[o + 1] * wbGain[1], b = rgba[o + 2] * wbGain[2];
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
  // 无阈值最近中心：仅用于高色度但超容差的软判决降权投票，不直接接受低色度样本。
  function hueNearest(hue) {
    var best = 0, bestD = 1e9;
    for (var e = 0; e < 4; e++) {
      var dc = Math.abs(hue - (HUE_EXPECTED[e] + hueOffsets[e]));
      if (dc > 180) dc = 360 - dc;
      if (dc < bestD) { bestD = dc; best = e; }
    }
    return best;
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

  // 密集单格证据：软判决层按 canonical 8×8 图样逐像素采样，而不是先把
  // 一个格压成少量二值点。H 只负责把 canonical 像素映射回相机，图样匹配始终
  // 在符号坐标中完成；颜色只在候选图样的亮点上独立评分。
  // 这不是 RS/FEC：它解决的是同一个二维码内部的视觉采样冗余。
  function decodeDenseCell(rgba, w, h, H, ox, oy, normalized, stride) {
    var N = 64, lum = new Float64Array(N), sr = new Float64Array(N),
        sg = new Float64Array(N), sb = new Float64Array(N), wt = new Float64Array(N);
    var valid = 0, q, sy, sx, dy, dx, sumR, sumG, sumB, sumW, sumCh;
    // 每个 canonical 图样像素取四个轻微偏移点，覆盖相机重采样后的像素面积；
    // 偏移留在该图样像素内部，避免把 8×8 邻接图样混成一个色块。
    var offs = [-0.22, 0.22];
    for (sy = 0; sy < 8; sy++) for (sx = 0; sx < 8; sx++) {
      q = sy * 8 + sx; sumR = sumG = sumB = sumW = sumCh = 0;
      for (dy = 0; dy < 2; dy++) for (dx = 0; dx < 2; dx++) {
        var pp = H.map(ox + sx + 0.5 + offs[dx], oy + sy + 0.5 + offs[dy]);
        var ix = pp[0], iy = pp[1];
        if (ix < 0 || iy < 0 || ix >= w - 1 || iy >= h - 1) continue;
        var x0 = ix | 0, y0 = iy | 0, fx = ix - x0, fy = iy - y0;
        var p00 = y0 * stride + x0 * 4, p10 = p00 + 4, p01 = p00 + stride, p11 = p01 + 4;
        var rr = rgba[p00] * (1 - fx) * (1 - fy) + rgba[p10] * fx * (1 - fy) + rgba[p01] * (1 - fx) * fy + rgba[p11] * fx * fy;
        var gg = rgba[p00 + 1] * (1 - fx) * (1 - fy) + rgba[p10 + 1] * fx * (1 - fy) + rgba[p01 + 1] * (1 - fx) * fy + rgba[p11 + 1] * fx * fy;
        var bb = rgba[p00 + 2] * (1 - fx) * (1 - fy) + rgba[p10 + 2] * fx * (1 - fy) + rgba[p01 + 2] * (1 - fx) * fy + rgba[p11 + 2] * fx * fy;
        var px = x0, py = y0, quality = 1;
        if (normalized && normalized.highlightMask && normalized.highlightMask[py * w + px]) quality = 0.28;
        var gain = localGainAt(w, h, px, py);
        rr *= gain[0]; gg *= gain[1]; bb *= gain[2];
        sumR += rr * quality; sumG += gg * quality; sumB += bb * quality;
        sumCh += (Math.max(rr, gg, bb) - Math.min(rr, gg, bb)) * quality;
        sumW += quality;
      }
      if (sumW <= 0) { wt[q] = 0; continue; }
      sr[q] = sumR / sumW; sg[q] = sumG / sumW; sb[q] = sumB / sumW;
      // 使用颜色无关的前景能量：亮点必须同时有色度/通道峰值，避免绿、青、黄、品红
      // 因 BT.601 亮度不同而把颜色差异误当成图形位。
      lum[q] = (sumCh / sumW) + Math.max(0, (sumR + sumG + sumB) / sumW - 24) * 0.18;
      wt[q] = sumW; valid++;
    }
    if (valid < 48) return null;
    // 用 10%/90% 分位估计暗底与亮点，避免一个反光像素决定整格动态范围。
    var ordered = new Float64Array(N); ordered.set(lum); ordered.sort();
    var lo = ordered[4], hi = ordered[59], range = hi - lo;
    if (!(range >= 8)) return { unknown: true, shapeMargin: 0, colorMargin: 0 };
    var norm = new Float64Array(N), totalW = 0;
    for (q = 0; q < N; q++) {
      norm[q] = Math.max(0, Math.min(1, (lum[q] - lo) / range));
      totalW += wt[q];
    }
    var best = 0, second = 0, bestErr = 1e9, secondErr = 1e9, s, bit, err;
    for (s = 0; s < 16; s++) {
      err = 0;
      for (q = 0; q < N; q++) {
        bit = Number((PATTERNS[s] >> BigInt(63 - q)) & 1n);
        var de = norm[q] - bit;
        err += wt[q] * de * de;
      }
      if (err < bestErr) { secondErr = bestErr; second = best; bestErr = err; best = s; }
      else if (err < secondErr) { secondErr = err; second = s; }
    }
    var shapeErr = bestErr / Math.max(1, totalW), shapeMargin = (secondErr - bestErr) / Math.max(1, totalW);
    if (shapeErr > 0.52) return { unknown: true, shapeMargin: shapeMargin, colorMargin: 0 };

    // 对候选图样的亮点做颜色评分：色相距离宽容到 ±75°，同时要求有足够色度；
    // 背景点不参与主判定，反光点只按低质量权重进入。
    var colorScore = [0, 0, 0, 0], colorWeight = [0, 0, 0, 0], c, maxC, minC, ch, hue, hd, conf;
    for (q = 0; q < N; q++) {
      bit = Number((PATTERNS[best] >> BigInt(63 - q)) & 1n);
      if (!bit || wt[q] <= 0) continue;
      var r = sr[q], g = sg[q], b = sb[q];
      maxC = Math.max(r, g, b); minC = Math.min(r, g, b); ch = maxC - minC;
      if (ch < 10 || maxC < 18) continue;
      if (maxC === r) hue = ((g - b) / ch) * 60;
      else if (maxC === g) hue = 120 + ((b - r) / ch) * 60;
      else hue = 240 + ((r - g) / ch) * 60;
      if (hue < 0) hue += 360;
      for (c = 0; c < 4; c++) {
        hd = Math.abs(hue - (HUE_EXPECTED[c] + hueOffsets[c]));
        if (hd > 180) hd = 360 - hd;
        conf = Math.max(0, 1 - hd / 75) * Math.min(1, ch / 72);
        colorScore[c] += conf * wt[q]; colorWeight[c] += wt[q];
      }
    }
    var bestC = 0, secondC = 0, bestCS = -1, secondCS = -1;
    for (c = 0; c < 4; c++) {
      var cs = colorWeight[c] ? colorScore[c] / colorWeight[c] : 0;
      if (cs > bestCS) { secondCS = bestCS; secondC = bestC; bestCS = cs; bestC = c; }
      else if (cs > secondCS) { secondCS = cs; secondC = c; }
    }
    var colorMargin = bestCS - Math.max(0, secondCS);
    if (bestCS < 0.16) return { unknown: true, shapeMargin: shapeMargin, colorMargin: colorMargin };
    return { value: (bestC << SYMBOL_BITS) | best, unknown: false, shapeMargin: shapeMargin, colorMargin: colorMargin };
  }

  // 顶部/左侧时序线质量：不是数据颜色，而是第三类结构锚点。
  // 当前只做质量评分（不直接拒帧），用于区分“几何已锁定但局部反光”与误检，
  // 后续可用于多候选排序；黑白和彩色共用这组固定黑白交替点。
  function timingScore(rgba, w, h, H, IMG2) {
    var stride = w * 4, total = 0, hit = 0, k;
    function sample(x, y, darkExpected) {
      var p = H.map(x, y), xx = Math.round(p[0]), yy = Math.round(p[1]);
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) return;
      var o = yy * stride + xx * 4;
      var lum = (rgba[o] * 299 + rgba[o + 1] * 587 + rgba[o + 2] * 114) / 1000;
      var dark = lum < 145;
      total++; if (dark === darkExpected) hit++;
    }
    for (k = 0; 64 + k * 8 < IMG2 - 72; k++) {
      var d = (k & 1) === 0;
      sample(64 + k * 8 + 4, 60, d);
      sample(60, 64 + k * 8 + 4, d);
    }
    return total ? hit / total : 0;
  }

  // 单次解码尝试：detTarget=检测用降采样目标边长，INNER=格内采样跨度（越小越抗模糊/混色），
  // soft=软判决匹配，useMarker=用 BR 对齐标记作第 4 角点（否则平行四边形估计）
  function decodeAttempt(rgba, w, h, detTarget, INNER, soft, useMarker, rMode) {
    // 结构视图与颜色视图分离：Finder/Timing/BR 只使用一次生成的原始灰度，
    // 数据格颜色采样另走 localWB；所有 ATTEMPT 复用同一 NormalizedFrame。
    var normalized = getNormalizedFrame(rgba, w, h);
    var gray = normalized.structureLuma;
    // 首层保留原始灰度；只有原始候选不足时才切换增强结构视图，避免正常帧为锐化付出成本。
    var i, o = 0;

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
    var sel0 = cands.length >= 3 ? selectTriple(cands) : null;
    // 首层是廉价轴向检测；只有没有形成可靠三角时才启用增强结构视图。
    // 增强图再进入方向扫描，避免把锐化噪声引入正常帧的候选集合。
    if (!sel0) {
      var enhanced = getEnhancedLuma(normalized);
      var ew = w, eh = h, eg = enhanced;
      if (SCALE < 1) {
        ew = dw; eh = dh; eg = new Uint8Array(ew * eh);
        for (var ey = 0; ey < eh; ey++) {
          var esy = Math.min(h - 1, Math.round(ey / SCALE));
          for (var ex = 0; ex < ew; ex++) {
            var esx = Math.min(w - 1, Math.round(ex / SCALE));
            eg[ey * ew + ex] = enhanced[esy * w + esx];
          }
        }
      }
      var enhancedCands = detectFinders(eg, ew, eh);
      if (enhancedCands.length > cands.length) cands = enhancedCands;
      sel0 = cands.length >= 3 ? selectTriple(cands) : null;
      var directional = sel0 ? [] : detectFindersDirectional(eg, ew, eh);
      if (directional.length > cands.length) cands = directional;
      sel0 = cands.length >= 3 ? selectTriple(cands) : null;
      setInfo({ source: 'enhanced', directionalCandidates: directional.length, enhancedCandidates: enhancedCands.length });
    }
    if (typeof self !== "undefined" && self.__CIMQR_DEBUG__) self.__CIMQR_DEBUG__({ phase: 'det', cands: cands.slice(0, 12).map(function(c){return {x:+c.x.toFixed(1), y:+c.y.toFixed(1), m:+c.module.toFixed(2), n:c.n, angle:c.angle||0};}) });
    setInfo({ stage: 'located', candidates: cands.length, finderCount: cands.length, selectedAnchors: 0, symbols: 0, symbolsPerFrame: 0, source: sel0 ? (sel0.tl && sel0.tl.angle ? 'enhanced' : 'full') : 'full', attemptIndex: -1, grid: null, symbolSize: null, informationDensity: null });
    if (!sel0) { setInfo({ stage: 'no-anchor' }); return []; }
    // —— 多符号并行：同一帧可含多个 CimQR 符号（网格布局），逐符号解码，解完移除其寻像候选 ——
    var packets = [];
    var MAX_SYMBOLS = 8;
    var firstH = null;
    for (var symN = 0; symN < MAX_SYMBOLS; symN++) {
    var sel = selectTriple(cands);
    if (!sel) break;
    setInfo({ selectedAnchors: 3 });
    var mod = sel.module;
    // 放大回原图坐标
    var tl = { x: sel.tl.x / SCALE, y: sel.tl.y / SCALE };
    var tr = { x: sel.tr.x / SCALE, y: sel.tr.y / SCALE };
    var bl = { x: sel.bl.x / SCALE, y: sel.bl.y / SCALE };
    var modFull = mod / SCALE;
    // 全分辨率精化寻像中心（缩小检测会引入亚像素误差，直接放大误差放大）
    // 方向候选只负责提供旋转轴；当前中心精化仍使用原始双轴 run 投票，
    // 避免局部透视下单条 profile 把 Finder 中心推离真实几何中心。
    // 旋转/透视由三 Finder + BR 单应共同处理，方向精化留作后续质量通过后的可选微调。
    tl = refineFinder(gray, w, h, tl.x, tl.y, modFull);
    tr = refineFinder(gray, w, h, tr.x, tr.y, modFull);
    bl = refineFinder(gray, w, h, bl.x, bl.y, modFull);
    if (!tl || !tr || !bl) { cands = dropTriple(cands, sel); continue; }
    // 尺寸自描述：先用 finder 几何（间距/模块 → 画布边长）估计档位并构建 H，
    // 再读 TL 角标记码确认/纠正（失败保留几何估计）；档位决定采样/RS/帧头
    var spanPx = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    var spanPy = Math.hypot(bl.x - tl.x, bl.y - tl.y);
    var sIdx = sizeFromSpan(spanPx, modFull, spanPy, modFull);
    var SZ = SIZES[sIdx];
    var IMG2 = SZ.img;
    setInfo({ grid: SZ.grid, symbolSize: SZ.total, informationDensity: SZ.packet, formatByte: sIdx + 1 });
    var symTL = [28, 28], symTR = [IMG2 - 36, 28], symBL = [28, IMG2 - 36], symBR = [IMG2 - 36, IMG2 - 36];
    var imgTL = [tl.x, tl.y], imgTR = [tr.x, tr.y], imgBL = [bl.x, bl.y];
    // BR 用平行四边形估计
    var imgBR = [tl.x + (tr.x - tl.x) + (bl.x - tl.x), tl.y + (tr.y - tl.y) + (bl.y - tl.y)];
    var H = solveHomography([symTL, symTR, symBL, symBR], [imgTL, imgTR, imgBL, imgBR]);
    if (!H) { cands = dropTriple(cands, sel); continue; }
    var sm = readSizeMark(rgba, w, h, H);
    if (sm !== null && sm !== sIdx) {
      // 尺寸标记是独立格式锚点；档位变化后必须重建符号坐标和 H，不能沿用旧档位外推。
      sIdx = sm;
      SZ = SIZES[sIdx];
      IMG2 = SZ.img;
      symTR = [IMG2 - 36, 28]; symBL = [28, IMG2 - 36]; symBR = [IMG2 - 36, IMG2 - 36];
      imgBR = [tl.x + (tr.x - tl.x) + (bl.x - tl.x), tl.y + (tr.y - tl.y) + (bl.y - tl.y)];
      H = solveHomography([symTL, symTR, symBL, symBR], [imgTL, imgTR, imgBL, imgBR]);
      if (!H) { cands = dropTriple(cands, sel); continue; }
    }
    SZ = SIZES[sIdx];
    IMG2 = SZ.img;
    // BR 对齐标记精化：用完整初始 H 预测 marker 中心，并在 H 的局部 u/v 坐标中
    // 搜索。完整 5×5 结构匹配（边框+中心暗、其余白）排除把 TR/Finder 误当 BR。
    // 命中后以真实第四点重解 DLT；未命中才保留三 Finder 平行四边形回退。
    if (useMarker) try {
      var p0m = H.map(IMG2 - 52, IMG2 - 52);
      var pu = H.map(IMG2 - 51, IMG2 - 52), pv = H.map(IMG2 - 52, IMG2 - 51);
      var ux = pu[0] - p0m[0], uy = pu[1] - p0m[1], vx = pv[0] - p0m[0], vy = pv[1] - p0m[1];
      var ul = Math.hypot(ux, uy) || modFull, vl = Math.hypot(vx, vy) || modFull;
      ux /= ul; uy /= ul; vx /= vl; vy /= vl;
      var mstride = w * 4, markC = null, bestMarkScore = -1e9, bestMarkDist = 1e9;
      function markerPatternScore(cxm, cym) {
        var score = 0, weight = 0, valid = true;
        // 中心点 + 靠近四条边的点共同评分；只采中心会形成半模块宽的平台，
        // 无法从满分候选中选出真正的透视第四点。
        var probes = [[0, 0, 1], [3.0, 0, 0.8], [-3.0, 0, 0.8], [0, 3.0, 0.8], [0, -3.0, 0.8],
                      [2.6, 2.6, 0.55], [2.6, -2.6, 0.55], [-2.6, 2.6, 0.55], [-2.6, -2.6, 0.55]];
        for (var my3 = 0; my3 < 5 && valid; my3++) for (var mx3 = 0; mx3 < 5 && valid; mx3++) {
          var wantDark3 = (mx3 === 0 || mx3 === 4 || my3 === 0 || my3 === 4 || (mx3 === 2 && my3 === 2));
          for (var pi3 = 0; pi3 < probes.length; pi3++) {
            var pr3 = probes[pi3];
            var qx3 = cxm + ((mx3 - 2) * 8 + pr3[0]) * ux * ul + ((my3 - 2) * 8 + pr3[1]) * vx * vl;
            var qy3 = cym + ((mx3 - 2) * 8 + pr3[0]) * uy * ul + ((my3 - 2) * 8 + pr3[1]) * vy * vl;
            if (qx3 < 0 || qy3 < 0 || qx3 >= w - 1 || qy3 >= h - 1) { valid = false; break; }
            var qx0 = qx3 | 0, qy0 = qy3 | 0, qfx = qx3 - qx0, qfy = qy3 - qy0;
            var qp = qy0 * mstride + qx0 * 4;
            var qlum3 = ((rgba[qp] * (1 - qfx) * (1 - qfy) + rgba[qp + 4] * qfx * (1 - qfy) + rgba[qp + mstride] * (1 - qfx) * qfy + rgba[qp + mstride + 4] * qfx * qfy) * 299 +
                         (rgba[qp + 1] * (1 - qfx) * (1 - qfy) + rgba[qp + 5] * qfx * (1 - qfy) + rgba[qp + mstride + 1] * (1 - qfx) * qfy + rgba[qp + mstride + 5] * qfx * qfy) * 587 +
                         (rgba[qp + 2] * (1 - qfx) * (1 - qfy) + rgba[qp + 6] * qfx * (1 - qfy) + rgba[qp + mstride + 2] * (1 - qfx) * qfy + rgba[qp + mstride + 6] * qfx * qfy) * 114) / 1000;
            var signed3 = wantDark3 ? (145 - qlum3) : (qlum3 - 145);
            score += Math.max(-145, Math.min(145, signed3)) * pr3[2];
            weight += pr3[2];
          }
        }
        return valid ? (weight ? score / weight : -1e9) : -1e9;
      }
      // 预测误差按模块计；±6 模块覆盖单边斜拍和初始平行四边形外推误差。
      for (var iu = -6; iu <= 6; iu++) for (var iv = -6; iv <= 6; iv++) {
        var cx2 = p0m[0] + iu * modFull * ux + iv * modFull * vx;
        var cy2 = p0m[1] + iu * modFull * uy + iv * modFull * vy;
        var score2 = markerPatternScore(cx2, cy2), markDist2 = Math.hypot(iu, iv);
        // 采用连续对比度评分，并在同分时靠近预测点；不再依赖单点黑白阈值和循环顺序。
        if (score2 > bestMarkScore || (score2 === bestMarkScore && markDist2 < bestMarkDist)) {
          bestMarkScore = score2; bestMarkDist = markDist2; markC = [cx2, cy2];
        }
      }
      // 平均对比度至少 48/145；否则不能把其它结构接管为 BR。
      if (bestMarkScore < 48) markC = null;
      if (markC) {
        // 粗搜索只按整模块移动，中心仍可能偏 0.5 模块；在局部 u/v 轴内做
        // 1/4 模块亚像素细化，避免透视下四点 H 被最后一个标记量化误差拉歪。
        var coarseMark = markC, fineMark = markC, fineScore = -1e9, fineDist = 1e9;
        for (var fu = -0.75; fu <= 0.7501; fu += 0.25) for (var fv = -0.75; fv <= 0.7501; fv += 0.25) {
          var fcx = coarseMark[0] + fu * modFull * ux + fv * modFull * vx;
          var fcy = coarseMark[1] + fu * modFull * uy + fv * modFull * vy;
          var fs = markerPatternScore(fcx, fcy), fd2 = fu * fu + fv * fv;
          if (fs > fineScore || (fs === fineScore && fd2 < fineDist)) {
            fineScore = fs; fineDist = fd2; fineMark = [fcx, fcy];
          }
        }
        markC = fineMark;
        bestMarkScore = fineScore;
        var H2 = solveHomography([symTL, symTR, symBL, [IMG2 - 52, IMG2 - 52]], [imgTL, imgTR, imgBL, markC]);
        if (H2) H = H2;
      }
      setInfo({ markerUsed: !!markC, markerScore: Math.max(0, bestMarkScore), markerDistance: bestMarkDist });
      if (typeof self !== "undefined" && self.__CIMQR_DEBUG__) self.__CIMQR_DEBUG__({ phase: 'br', refined: !!markC, score: bestMarkScore, mark: markC, pred: p0m });
    } catch (e) {}
    var tScore = timingScore(rgba, w, h, H, IMG2);
    var frameGlareRate = normalized.glareRate == null ? null : +normalized.glareRate.toFixed(5);
    setInfo({ timingScore: +tScore.toFixed(3), stage: 'single-code-sampling', samplingPoints: 0, localIllumRange: localWB ? [localWBW, localWBH] : null, glareRate: frameGlareRate, wbGain: wbGain.slice(), hueOffsets: hueOffsets.slice() });
    if (typeof self !== "undefined" && self.__CIMQR_DEBUG__) self.__CIMQR_DEBUG__({ phase: 'h', SCALE: SCALE, tl: [tl.x, tl.y], tr: [tr.x, tr.y], bl: [bl.x, bl.y], h: H.h, timingScore: tScore, sample0: H.map(71.5, 8.5) });

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
    setInfo({ samplingPoints: Number(SZ.cells * nsq) });
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
    // 图形与颜色分离采样：即使失焦/反光使色度下降，亮度仍可保留 8×8 图形位；
    // 颜色随后仅在图形亮点上独立投票，避免“颜色阈值失效”连带抹掉形状信息。
    var sR = new Float64Array(nsq), sG = new Float64Array(nsq), sB = new Float64Array(nsq), sC = new Float64Array(nsq), sL = new Float64Array(nsq);
    var shapeSum = 0, colorSum = 0, metricN = 0, lowShape = 0, lowColor = 0;
    for (i = 0; i < SZ.cells; i++) {
      var gridIdx = gpos[i];
      var cc = gridIdx % SZ.grid, cr = (gridIdx / SZ.grid) | 0;
      var ox = OFFSET + cc * PITCH, oy = OFFSET + cr * PITCH;
      var p0m = H.map(ox, oy), p8x = H.map(ox + 8, oy), p8y = H.map(ox, oy + 8);
      var Rcx = Math.hypot(p8x[0] - p0m[0], p8x[1] - p0m[1]) / 8;
      var Rcy = Math.hypot(p8y[0] - p0m[0], p8y[1] - p0m[1]) / 8;
      // 轴向/缩放帧继续使用原有相位模板，保证非整数倍率的像素取整兼容；
      // 旋转或透视帧改用 canonical 模板，避免把图像 x/y 当成符号轴。
      var needsCanonicalTpl = rMode === 3 ||
        Math.abs(H.h[1]) + Math.abs(H.h[3]) > 0.015 ||
        Math.abs(H.h[6]) + Math.abs(H.h[7]) > 1e-7;
      var PT = needsCanonicalTpl
        ? getLegacyTpl(NSP, INNER, cellPx < 5.5, (cr & 1) * 2 + (cc & 1))
        : framePair(
            frameSeqId(p0m[0], Rcx, (p8y[0] - p0m[0]) / 8, ox, 0),
            frameSeqId(p0m[1], Rcy, (p8x[1] - p0m[1]) / 8, oy, 1));
      var patHi = 0, patLo = 0, bad = false, cnt = 0;
      colVotes[0] = colVotes[1] = colVotes[2] = colVotes[3] = 0;
      if (soft && rMode === 4) {
        // —— 密集软判决末级候选：每个 8×8 图样像素取面积样本，再与完整模板逐像素比较 ——
        // 这条路径故意比首层慢，但不会把一个格先压成少量二值点；局部反光、AWB
        // 或一次重采样只会降低该格证据权重，不会直接伪造整幅图样。
        var dense = decodeDenseCell(rgba, w, h, H, ox, oy, normalized, stride);
        if (!dense || dense.unknown) {
          vals[i] = 255;
          if (dense) { shapeSum += dense.shapeMargin || 0; colorSum += dense.colorMargin || 0; }
          continue;
        }
        vals[i] = dense.value;
        shapeSum += dense.shapeMargin || 0;
        colorSum += dense.colorMargin || 0;
        metricN++;
        if ((dense.shapeMargin || 0) < 0.035) lowShape++;
        if ((dense.colorMargin || 0) < 0.08) lowColor++;
        continue;
      }
      {
        // 生产软路径保留已验证的 2×2/6×6 联合判决；密集逐像素路径仅在
        // 末级 rMode=4 尝试，避免未经实拍验证的模型降低正常帧通过率。
        // —— 软判决：局部亮度形状 + 色度颜色联合打分 ——
        // 每采样点做 2×2 邻域平均；亮度用于 8×8 图案，色度/色相只用于颜色。
        var maxCh = 0;
        for (var q = 0; q < nsq; q++) {
          var mx2 = ox + px[q], my2 = oy + py[q];
          var wden = h6 * mx2 + h7 * my2 + 1;
          var pqx = (h0 * mx2 + h1 * my2 + h2) / wden, pqy = (h3 * mx2 + h4 * my2 + h5) / wden;
          var rq = 0, gq = 0, bq = 0, nv = 0, cleanQ = 0;
          for (var dy2 = -1; dy2 <= 1; dy2 += 2)
            for (var dx2 = -1; dx2 <= 1; dx2 += 2) {
              var xq = Math.floor(pqx + dx2 * 0.5), yq = Math.floor(pqy + dy2 * 0.5);
              if (xq < 0 || yq < 0 || xq >= w || yq >= h) continue;
              nv++;
              var oq = yq * stride + xq * 4, gainQ = localGainAt(w, h, xq, yq);
              rq += rgba[oq] * gainQ[0]; gq += rgba[oq + 1] * gainQ[1]; bq += rgba[oq + 2] * gainQ[2]; cleanQ++;
            }
          if (!nv) { bad = true; break; }
          if (!cleanQ) { cleanQ = nv; }
          rq /= cleanQ; gq /= cleanQ; bq /= cleanQ;
          var mxq = rq > gq ? (rq > bq ? rq : bq) : (gq > bq ? gq : bq);
          var mnq = rq < gq ? (rq < bq ? rq : bq) : (gq < bq ? gq : bq);
          var chq = mxq - mnq, lumq = rq * 0.299 + gq * 0.587 + bq * 0.114;
          sR[q] = rq; sG[q] = gq; sB[q] = bq; sC[q] = chq; sL[q] = lumq;
          if (chq > maxCh) maxCh = chq;
        }
        var minLSoft = 1e9, maxLSoft = -1;
        for (q = 0; q < nsq; q++) { if (sL[q] < minLSoft) minLSoft = sL[q]; if (sL[q] > maxLSoft) maxLSoft = sL[q]; }
        var lumaRangeSoft = maxLSoft - minLSoft;
        if (bad || lumaRangeSoft < 10 || maxCh < 1) { vals[i] = 255; continue; }
        var lfSum = 0;
        for (q = 0; q < nsq; q++) { sL[q] = (sL[q] - minLSoft) / lumaRangeSoft; lfSum += sL[q]; }
        var bestSym2 = 0, bestD2 = Infinity;
        for (var s3 = 0; s3 < 16; s3++) {
          var L = PT.softLit[s3];
          var dotv = 0;
          for (q = 0; q < nsq; q++) {
            var pos = nsq - 1 - q;
            var lit = pos >= 32 ? (L[0] >>> (pos - 32)) & 1 : (L[1] >>> pos) & 1;
            if (lit) dotv += sL[q];
          }
          var d3 = L[2] - 2 * dotv + lfSum; // Σ|relative-luma - pattern|
          if (d3 < bestD2) { bestD2 = d3; bestSym2 = s3; }
        }
        if (bestD2 > nsq * 0.45) { vals[i] = 255; continue; } // 形状无法辨认 → RS
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
          // 形状参与判色：模板点亮位权重 1，背景位保留 0.2 作为反射/错位兜底；
          // 不把颜色阈值当成唯一依据，8×8 图形和色相共同决定该格颜色。
          var posShape = nsq - 1 - q;
          var litShape = posShape >= 32 ? (PT.softLit[bestSym2][0] >>> (posShape - 32)) & 1 : (PT.softLit[bestSym2][1] >>> posShape) & 1;
          var shapeWeight = litShape ? 1 : 0.2;
          if (ci2 >= 0) colVotes[ci2] += sC[q] * shapeWeight;
          else if (ch2 >= 40) colVotes[hueNearest(hue2)] += sC[q] * 0.4 * shapeWeight;
        }
        for (var cl2 = 1; cl2 < 4; cl2++) if (colVotes[cl2] > colVotes[cmax]) cmax = cl2;
        if (colVotes[cmax] < 0.01) { vals[i] = 255; continue; }
        vals[i] = (cmax << SYMBOL_BITS) | bestSym2;
        continue;
      }
      // 先采集亮度/颜色，再分离判决：亮度决定 8×8 图形位，色相只决定颜色位。
      // 这样失焦造成色度下降时不会连带把图形位抹成 0；颜色证据不足的格仍置未知。
      var sampleL = new Float64Array(nsq), sampleR = new Float64Array(nsq), sampleG = new Float64Array(nsq), sampleB = new Float64Array(nsq), maxL = 0;
      for (var sp = 0; sp < nsq; sp++) {
        var mx2 = ox + px[sp], my2 = oy + py[sp];
        var wden = h6 * mx2 + h7 * my2 + 1;
        var sx2 = (h0 * mx2 + h1 * my2 + h2) / wden, sy2 = (h3 * mx2 + h4 * my2 + h5) / wden;
        var xi = Math.floor(sx2), yi = Math.floor(sy2);
        if (xi < 0 || yi < 0 || xi >= w || yi >= h) { bad = true; break; }
        var oi = yi * stride + xi * 4, gainI = localGainAt(w, h, xi, yi);
        var r = rgba[oi] * gainI[0], g = rgba[oi + 1] * gainI[1], b = rgba[oi + 2] * gainI[2];
        var lumI = r * 0.299 + g * 0.587 + b * 0.114;
        sampleR[sp] = r; sampleG[sp] = g; sampleB[sp] = b; sampleL[sp] = lumI;
        if (lumI > maxL) maxL = lumI;
      }
      var minL = 1e9;
      for (sp = 0; sp < nsq; sp++) if (sampleL[sp] < minL) minL = sampleL[sp];
      var lumaRange = maxL - minL;
      if (bad || maxL < 24 || lumaRange < 10) { vals[i] = 255; continue; }
      // 用格内相对亮度而非全局黑点：加性环境偏色会抬高黑底 RGB，
      // 但不会抬高同一格内前景与背景的相对差；颜色位仍独立由色相投票。
      var lumaThr = minL + Math.max(8, lumaRange * 0.24);
      for (sp = 0; sp < nsq; sp++) {
        var rI = sampleR[sp], gI = sampleG[sp], bI = sampleB[sp], chromaI = Math.max(rI, gI, bI) - Math.min(rI, gI, bI);
        var bitI = sampleL[sp] >= lumaThr ? 1 : 0;
        var cIdxI = -1;
        if (bitI && chromaI >= 16) {
          var hueI;
          if (Math.max(rI, gI, bI) === rI) hueI = ((gI - bI) / chromaI) * 60;
          else if (Math.max(rI, gI, bI) === gI) hueI = 120 + ((bI - rI) / chromaI) * 60;
          else hueI = 240 + ((rI - gI) / chromaI) * 60;
          if (hueI < 0) hueI += 360;
          cIdxI = hueClassify(hueI, 16);
          if (cIdxI >= 0) colVotes[cIdxI]++;
        }
        if (cIdxI >= 0) cnt++;
        patHi = (patHi << 1) | ((patLo >>> 31) & 1);
        patLo = ((patLo << 1) | bitI) >>> 0;
      }
      if (bad || cnt < Math.max(2, nsq * 0.08)) { vals[i] = 255; continue; }
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
    var stream = new Uint8Array(SZ.stream);
    var bw = new BitWriter();
    var failCount = 0;
    for (i = 0; i < SZ.cells; i++) {
      var val = vals[gperm[i]];
      if (val === 255) failCount++;
      bw.write(val === 255 ? 0 : val, BITS_PER_CELL);
    }
    setInfo({ unknownCells: failCount,
      shapeMargin: metricN ? +(shapeSum / metricN).toFixed(4) : null,
      colorMargin: metricN ? +(colorSum / metricN).toFixed(4) : null,
      lowShapeCells: lowShape, lowColorCells: lowColor,
      meanChroma: null });
    if (typeof self !== "undefined" && self.__CIMQR_DEBUG__) self.__CIMQR_DEBUG__({ phase: 'cells', fail: failCount, total: SZ.cells, shapeMargin: metricN ? shapeSum / metricN : null, colorMargin: metricN ? colorSum / metricN : null });
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
    if (anyFail) { setInfo({ stage: 'cell-parse-failed' }); cands = dropTriple(cands, sel); continue; }
    // 解析帧头（格式字节必须与标记码档位一致 → 双保险）
    var plen = rsOut[0] | (rsOut[1] << 8);
    if (plen > SZ.packet || plen < 12) { cands = dropTriple(cands, sel); continue; }
    if (rsOut[2] !== MAGIC[0] || rsOut[3] !== MAGIC[1] || rsOut[4] !== sIdx + 1) { cands = dropTriple(cands, sel); continue; }
    var packet = new Uint8Array(plen);
    packet.set(rsOut.subarray(9, 9 + plen), 0);
    packets.push(packet);
    setInfo({ stage: 'single-code-ok', symbols: packets.length, symbolsPerFrame: packets.length, grid: SZ.grid, symbolSize: SZ.total, informationDensity: SZ.packet, formatByte: sIdx + 1 });
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
  function decodeFromH(rgba, w, h, H, INNER, soft, sIdx, rMode) {
    var normalized = getNormalizedFrame(rgba, w, h);
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
    setInfo({ samplingPoints: Number(SZ.cells * nsq) });
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
    // 图形与颜色分离采样：即使失焦/反光使色度下降，亮度仍可保留 8×8 图形位；
    // 颜色随后仅在图形亮点上独立投票，避免“颜色阈值失效”连带抹掉形状信息。
    var sR = new Float64Array(nsq), sG = new Float64Array(nsq), sB = new Float64Array(nsq), sC = new Float64Array(nsq), sL = new Float64Array(nsq);
    var shapeSum = 0, colorSum = 0, metricN = 0, lowShape = 0, lowColor = 0;
    for (i = 0; i < SZ.cells; i++) {
      var gridIdx = gpos[i];
      var cc = gridIdx % SZ.grid, cr = (gridIdx / SZ.grid) | 0;
      var ox = OFFSET + cc * PITCH, oy = OFFSET + cr * PITCH;
      var p0m = H.map(ox, oy), p8x = H.map(ox + 8, oy), p8y = H.map(ox, oy + 8);
      var Rcx = Math.hypot(p8x[0] - p0m[0], p8x[1] - p0m[1]) / 8;
      var Rcy = Math.hypot(p8y[0] - p0m[0], p8y[1] - p0m[1]) / 8;
      // 轴向/缩放帧继续使用原有相位模板，保证非整数倍率的像素取整兼容；
      // 旋转或透视帧改用 canonical 模板，避免把图像 x/y 当成符号轴。
      var needsCanonicalTpl = rMode === 3 ||
        Math.abs(H.h[1]) + Math.abs(H.h[3]) > 0.015 ||
        Math.abs(H.h[6]) + Math.abs(H.h[7]) > 1e-7;
      var PT = needsCanonicalTpl
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
          var rq = 0, gq = 0, bq = 0, nv = 0, cleanQ = 0;
          for (var dy2 = -1; dy2 <= 1; dy2 += 2)
            for (var dx2 = -1; dx2 <= 1; dx2 += 2) {
              var xq = Math.floor(pqx + dx2 * 0.5), yq = Math.floor(pqy + dy2 * 0.5);
              if (xq < 0 || yq < 0 || xq >= w || yq >= h) continue;
              nv++;
              var oq = yq * stride + xq * 4, gainQ = localGainAt(w, h, xq, yq);
              rq += rgba[oq] * gainQ[0]; gq += rgba[oq + 1] * gainQ[1]; bq += rgba[oq + 2] * gainQ[2]; cleanQ++;
            }
          if (!nv) { bad = true; break; }
          if (!cleanQ) { cleanQ = nv; }
          rq /= cleanQ; gq /= cleanQ; bq /= cleanQ;
          var mxq = rq > gq ? (rq > bq ? rq : bq) : (gq > bq ? gq : bq);
          var mnq = rq < gq ? (rq < bq ? rq : bq) : (gq < bq ? gq : bq);
          var chq = mxq - mnq, lumq = rq * 0.299 + gq * 0.587 + bq * 0.114;
          sR[q] = rq; sG[q] = gq; sB[q] = bq; sC[q] = chq; sL[q] = lumq;
          if (chq > maxCh) maxCh = chq;
        }
        var minLSoft = 1e9, maxLSoft = -1;
        for (q = 0; q < nsq; q++) { if (sL[q] < minLSoft) minLSoft = sL[q]; if (sL[q] > maxLSoft) maxLSoft = sL[q]; }
        var lumaRangeSoft = maxLSoft - minLSoft;
        if (bad || lumaRangeSoft < 10) { vals[i] = 255; continue; }
        var lfSum = 0;
        for (q = 0; q < nsq; q++) { sL[q] = (sL[q] - minLSoft) / lumaRangeSoft; lfSum += sL[q]; }
        var bestSym2 = 0, bestD2 = Infinity;
        for (var s3 = 0; s3 < 16; s3++) {
          var L = PT.softLit[s3];
          var dotv = 0;
          for (q = 0; q < nsq; q++) {
            var pos = nsq - 1 - q;
            var lit = pos >= 32 ? (L[0] >>> (pos - 32)) & 1 : (L[1] >>> pos) & 1;
            if (lit) dotv += sL[q];
          }
          var d3 = L[2] - 2 * dotv + lfSum;
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
          // 形状参与判色：模板点亮位权重 1，背景位保留 0.2 作为反射/错位兜底；
          // 不把颜色阈值当成唯一依据，8×8 图形和色相共同决定该格颜色。
          var posShape = nsq - 1 - q;
          var litShape = posShape >= 32 ? (PT.softLit[bestSym2][0] >>> (posShape - 32)) & 1 : (PT.softLit[bestSym2][1] >>> posShape) & 1;
          var shapeWeight = litShape ? 1 : 0.2;
          if (ci2 >= 0) colVotes[ci2] += sC[q] * shapeWeight;
          else if (ch2 >= 40) colVotes[hueNearest(hue2)] += sC[q] * 0.4 * shapeWeight;
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
        var oi = yi * stride + xi * 4, gainI = localGainAt(w, h, xi, yi);
        var r = rgba[oi] * gainI[0], g = rgba[oi + 1] * gainI[1], b = rgba[oi + 2] * gainI[2];
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
    [2048, 7.5, false, false, 3],
    // 逐像素 8×8 图样补救：仅在既有硬/软/平行四边形尝试全部失败后启用。
    // 首层零额外开销；本层用 64 个 canonical 像素×4 邻域面积证据，按图案/颜色 margin
    // 联合裁决，专门处理实拍中少量格被反光或相位污染的情况。
    [512, 4.5, true, true, 4],
    [768, 4.5, true, true, 4],
    [2048, 4.5, true, true, 4]
  ];
  function decodeFrame(rgba, w, h) {
    detToken++;
    setInfo({ stage: 'sampling', candidates: 0, symbols: 0, symbolsPerFrame: 0, attemptIndex: -1, attemptsTried: 0, source: 'full' });
    // 白平衡色相校正（真实相机 AWB 偏暖/偏冷会平移色相；黑白 QR 帧不会走到这里）
    estimateWBGain(rgba, w, h);
    estimateLocalWB(rgba, w, h);
    hueOffsets = estimateHueOffsets(rgba, w, h);
    if (normalizedFrame && normalizedFrame.rawRGBA === rgba) {
      normalizedFrame.localWB = localWB;
      normalizedFrame.wbGain = wbGain.slice();
      normalizedFrame.hueOffsets = hueOffsets.slice();
    }
    // 帧间复用：相邻帧画面几乎不变（相机静止/微抖），直接沿用上次成功单应采样
    if (_lastH) {
      var fast;
      setInfo({ source: 'tracking', attemptIndex: 0, attemptsTried: 1 });
      try { fast = decodeFromH(rgba, w, h, _lastH, 6, true, _lastSizeIdx, 0); } catch (e) { fast = []; }
      if (fast && fast.length) { setInfo({ stage: 'single-code-ok', symbols: fast.length, symbolsPerFrame: fast.length }); return fast; }
      // 复用失败（画面变化/切包）：继续完整检测，_lastH 会被新成功帧刷新
    }
    for (var a = 0; a < ATTEMPTS.length; a++) {
      setInfo({ attemptIndex: a, attemptsTried: a + 1, source: 'full' });
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
        // 门控必须是纯当前帧函数：decodeFrame 尚未估计本帧 wbGain，不能依赖上一帧状态。
        var r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
        var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        // 预检只回答“是否存在彩色信号”，不能因暗曝光/局部反光把彩色帧误当黑白；
        // 结构解码会再用色度、图形模板和 RS 严格裁决。
        if (mx - mn > 30 && mx > 38) hits++;
      }
    }
    return hits >= 12;
  }

  function releaseFrame() {
    // 仅释放当前帧的全分辨率标准化视图；tracking 只保留小型 H，不保留相机像素。
    normalizedFrame = null;
  }

  return {
    CELL: CELL, PITCH: PITCH, OFFSET: OFFSET, GRID: GRID, IMG: IMG,
    DATA_CELLS: DATA_CELLS, MAX_PACKET: MAX_PACKET,
    SIZES: SIZES, // 尺寸阶梯：{grid,img,total,cells,stream,blocks,packet}（idx 0=112）
    maybeColor: maybeColor,
    enhance: enhanceImageData,
    releaseFrame: releaseFrame,
    render: renderFrame,
    decode: decodeFrame, _decodeAttempt: decodeAttempt,
    info: function () { var o = {}; for (var k in lastInfo) o[k] = lastInfo[k]; return o; },
    readSizeMark: readSizeMark,
    _hueOffset: function(){ return hueOffsets.slice(); },
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
class $r{__destroy_into_raw(){const o=this.__wbg_ptr;return this.__wbg_ptr=0,At.unregister(this),o}free(){const o=this.__destroy_into_raw();v.__wbg_qrrenderer_free(o,0)}buf_len(){return v.qrrenderer_buf_len(this.__wbg_ptr)>>>0}buf_ptr(){return v.qrrenderer_buf_ptr(this.__wbg_ptr)>>>0}last_matrix_size(){return v.qrrenderer_last_matrix_size(this.__wbg_ptr)>>>0}matrix_len(){return v.qrrenderer_matrix_len(this.__wbg_ptr)>>>0}matrix_ptr(){return v.qrrenderer_matrix_ptr(this.__wbg_ptr)>>>0}constructor(){const o=v.qrrenderer_new();return this.__wbg_ptr=o,At.register(this,this.__wbg_ptr,this),this}render(o,d,p,u){try{const y=v.__wbindgen_add_to_stack_pointer(-16),x=Nr(o,v.__wbindgen_export),I=Wr;v.qrrenderer_render(y,this.__wbg_ptr,x,I,d,p,u);var g=H().getInt32(y+0,!0),w=H().getInt32(y+4,!0),R=H().getInt32(y+8,!0);if(R)throw Lr(w);return g>>>0}finally{v.__wbindgen_add_to_stack_pointer(16)}}render_matrix(o,d,p){try{const R=v.__wbindgen_add_to_stack_pointer(-16),y=Nr(o,v.__wbindgen_export),x=Wr;v.qrrenderer_render_matrix(R,this.__wbg_ptr,y,x,d,p);var u=H().getInt32(R+0,!0),g=H().getInt32(R+4,!0),w=H().getInt32(R+8,!0);if(w)throw Lr(g);return u>>>0}finally{v.__wbindgen_add_to_stack_pointer(16)}}render_rgba(o,d,p,u){try{const y=v.__wbindgen_add_to_stack_pointer(-16),x=Nr(o,v.__wbindgen_export),I=Wr;v.qrrenderer_render_rgba(y,this.__wbg_ptr,x,I,d,p,u);var g=H().getInt32(y+0,!0),w=H().getInt32(y+4,!0),R=H().getInt32(y+8,!0);if(R)throw Lr(w);return g>>>0}finally{v.__wbindgen_add_to_stack_pointer(16)}}rgba_len(){return v.qrrenderer_rgba_len(this.__wbg_ptr)>>>0}rgba_ptr(){return v.qrrenderer_rgba_ptr(this.__wbg_ptr)>>>0}}Symbol.dispose&&($r.prototype[Symbol.dispose]=$r.prototype.free);function kn(){return{__proto__:null,"./raptorqr_fast_qr_wasm_bg.js":{__proto__:null,__wbg___wbindgen_throw_344f42d3211c4765:function(o,d){throw new Error(Rt(o,d))},__wbindgen_cast_0000000000000001:function(o,d){const p=Rt(o,d);return jn(p)}}}}const At=typeof FinalizationRegistry>"u"?{register:()=>{},unregister:()=>{}}:new FinalizationRegistry(a=>v.__wbg_qrrenderer_free(a,1));function jn(a){dr===V.length&&V.push(V.length+1);const o=dr;return dr=V[o],V[o]=a,o}function Nn(a){a<1028||(V[a]=dr,dr=a)}let er=null;function H(){return(er===null||er.buffer.detached===!0||er.buffer.detached===void 0&&er.buffer!==v.memory.buffer)&&(er=new DataView(v.memory.buffer)),er}function Rt(a,o){return Vn(a>>>0,o)}let fr=null;function Tt(){return(fr===null||fr.byteLength===0)&&(fr=new Uint8Array(v.memory.buffer)),fr}function Ln(a){return V[a]}let V=new Array(1024).fill(void 0);V.push(void 0,null,!0,!1);let dr=V.length;function Nr(a,o){const d=o(a.length*1,1)>>>0;return Tt().set(a,d/1),Wr=a.length,d}function Lr(a){const o=Ln(a);return Nn(a),o}let Dr=new TextDecoder("utf-8",{ignoreBOM:!0,fatal:!0});Dr.decode();const Hn=2146435072;let Hr=0;function Vn(a,o){return Hr+=o,Hr>=Hn&&(Dr=new TextDecoder("utf-8",{ignoreBOM:!0,fatal:!0}),Dr.decode(),Hr=o),Dr.decode(Tt().subarray(a,a+o))}let Wr=0,v;function Gn(a,o){return v=a.exports,er=null,fr=null,v}async function Zn(a,o){if(typeof Response=="function"&&a instanceof Response){if(typeof WebAssembly.instantiateStreaming=="function")try{return await WebAssembly.instantiateStreaming(a,o)}catch(u){if(a.ok&&d(a.type)&&a.headers.get("Content-Type")!=="application/wasm")console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n",u);else throw u}const p=await a.arrayBuffer();return await WebAssembly.instantiate(p,o)}else{const p=await WebAssembly.instantiate(a,o);return p instanceof WebAssembly.Instance?{instance:p,module:a}:p}function d(p){switch(p){case"basic":case"cors":case"default":return!0}return!1}}async function Xn(a){if(v!==void 0)return v;a!==void 0&&(Object.getPrototypeOf(a)===Object.prototype?{module_or_path:a}=a:console.warn("using deprecated parameters for the initialization function; pass a single object instead")),a===void 0&&(a=new URL(""+new URL(__RQR_WASM_URL("raptorqr_fast_qr_wasm_bg-DEFhihBP.wasm"),import.meta.url).href,import.meta.url));const o=kn();(typeof a=="string"||typeof Request=="function"&&a instanceof Request||typeof URL=="function"&&a instanceof URL)&&(a=fetch(a));const{instance:d,module:p}=await Zn(await a,o);return Gn(d)}let Ir=null,Sr=null;function Zr(){return"fast_qr WASM artifacts are not installed. Run packages/raptorqr-fast-qr-wasm/src/build_fast_qr_wasm_colab.py in Google Colab, then copy the generated files into packages/raptorqr-fast-qr-wasm/src/wasm."}async function Et(){Ir||(Ir=Promise.resolve(Xn()).then(a=>{Sr=a}).catch(a=>{throw Ir=null,a instanceof Error?a:new Error(String(a))})),await Ir}function xt(){return Sr!==null}function It(){if(!Sr)throw new Error("fast_qr WASM not initialized — call ensureFastQrWasm() first.");return Sr.memory}var O=[["All","*","*","     ",0,"All"],["AllReadable","*","r","     ",0,"All Readable"],["AllCreatable","*","w","     ",0,"All Creatable"],["AllLinear","*","l","     ",0,"All Linear"],["AllMatrix","*","m","     ",0,"All Matrix"],["AllGS1","*","G","     ",0,"All GS1"],["AllRetail","*","R","     ",0,"All Retail"],["AllIndustrial","*","I","     ",0,"All Industrial"],["Codabar","F"," ","lrw  ",18,"Codabar"],["Code39","A"," ","lrw I",8,"Code 39"],["Code39Std","A","s","lrw I",8,"Code 39 Standard"],["Code39Ext","A","e","lr  I",9,"Code 39 Extended"],["Code32","A","2","lr  I",129,"Code 32"],["PZN","A","p","lr  I",52,"Pharmazentralnummer"],["Code93","G"," ","lrw I",25,"Code 93"],["Code128","C"," ","lrwGI",20,"Code 128"],["ITF","I"," ","lrw I",3,"ITF"],["ITF14","I","4","lr  I",89,"ITF-14"],["DataBar","e"," ","lr GR",29,"DataBar"],["DataBarOmni","e","o","lr GR",29,"DataBar Omni"],["DataBarStk","e","s","lr GR",79,"DataBar Stacked"],["DataBarStkOmni","e","O","lr GR",80,"DataBar Stacked Omni"],["DataBarLtd","e","l","lr GR",30,"DataBar Limited"],["DataBarExp","e","e","lr GR",31,"DataBar Expanded"],["DataBarExpStk","e","E","lr GR",81,"DataBar Expanded Stacked"],["EANUPC","E"," ","lr  R",15,"EAN/UPC"],["EAN13","E","1","lrw R",15,"EAN-13"],["EAN8","E","8","lrw R",10,"EAN-8"],["EAN5","E","5","l   R",12,"EAN-5"],["EAN2","E","2","l   R",11,"EAN-2"],["ISBN","E","i","lr  R",69,"ISBN"],["UPCA","E","a","lrw R",34,"UPC-A"],["UPCE","E","e","lrw R",37,"UPC-E"],["Telepen","B"," ","lr  I",32,"Telepen"],["TelepenAlpha","B","0","lr  I",32,"Telepen Alpha"],["TelepenNumeric","B","1","lr  I",87,"Telepen Numeric"],["OtherBarcode","X"," "," r   ",0,"Other barcode"],["DXFilmEdge","X","x","lr   ",147,"DX Film Edge"],["PDF417","L"," ","mrw  ",55,"PDF417"],["CompactPDF417","L","c","mr   ",56,"Compact PDF417"],["MicroPDF417","L","m","mr   ",84,"MicroPDF417"],["Aztec","z"," ","mr G ",92,"Aztec"],["AztecCode","z","c","mrwG ",92,"Aztec Code"],["AztecRune","z","r","mr   ",128,"Aztec Rune"],["QRCode","Q"," ","mrwG ",58,"QR Code"],["QRCodeModel1","Q","1","mr   ",0,"QR Code Model 1"],["QRCodeModel2","Q","2","mr   ",58,"QR Code Model 2"],["MicroQRCode","Q","m","mr   ",97,"Micro QR Code"],["RMQRCode","Q","r","mr G ",145,"rMQR Code"],["DataMatrix","d"," ","mrwG ",71,"Data Matrix"],["MaxiCode","U"," ","mr   ",57,"MaxiCode"]],Yn={DataBarExpanded:"DataBarExp",DataBarLimited:"DataBarLtd","Linear-Codes":"AllLinear","Matrix-Codes":"AllMatrix",Any:"All",rMQRCode:"RMQRCode"};O.map(a=>a[5]);O.filter(a=>a[1]==="*").map(a=>a[0]);O.filter(a=>a[1]!=="*").map(a=>a[0]);O.filter(a=>a[2]===" ").map(a=>a[0]);O.filter(a=>a[3][0]==="l").map(a=>a[0]);O.filter(a=>a[3][0]==="m").map(a=>a[0]);O.filter(a=>a[3][1]==="r").map(a=>a[0]);O.filter(a=>a[3][2]==="w"||a[4]!==0).map(a=>a[0]);O.filter(a=>a[3][3]==="G").map(a=>a[0]);O.filter(a=>a[3][4]==="R").map(a=>a[0]);O.filter(a=>a[3][4]==="I").map(a=>a[0]);function Kn(a){var o;return(o=Yn[a])==null?a:o}var Jn={formats:[]};function Ct(a){var o;return{...a,image:(o=a.image&&new Blob([a.image],{type:"image/png"}))==null?null:o}}var $={format:"QRCode",readerInit:!1,forceSquareDataMatrix:!1,ecLevel:"",scale:1,sizeHint:0,rotate:0,invert:!1,withHRT:!1,withQuietZones:!0,addHRT:!1,addQuietZones:!0,options:""};function ra(a=$){var o,d;let{format:p=$.format,sizeHint:u=$.sizeHint,readerInit:g=$.readerInit,forceSquareDataMatrix:w=$.forceSquareDataMatrix,ecLevel:R=$.ecLevel,withHRT:y,withQuietZones:x,addHRT:I,addQuietZones:S,options:Q=$.options,scale:q,rotate:hr=$.rotate,invert:G=$.invert}=a,U=Q.split(",").map(Y=>Y.trim()).filter(Boolean),nr=Y=>{let gr=Y.split("=")[0];U.some(wr=>wr.split("=")[0]===gr)||U.push(Y)};g&&nr("readerInit"),w&&nr("forceSquare"),R&&nr(`ecLevel=${R}`);let pr=q??(u>0?-Math.trunc(Math.abs(u)):$.scale);return{format:Kn(p),options:U.join(","),scale:pr,rotate:hr,invert:G,addHRT:(o=I??y)==null?$.addHRT:o,addQuietZones:(d=S??x)==null?$.addQuietZones:d}}var ta={locateFile:(a,o)=>{let d=a.match(/_(.+?)\.wasm$/);return d?`https://fastly.jsdelivr.net/npm/zxing-wasm@3.1.0/dist/${d[1]}/${a}`:o+a}},Vr=new WeakMap;function ea(a,o){return Object.is(a,o)||Object.keys(a).length===Object.keys(o).length&&Object.keys(a).every(d=>Object.hasOwn(o,d)&&a[d]===o[d])}function Mt(a,{overrides:o,equalityFn:d=ea,fireImmediately:p=!1}={}){var u,g;let[w,R]=(u=Vr.get(a))==null?[ta]:u,y=o??w,x;if(p){if(R&&(x=d(w,y)))return R;let I=a({...y});return Vr.set(a,[y,I]),I}((g=x)==null?d(w,y):g)||Vr.set(a,[y])}async function na(a,o,d=$){let p=ra(d),u=await Mt(a,{fireImmediately:!0});if(typeof o=="string")return Ct(u.writeBarcodeFromText(o,p));let{byteLength:g}=o,w=u._malloc(g);if(!w)throw Error(`Failed to allocate ${g} bytes in WASM memory`);try{return u.HEAPU8.set(o,w),Ct(u.writeBarcodeFromBytes(w,g,p))}finally{u._free(w)}}[...Jn.formats];({...$});async function Dt(a={}){var o,d,p,u=a,g=!!globalThis.window,w=typeof Bun<"u",R=!!globalThis.WorkerGlobalScope;!((d=globalThis.process)==null||(d=d.versions)==null)&&d.node&&((p=globalThis.process)==null||p.type);var y="./this.program",x,I="";function S(r){return u.locateFile?u.locateFile(r,I):I+r}var Q,q;if(g||R||w){try{I=new URL(".",x).href}catch{}R&&(q=r=>{var t=new XMLHttpRequest;return t.open("GET",r,!1),t.responseType="arraybuffer",t.send(null),new Uint8Array(t.response)}),Q=async r=>{var t=await fetch(r,{credentials:"same-origin"});if(t.ok)return t.arrayBuffer();throw Error(t.status+" : "+t.url)}}var hr=console.log.bind(console),G=console.error.bind(console),U,nr=!1,pr,Y,gr=!1;function wr(){var r=Tr.buffer;K=new Int8Array(r),yr=new Int16Array(r),u.HEAPU8=z=new Uint8Array(r),sr=new Uint16Array(r),or=new Int32Array(r),_=new Uint32Array(r),Xr=new Float32Array(r),Yr=new Float64Array(r)}function Wt(){if(u.preRun)for(typeof u.preRun=="function"&&(u.preRun=[u.preRun]);u.preRun.length;)kt(u.preRun.shift());Kr(rt)}function Ft(){gr=!0,Er.oa()}function $t(){if(u.postRun)for(typeof u.postRun=="function"&&(u.postRun=[u.postRun]);u.postRun.length;)zt(u.postRun.shift());Kr(Jr)}function Pr(r){var t,e;(t=u.onAbort)==null||t.call(u,r),r="Aborted("+r+")",G(r),nr=!0,r+=". Build with -sASSERTIONS for more info.";var n=new WebAssembly.RuntimeError(r);throw(e=Y)==null||e(n),n}var mr;function St(){return S("zxing_writer.wasm")}function Pt(r){if(r==mr&&U)return new Uint8Array(U);if(q)return q(r);throw"both async and sync fetching of the wasm failed"}async function Qt(r){if(!U)try{var t=await Q(r);return new Uint8Array(t)}catch{}return Pt(r)}async function Bt(r,t){try{var e=await Qt(r);return await WebAssembly.instantiate(e,t)}catch(n){G(`failed to asynchronously prepare wasm: ${n}`),Pr(n)}}async function Ot(r,t,e){if(!r&&WebAssembly.instantiateStreaming)try{var n=fetch(t,{credentials:"same-origin"});return await WebAssembly.instantiateStreaming(n,e)}catch(i){G(`wasm streaming compile failed: ${i}`),G("falling back to ArrayBuffer instantiation")}return Bt(t,e)}function qt(){return{a:wn}}async function Ut(){function r(n,i){return Er=n.exports,gn(Er),wr(),Er}function t(n){return r(n.instance)}var e=qt();return u.instantiateWasm?new Promise((n,i)=>{u.instantiateWasm(e,(s,l)=>{n(r(s))})}):(mr!=null||(mr=St()),t(await Ot(U,mr,e)))}var yr,or,K,Xr,Yr,sr,_,z,Kr=r=>{for(;r.length>0;)r.shift()(u)},Jr=[],zt=r=>Jr.push(r),rt=[],kt=r=>rt.push(r),C=r=>gt(r),T=()=>wt(),vr=[],_r=0,jt=r=>{var t=new Qr(r);return t.get_caught()||(t.set_caught(!0),_r--),t.set_rethrown(!1),vr.push(t),vt(r)},k=0,Nt=()=>{b(0,0);var r=vr.pop();mt(r.excPtr),k=0};class Qr{constructor(t){this.excPtr=t,this.ptr=t-24}set_type(t){_[this.ptr+4>>2]=t}get_type(){return _[this.ptr+4>>2]}set_destructor(t){_[this.ptr+8>>2]=t}get_destructor(){return _[this.ptr+8>>2]}set_caught(t){t=+!!t,K[this.ptr+12]=t}get_caught(){return K[this.ptr+12]!=0}set_rethrown(t){t=+!!t,K[this.ptr+13]=t}get_rethrown(){return K[this.ptr+13]!=0}init(t,e){this.set_adjusted_ptr(0),this.set_type(t),this.set_destructor(e)}set_adjusted_ptr(t){_[this.ptr+16>>2]=t}get_adjusted_ptr(){return _[this.ptr+16>>2]}}var br=r=>pt(r),Br=r=>{var t=k;if(!t)return br(0),0;var e=new Qr(t);e.set_adjusted_ptr(t);var n=e.get_type();if(!n)return br(0),t;for(var i of r){if(i===0||i===n)break;var s=e.ptr+16;if(yt(i,n,s))return br(i),t}return br(n),t},Lt=()=>Br([]),Ht=r=>Br([r]),Vt=(r,t)=>Br([r,t]),Gt=()=>{var r=vr.pop();r||Pr("no exception to throw");var t=r.excPtr;throw r.get_rethrown()||(vr.push(r),r.set_rethrown(!0),r.set_caught(!1),_r++),jr(t),k=t,k},Zt=(r,t,e)=>{throw new Qr(r).init(t,e),jr(r),k=r,_r++,k},Xt=()=>_r,Yt=r=>{throw k||(k=r),k},tt=globalThis.TextDecoder&&new TextDecoder,et=(r,t,e,n)=>{var i=t+e;if(n)return i;for(;r[t]&&!(t>=i);)++t;return t},nt=function(r){let t=arguments.length>1&&arguments[1]!==void 0?arguments[1]:0,e=arguments.length>2?arguments[2]:void 0,n=arguments.length>3?arguments[3]:void 0;var i=et(r,t,e,n);if(i-t>16&&r.buffer&&tt)return tt.decode(r.subarray(t,i));for(var s="";t<i;){var l=r[t++];if(!(l&128)){s+=String.fromCharCode(l);continue}var c=r[t++]&63;if((l&224)==192){s+=String.fromCharCode((l&31)<<6|c);continue}var f=r[t++]&63;if(l=(l&240)==224?(l&15)<<12|c<<6|f:(l&7)<<18|c<<12|f<<6|r[t++]&63,l<65536)s+=String.fromCharCode(l);else{var h=l-65536;s+=String.fromCharCode(55296|h>>10,56320|h&1023)}}return s},Kt=(r,t,e)=>r?nt(z,r,t,e):"";function Jt(r,t,e){return 0}function re(r,t,e){return 0}var te=(r,t,e)=>{};function ee(r,t,e,n){}var ne=(r,t)=>{},ae=()=>Pr(""),Ar={},Or=r=>{for(;r.length;){var t=r.pop();r.pop()(t)}};function Rr(r){return this.fromWireType(_[r>>2])}var ar={},J={},Cr={},ie=class extends Error{constructor(r){super(r),this.name="InternalError"}},at=r=>{throw new ie(r)},it=(r,t,e)=>{r.forEach(c=>Cr[c]=t);function n(c){var f=e(c);f.length!==r.length&&at("Mismatched type converter count");for(var h=0;h<r.length;++h)j(r[h],f[h])}var i=Array(t.length),s=[],l=0;{let c=t;for(let f=0;f<c.length;++f){let h=c[f];J.hasOwnProperty(h)?i[f]=J[h]:(s.push(h),ar.hasOwnProperty(h)||(ar[h]=[]),ar[h].push(()=>{i[f]=J[h],++l,l===s.length&&n(i)}))}}s.length===0&&n(i)},oe=r=>{var t=Ar[r];delete Ar[r];var e=t.rawConstructor,n=t.rawDestructor,i=t.fields,s=i.map(l=>l.getterReturnType).concat(i.map(l=>l.setterArgumentType));it([r],s,l=>{var c={};{let f=i;for(let h=0;h<f.length;++h){let m=f[h],E=l[h],D=m.getter,W=m.getterContext,M=l[h+i.length],F=m.setter,cr=m.setterContext;c[m.fieldName]={read:L=>E.fromWireType(D(W,L)),write:(L,X)=>{var xr=[];F(cr,L,M.toWireType(xr,X)),Or(xr)},optional:E.optional}}}return[{name:t.name,fromWireType:f=>{var h={};for(var m in c)h[m]=c[m].read(f);return n(f),h},toWireType:(f,h)=>{for(var m in c)if(!(m in h)&&!c[m].optional)throw TypeError(`Missing field: "${m}"`);var E=e();for(m in c)c[m].write(E,h[m]);return f!==null&&f.push(n,E),E},readValueFromPointer:Rr,destructorFunction:n}]})},se=(r,t,e,n,i)=>{},P=r=>{for(var t="";;){var e=z[r++];if(!e)return t;t+=String.fromCharCode(e)}},ue=class extends Error{constructor(r){super(r),this.name="BindingError"}},B=r=>{throw new ue(r)};function le(r,t){let e=arguments.length>2&&arguments[2]!==void 0?arguments[2]:{};var n=t.name;if(r||B(`type "${n}" must have a positive integer typeid pointer`),J.hasOwnProperty(r)){if(e.ignoreDuplicateRegistrations)return;B(`Cannot register type '${n}' twice`)}if(J[r]=t,delete Cr[r],ar.hasOwnProperty(r)){var i=ar[r];delete ar[r],i.forEach(s=>s())}}function j(r,t){return le(r,t,arguments.length>2&&arguments[2]!==void 0?arguments[2]:{})}var ce=(r,t,e,n)=>{t=P(t),j(r,{name:t,fromWireType:function(i){return!!i},toWireType:function(i,s){return s?e:n},readValueFromPointer:function(i){return this.fromWireType(z[i])},destructorFunction:null})},ot=[],rr=[0,1,,1,null,1,!0,1,!1,1],qr=r=>{r>9&&--rr[r+1]===0&&(rr[r]=void 0,ot.push(r))},N={toValue:r=>(r||B(`Cannot use deleted val. handle = ${r}`),rr[r]),toHandle:r=>{switch(r){case void 0:return 2;case null:return 4;case!0:return 6;case!1:return 8;default:{let t=ot.pop()||rr.length;return rr[t]=r,rr[t+1]=1,t}}}},fe={name:"emscripten::val",fromWireType:r=>{var t=N.toValue(r);return qr(r),t},toWireType:(r,t)=>N.toHandle(t),readValueFromPointer:Rr,destructorFunction:null},de=r=>j(r,fe),he=(r,t)=>{switch(t){case 4:return function(e){return this.fromWireType(Xr[e>>2])};case 8:return function(e){return this.fromWireType(Yr[e>>3])};default:throw TypeError(`invalid float width (${t}): ${r}`)}},pe=(r,t,e)=>{t=P(t),j(r,{name:t,fromWireType:n=>n,toWireType:(n,i)=>i,readValueFromPointer:he(t,e),destructorFunction:null})},st=(r,t)=>Object.defineProperty(t,"name",{value:r});function ge(r){for(var t=1;t<r.length;++t)if(r[t]!==null&&r[t].destructorFunction===void 0)return!0;return!1}function we(r,t,e,n,i,s){var l=t.length;l<2&&B("argTypes array size mismatch! Must at least get return value and 'this' types!"),t[1];var c=ge(t),f=!t[0].isVoid,h=l-2,m=Array(h),E=[],D=[];return st(r,function(){D.length=0;var W;E.length=1,E[0]=i;for(var M=0;M<h;++M)m[M]=t[M+2].toWireType(D,M<0||arguments.length<=M?void 0:arguments[M]),E.push(m[M]);var F=n(...E);function cr(L){if(c)Or(D);else for(var X=2;X<t.length;X++){var xr=X===1?W:m[X-2];t[X].destructorFunction!==null&&t[X].destructorFunction(xr)}if(f)return t[0].fromWireType(L)}return cr(F)})}var me=(r,t,e)=>{if(r[t].overloadTable===void 0){var n=r[t];r[t]=function(){var i=[...arguments];return r[t].overloadTable.hasOwnProperty(i.length)||B(`Function '${e}' called with an invalid number of arguments (${i.length}) - expects one of (${r[t].overloadTable})!`),r[t].overloadTable[i.length].apply(this,i)},r[t].overloadTable=[],r[t].overloadTable[n.argCount]=n}},ye=(r,t,e)=>{u.hasOwnProperty(r)?((e===void 0||u[r].overloadTable!==void 0&&u[r].overloadTable[e]!==void 0)&&B(`Cannot register public name '${r}' twice`),me(u,r,r),u[r].overloadTable.hasOwnProperty(e)&&B(`Cannot register multiple overloads of a function with the same number of arguments (${e})!`),u[r].overloadTable[e]=t):(u[r]=t,u[r].argCount=e)},ve=(r,t)=>{for(var e=[],n=0;n<r;n++)e.push(_[t+n*4>>2]);return e},_e=(r,t,e)=>{u.hasOwnProperty(r)||at("Replacing nonexistent public symbol"),u[r].overloadTable!==void 0&&e!==void 0?u[r].overloadTable[e]=t:(u[r]=t,u[r].argCount=e)},tr={},be=(r,t,e)=>{r=r.replace(/p/g,"i");var n=tr[r];return n(t,...e)},ut=[],A=r=>{var t=ut[r];return t||(ut[r]=t=bt.get(r)),t},Ae=function(r,t){let e=arguments.length>2&&arguments[2]!==void 0?arguments[2]:[];if(r.includes("j"))return be(r,t,e);var n=A(t)(...e);function i(s){return s}return n},Re=function(r,t){let e=arguments.length>2&&arguments[2]!==void 0?arguments[2]:!1;return function(){return Ae(r,t,[...arguments],e)}},ur=function(r,t){r=P(r);function e(){return r.includes("j")?Re(r,t):A(t)}var n=e();return typeof n!="function"&&B(`unknown function pointer with signature ${r}: ${t}`),n};class Ce extends Error{}var lt=r=>{var t=ht(r),e=P(t);return Z(t),e},Te=(r,t)=>{var e=[],n={};function i(s){if(!n[s]&&!J[s]){if(Cr[s]){Cr[s].forEach(i);return}e.push(s),n[s]=!0}}throw t.forEach(i),new Ce(`${r}: `+e.map(lt).join([", "]))},Ee=r=>{r=r.trim();let t=r.indexOf("(");return t===-1?r:r.slice(0,t)},xe=(r,t,e,n,i,s,l,c)=>{var f=ve(t,e);r=P(r),r=Ee(r),i=ur(n,i),ye(r,function(){Te(`Cannot call ${r} due to unbound types`,f)},t-1),it([],f,h=>{var m=[h[0],null].concat(h.slice(1));return _e(r,we(r,m,null,i,s),t-1),[]})},Ie=(r,t,e)=>{switch(t){case 1:return e?n=>K[n]:n=>z[n];case 2:return e?n=>yr[n>>1]:n=>sr[n>>1];case 4:return e?n=>or[n>>2]:n=>_[n>>2];default:throw TypeError(`invalid integer width (${t}): ${r}`)}},Me=(r,t,e,n,i)=>{t=P(t);let s=n===0,l=f=>f;if(s){var c=32-8*e;l=f=>f<<c>>>c,i=l(i)}j(r,{name:t,fromWireType:l,toWireType:(f,h)=>h,readValueFromPointer:Ie(t,e,n!==0),destructorFunction:null})},De=(r,t,e)=>{var n=[Int8Array,Uint8Array,Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array][t];function i(s){var l=_[s>>2],c=_[s+4>>2];return new n(K.buffer,c,l)}e=P(e),j(r,{name:e,fromWireType:i,readValueFromPointer:i},{ignoreDuplicateRegistrations:!0})},We=(r,t,e,n)=>{if(!(n>0))return 0;for(var i=e,s=e+n-1,l=0;l<r.length;++l){var c=r.codePointAt(l);if(c<=127){if(e>=s)break;t[e++]=c}else if(c<=2047){if(e+1>=s)break;t[e++]=192|c>>6,t[e++]=128|c&63}else if(c<=65535){if(e+2>=s)break;t[e++]=224|c>>12,t[e++]=128|c>>6&63,t[e++]=128|c&63}else{if(e+3>=s)break;t[e++]=240|c>>18,t[e++]=128|c>>12&63,t[e++]=128|c>>6&63,t[e++]=128|c&63,l++}}return t[e]=0,e-i},ir=(r,t,e)=>We(r,z,t,e),ct=r=>{for(var t=0,e=0;e<r.length;++e){var n=r.charCodeAt(e);n<=127?t++:n<=2047?t+=2:n>=55296&&n<=57343?(t+=4,++e):t+=3}return t},Fe=(r,t)=>{t=P(t),j(r,{name:t,fromWireType(e){var n=_[e>>2],i=e+4,s;return s=Kt(i,n,!0),Z(e),s},toWireType(e,n){n instanceof ArrayBuffer&&(n=new Uint8Array(n));var i,s=typeof n=="string";s||ArrayBuffer.isView(n)&&n.BYTES_PER_ELEMENT==1||B("Cannot pass non-string to std::string"),i=s?ct(n):n.length;var l=kr(4+i+1),c=l+4;return _[l>>2]=i,s?ir(n,c,i+1):z.set(n,c),e!==null&&e.push(Z,l),l},readValueFromPointer:Rr,destructorFunction(e){Z(e)}})},ft=globalThis.TextDecoder?new TextDecoder("utf-16le"):void 0,$e=(r,t,e)=>{var n=r>>1,i=et(sr,n,t/2,e);if(i-n>16&&ft)return ft.decode(sr.subarray(n,i));for(var s="",l=n;l<i;++l){var c=sr[l];s+=String.fromCharCode(c)}return s},Se=(r,t,e)=>{if(e!=null||(e=2147483647),e<2)return 0;e-=2;for(var n=t,i=e<r.length*2?e/2:r.length,s=0;s<i;++s){var l=r.charCodeAt(s);yr[t>>1]=l,t+=2}return yr[t>>1]=0,t-n},Pe=r=>r.length*2,Qe=(r,t,e)=>{for(var n="",i=r>>2,s=0;!(s>=t/4);s++){var l=_[i+s];if(!l&&!e)break;n+=String.fromCodePoint(l)}return n},Be=(r,t,e)=>{if(e!=null||(e=2147483647),e<4)return 0;for(var n=t,i=n+e-4,s=0;s<r.length;++s){var l=r.codePointAt(s);if(l>65535&&s++,or[t>>2]=l,t+=4,t+4>i)break}return or[t>>2]=0,t-n},Oe=r=>{for(var t=0,e=0;e<r.length;++e)r.codePointAt(e)>65535&&e++,t+=4;return t},qe=(r,t,e)=>{e=P(e);var n,i,s;t===2?(n=$e,i=Se,s=Pe):(n=Qe,i=Be,s=Oe),j(r,{name:e,fromWireType:l=>{var c=_[l>>2],f=n(l+4,c*t,!0);return Z(l),f},toWireType:(l,c)=>{typeof c!="string"&&B(`Cannot pass non-string to C++ string type ${e}`);var f=s(c),h=kr(4+f+t);return _[h>>2]=f/t,i(c,h+4,f+t),l!==null&&l.push(Z,h),h},readValueFromPointer:Rr,destructorFunction(l){Z(l)}})},Ue=(r,t,e,n,i,s)=>{Ar[r]={name:P(t),rawConstructor:ur(e,n),rawDestructor:ur(i,s),fields:[]}},ze=(r,t,e,n,i,s,l,c,f,h)=>{Ar[r].fields.push({fieldName:P(t),getterReturnType:e,getter:ur(n,i),getterContext:s,setterArgumentType:l,setter:ur(c,f),setterContext:h})},ke=(r,t)=>{t=P(t),j(r,{isVoid:!0,name:t,fromWireType:()=>{},toWireType:(e,n)=>{}})},Ur=[],je=r=>{var t=Ur.length;return Ur.push(r),t},Ne=(r,t)=>{var e=J[r];return e===void 0&&B(`${t} has unknown type ${lt(r)}`),e},Le=(r,t)=>{for(var e=Array(r),n=0;n<r;++n)e[n]=Ne(_[t+n*4>>2],`parameter ${n}`);return e},He=(r,t,e)=>{var n=[],i=r(n,e);return n.length&&(_[t>>2]=N.toHandle(n)),i},Ve={},dt=r=>{var t=Ve[r];return t===void 0?P(r):t},Ge=(r,t,e)=>{var n=8,[i,...s]=Le(r,t),l=i.toWireType.bind(i),c=s.map(h=>h.readValueFromPointer.bind(h));r--;var f=Array(r);return je(st(`methodCaller<(${s.map(h=>h.name)}) => ${i.name}>`,(h,m,E,D)=>{for(var W=0,M=0;M<r;++M)f[M]=c[M](D+W),W+=n;var F;switch(e){case 0:F=N.toValue(h).apply(null,f);break;case 2:F=Reflect.construct(N.toValue(h),f);break;case 3:F=f[0];break;case 1:F=N.toValue(h)[dt(m)](...f);break}return He(l,E,F)}))},Ze=r=>r?(r=dt(r),N.toHandle(globalThis[r])):N.toHandle(globalThis),Xe=r=>{r>9&&(rr[r+1]+=1)},Ye=(r,t,e,n,i)=>Ur[r](t,e,n,i),Ke=r=>{Or(N.toValue(r)),qr(r)},Je=(r,t,e,n)=>{var i=new Date().getFullYear(),s=new Date(i,0,1),l=new Date(i,6,1),c=s.getTimezoneOffset(),f=l.getTimezoneOffset(),h=Math.max(c,f);_[r>>2]=h*60,or[t>>2]=+(c!=f);var m=W=>{var M=W>=0?"-":"+",F=Math.abs(W);return`UTC${M}${String(Math.floor(F/60)).padStart(2,"0")}${String(F%60).padStart(2,"0")}`},E=m(c),D=m(f);f<c?(ir(E,e,17),ir(D,n,17)):(ir(E,n,17),ir(D,e,17))},rn=()=>2147483648,tn=(r,t)=>Math.ceil(r/t)*t,en=r=>{var t=(r-Tr.buffer.byteLength+65535)/65536|0;try{return Tr.grow(t),wr(),1}catch{}},nn=r=>{var t=z.length;r>>>=0;var e=rn();if(r>e)return!1;for(var n=1;n<=4;n*=2){var i=t*(1+.2/n);if(i=Math.min(i,r+100663296),en(Math.min(e,tn(Math.max(r,i),65536))))return!0}return!1},zr={},an=()=>y||"./this.program",lr=()=>{if(!lr.strings){var r,t,e={USER:"web_user",LOGNAME:"web_user",PATH:"/",PWD:"/",HOME:"/home/web_user",LANG:((r=(t=globalThis.navigator)==null?void 0:t.language)==null?"C":r).replace("-","_")+".UTF-8",_:an()};for(var n in zr)zr[n]===void 0?delete e[n]:e[n]=zr[n];var i=[];for(var n in e)i.push(`${n}=${e[n]}`);lr.strings=i}return lr.strings},on=(r,t)=>{var e=0,n=0;for(var i of lr()){var s=t+e;_[r+n>>2]=s,e+=ir(i,s,1/0)+1,n+=4}return 0},sn=(r,t)=>{var e=lr();_[r>>2]=e.length;var n=0;for(var i of e)n+=ct(i)+1;return _[t>>2]=n,0},un=r=>52,ln=(r,t,e,n)=>52;function cn(r,t,e,n,i){return 70}var fn=[null,[],[]],dn=(r,t)=>{var e=fn[r];t===0||t===10?((r===1?hr:G)(nt(e)),e.length=0):e.push(t)},hn=(r,t,e,n)=>{for(var i=0,s=0;s<e;s++){var l=_[t>>2],c=_[t+4>>2];t+=8;for(var f=0;f<c;f++)dn(r,z[l+f]);i+=c}return _[n>>2]=i,0},pn=r=>r;if(u.noExitRuntime&&u.noExitRuntime,u.print&&(hr=u.print),u.printErr&&(G=u.printErr),u.wasmBinary&&(U=u.wasmBinary),u.arguments&&u.arguments,u.thisProgram&&(y=u.thisProgram),u.preInit)for(typeof u.preInit=="function"&&(u.preInit=[u.preInit]);u.preInit.length>0;)u.preInit.shift()();var ht,kr,Z,b,pt,gt,wt,mt,jr,yt,vt,_t,Tr,bt;function gn(r){ht=r.pa,kr=u._malloc=r.ra,Z=u._free=r.sa,b=r.ta,pt=r.ua,gt=r.va,wt=r.wa,mt=r.xa,jr=r.ya,yt=r.za,vt=r.Aa,tr.jiji=r.Ba,tr.viijii=r.Ca,_t=tr.jiiii=r.Da,tr.iiiiij=r.Ea,tr.iiiiijj=r.Fa,tr.iiiiiijj=r.Ga,Tr=r.na,bt=r.qa}var wn={t:jt,u:Nt,a:Lt,g:Ht,v:Vt,_:Gt,p:Zt,Z:Xt,e:Yt,L:Jt,da:re,ba:te,ea:ee,aa:ne,U:ae,ka:oe,T:se,ia:ce,ga:de,M:pe,N:xe,s:Me,n:De,ha:Fe,E:qe,F:Ue,la:ze,ja:ke,C:Ge,ma:qr,Q:Ze,G:Xe,A:Ye,W:Ke,V:Je,$:nn,X:on,Y:sn,J:un,ca:ln,S:cn,K:hn,H:Pn,O:Tn,I:Sn,l:Qn,b:Rn,c:bn,f:Cn,j:Mn,D:Dn,r:Fn,B:$n,x:On,R:Un,k:An,i:mn,d:vn,h:_n,o:yn,y:Wn,z:xn,q:Bn,fa:In,m:En,w:qn,P:pn};function mn(r,t){var e=T();try{A(r)(t)}catch(n){if(C(e),n!==n+0)throw n;b(1,0)}}function yn(r,t,e,n,i){var s=T();try{A(r)(t,e,n,i)}catch(l){if(C(s),l!==l+0)throw l;b(1,0)}}function vn(r,t,e){var n=T();try{A(r)(t,e)}catch(i){if(C(n),i!==i+0)throw i;b(1,0)}}function _n(r,t,e,n){var i=T();try{A(r)(t,e,n)}catch(s){if(C(i),s!==s+0)throw s;b(1,0)}}function bn(r,t,e){var n=T();try{return A(r)(t,e)}catch(i){if(C(n),i!==i+0)throw i;b(1,0)}}function An(r){var t=T();try{A(r)()}catch(e){if(C(t),e!==e+0)throw e;b(1,0)}}function Rn(r,t){var e=T();try{return A(r)(t)}catch(n){if(C(e),n!==n+0)throw n;b(1,0)}}function Cn(r,t,e,n){var i=T();try{return A(r)(t,e,n)}catch(s){if(C(i),s!==s+0)throw s;b(1,0)}}function Tn(r,t,e,n,i,s){var l=T();try{return A(r)(t,e,n,i,s)}catch(c){if(C(l),c!==c+0)throw c;b(1,0)}}function En(r,t,e,n,i,s,l,c,f,h,m){var E=T();try{A(r)(t,e,n,i,s,l,c,f,h,m)}catch(D){if(C(E),D!==D+0)throw D;b(1,0)}}function xn(r,t,e,n,i,s,l){var c=T();try{A(r)(t,e,n,i,s,l)}catch(f){if(C(c),f!==f+0)throw f;b(1,0)}}function In(r,t,e,n,i,s,l,c,f){var h=T();try{A(r)(t,e,n,i,s,l,c,f)}catch(m){if(C(h),m!==m+0)throw m;b(1,0)}}function Mn(r,t,e,n,i){var s=T();try{return A(r)(t,e,n,i)}catch(l){if(C(s),l!==l+0)throw l;b(1,0)}}function Dn(r,t,e,n,i,s){var l=T();try{return A(r)(t,e,n,i,s)}catch(c){if(C(l),c!==c+0)throw c;b(1,0)}}function Wn(r,t,e,n,i,s){var l=T();try{A(r)(t,e,n,i,s)}catch(c){if(C(l),c!==c+0)throw c;b(1,0)}}function Fn(r,t,e,n,i,s,l){var c=T();try{return A(r)(t,e,n,i,s,l)}catch(f){if(C(c),f!==f+0)throw f;b(1,0)}}function $n(r,t,e,n,i,s,l,c){var f=T();try{return A(r)(t,e,n,i,s,l,c)}catch(h){if(C(f),h!==h+0)throw h;b(1,0)}}function Sn(r,t,e,n){var i=T();try{return A(r)(t,e,n)}catch(s){if(C(i),s!==s+0)throw s;b(1,0)}}function Pn(r,t,e,n){var i=T();try{return A(r)(t,e,n)}catch(s){if(C(i),s!==s+0)throw s;b(1,0)}}function Qn(r){var t=T();try{return A(r)()}catch(e){if(C(t),e!==e+0)throw e;b(1,0)}}function Bn(r,t,e,n,i,s,l,c){var f=T();try{A(r)(t,e,n,i,s,l,c)}catch(h){if(C(f),h!==h+0)throw h;b(1,0)}}function On(r,t,e,n,i,s,l,c,f,h,m,E){var D=T();try{return A(r)(t,e,n,i,s,l,c,f,h,m,E)}catch(W){if(C(D),W!==W+0)throw W;b(1,0)}}function qn(r,t,e,n,i,s,l,c,f,h,m,E,D,W,M,F){var cr=T();try{A(r)(t,e,n,i,s,l,c,f,h,m,E,D,W,M,F)}catch(L){if(C(cr),L!==L+0)throw L;b(1,0)}}function Un(r,t,e,n,i){var s=T();try{return _t(r,t,e,n,i)}catch(l){if(C(s),l!==l+0)throw l;b(1,0)}}function zn(){Wt();function r(){var t,e;u.calledRun=!0,!nr&&(Ft(),(t=pr)==null||t(u),(e=u.onRuntimeInitialized)==null||e.call(u),$t())}u.setStatus?(u.setStatus("Running..."),setTimeout(()=>{setTimeout(()=>u.setStatus(""),1),r()},1)):r()}var Er=await Ut();return zn(),o=gr?u:new Promise((r,t)=>{pr=r,Y=t}),o}function aa(a){return Mt(Dt,a)}async function ia(a,o){return na(Dt,a,o)}var oa=""+new URL(__RQR_WASM_URL("zxing_writer-NQHybxPU.wasm"),import.meta.url).href;const sa=[[1,26,19],[1,26,16],[1,26,13],[1,26,9],[1,44,34],[1,44,28],[1,44,22],[1,44,16],[1,70,55],[1,70,44],[2,35,17],[2,35,13],[1,100,80],[2,50,32],[2,50,24],[4,25,9],[1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],[2,86,68],[4,43,27],[4,43,19],[4,43,15],[2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],[2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],[4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],[4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],[3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],[5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],[5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],[1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],[5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],[3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],[3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],[4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],[2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],[4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],[6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],[8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],[10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],[8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],[3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],[7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],[5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],[13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],[17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],[17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],[13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],[12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],[6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],[17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],[4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],[20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],[19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]],ua={L:0,M:1,Q:2,H:3},la=20;function ca(a,o){return fa(a,o,la)}function fa(a,o,d){const p=da(a,o),g=4+(a<=9?8:16)+d;return Math.max(0,Math.floor((p*8-g)/8))}function da(a,o){const d=(a-1)*4+ua[o],p=sa[d];if(!p)throw new Error(`No RS block table entry for V${a}-${o}`);let u=0;for(let g=0;g<p.length;g+=3)u+=p[g]*p[g+2];return u}let Gr=null;async function ha(a,o,d,p){const u=await pa(a,o,d,p),g=o*4+17;if(u.width===g&&u.height===g)return ma(u,p);const w=va(o,p);if(u.width===w&&u.height===w)return wa(u);throw new Error(`ZXing QR writer returned ${u.width}x${u.height}, expected ${g}x${g} modules or ${w}x${w} pixels for V${o}-${d} at scale ${p}.`)}async function pa(a,o,d,p){ya(o,d,p,a.length),await ga();const u={format:"QRCode",options:`version=${o},ecLevel=${d}`,scale:p,addQuietZones:!0,addHRT:!1},g=await ia(a,u);if(g.error)throw new Error(`ZXing QR writer failed: ${g.error}`);return g.symbol}function ga(){return Gr||(Gr=Promise.resolve(aa({overrides:{locateFile:a=>a.endsWith(".wasm")?oa:a},equalityFn:Object.is,fireImmediately:!0}))),Gr}function wa(a){if(a.data.length!==a.width*a.height)throw new Error(`ZXing QR symbol buffer size mismatch: ${a.data.length} bytes for ${a.width}x${a.height}.`);const o=new Uint8ClampedArray(a.width*a.height*4);for(let d=0;d<a.data.length;d++){const p=a.data[d]===0?0:255,u=d*4;o[u]=p,o[u+1]=p,o[u+2]=p,o[u+3]=255}return new ImageData(o,a.width,a.height)}function ma(a,o){if(a.data.length!==a.width*a.height)throw new Error(`ZXing QR symbol buffer size mismatch: ${a.data.length} bytes for ${a.width}x${a.height}.`);const d=4,p=(a.width+d*2)*o,u=new Uint8ClampedArray(p*p*4);u.fill(255);for(let g=0;g<a.height;g++)for(let w=0;w<a.width;w++){if(a.data[g*a.width+w]!==0)continue;const R=(w+d)*o,y=(g+d)*o;for(let x=0;x<o;x++){const I=((y+x)*p+R)*4;for(let S=0;S<o;S++){const Q=I+S*4;u[Q]=0,u[Q+1]=0,u[Q+2]=0,u[Q+3]=255}}}return new ImageData(u,p,p)}function ya(a,o,d,p){if(!Number.isInteger(a)||a<1||a>40)throw new RangeError(`Invalid QR version: ${a}. Must be 1-40.`);if(o!=="L"&&o!=="M"&&o!=="Q"&&o!=="H")throw new RangeError(`Invalid QR ECC level: ${o}.`);if(!Number.isInteger(d)||d<1)throw new RangeError(`Invalid QR render scale: ${d}.`);if(p!==void 0){const u=ca(a,o);if(p>u)throw new Error(`Data too large for ZXing QR writer V${a}-${o}. Maximum ${u} bytes for binary Uint8Array payload, got ${p}.`)}}function va(a,o){return(a*4+17+8)*o}const _a="fast-qr-wasm";function ba(a){switch(a){case"fast-qr-wasm":case"fast_qr_wasm":case"fastQrWasm":return"fast-qr-wasm";case"zxing-wasm":case"zxing":case"zxingWasm":return"zxing-wasm";case"color-cimbar":case"colorCimbar":return"color-cimbar";default:return _a}}const Aa={L:0,M:1,Q:2,H:3};let Mr=null;async function Ra(a,o,d,p,u="fast-qr-wasm"){switch(u){case"fast-qr-wasm":return Ta(a,o,d,p);case"zxing-wasm":return ha(a,o,d,p)}}async function Ca(){Mr||(Mr=Et().then(()=>new $r).catch(o=>{Mr=null;const d=o instanceof Error?o.message:String(o);throw new Error(`${Zr()} ${d}`)}));const a=await Mr;if(!a||!xt())throw new Error(Zr());return a}async function Ta(a,o,d,p){const u=await Ca(),g=Aa[d],w=u.render_rgba(a,o,g,p),R=w*w*4,y=It(),x=u.rgba_ptr(),I=new Uint8ClampedArray(y.buffer,x,R),S=new Uint8ClampedArray(R);return S.set(I),new ImageData(S,w,w)}const Ea={L:0,M:1,Q:2,H:3};let Fr=null;const xa=Et().then(()=>(Fr=new $r,Fr)).catch(()=>(Fr=null,null));self.onmessage=a=>{const o=a.data;o.type==="render"&&Ia(o)};async function Ia(a){try{const o=new Uint8Array(a.packet),d=ba(a.qrEncoder);let p,u,g;if(d==="color-cimbar"){const r0=CimQR.render(o,a.scale||1,a.cimSize||0);p=r0.data.buffer,u=r0.width,g=r0.height}else if(Ma(d)){const w=Fr??await xa;if(xt()&&w!==null){const R=Ea[a.ecc],y=w.render_rgba(o,a.version,R,a.scale),x=y*y*4,I=It(),S=w.rgba_ptr(),Q=new Uint8ClampedArray(I.buffer,S,x),q=new Uint8ClampedArray(x);q.set(Q),p=q.buffer,u=y,g=y}else throw new Error(Zr())}else{const w=await Ra(o,a.version,a.ecc,a.scale,d);p=w.data.buffer.slice(w.data.byteOffset,w.data.byteOffset+w.data.byteLength),u=w.width,g=w.height}self.postMessage({type:"rendered",buffer:p,width:u,height:g,jobId:a.jobId},{transfer:[p]})}catch(o){self.postMessage({type:"error",message:o instanceof Error?o.message:String(o),jobId:a.jobId})}}function Ma(a){const o=String(a);return o==="fast-qr-wasm"||o==="fast_qr_wasm"||o==="fastQrWasm"}
