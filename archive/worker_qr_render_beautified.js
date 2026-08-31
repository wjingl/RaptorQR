self.__RQR_WASM_MAP = null;
self.__RQR_DEBUG = false;
// 顶层 await：挂起模块求值直到 wasm 资源注入到达（已验证：await 期间消息照常派发）。
// 这样模块级的急切 init（zxing 顶层 await、ensureFastQrWasm）必然在 map 到达后执行。
await new Promise(function(__rqr_resolve) {
  self.addEventListener("message", function __rqr_wasm_boot(e) {
    if (self.__RQR_DEBUG) {
      self.__RQR_MSG_COUNT = (self.__RQR_MSG_COUNT || 0) + 1;
      if (self.__RQR_MSG_COUNT <= 5) self.postMessage({
        type: "wasm-msg-log",
        n: self.__RQR_MSG_COUNT,
        t: e.data && e.data.type
      });
    }
    if (e.data && e.data.type === "wasm-assets") {
      self.__RQR_WASM_MAP = e.data.map;
      self.__RQR_DEBUG = !!e.data.debug;
      if (self.__RQR_DEBUG) self.postMessage({
        type: "wasm-map-received",
        keys: Object.keys(e.data.map || {}),
        n: (e.data.map ? Object.keys(e.data.map).length : 0)
      });
      __rqr_resolve(true);
    }
  });
});
self.__RQR_WASM_URL = function(name) {
  if (self.__RQR_WASM_MAP && self.__RQR_WASM_MAP[name]) return self.__RQR_WASM_MAP[name];
  if (self.__RQR_DEBUG) self.postMessage({
    type: "wasm-url-called",
    name: name,
    hasMap: !!self.__RQR_WASM_MAP,
    keys: self.__RQR_WASM_MAP ? Object.keys(self.__RQR_WASM_MAP) : []
  });
  throw new Error("RaptorQR WASM 资源未注入: " + name);
};
class $r {
  __destroy_into_raw() {
    const o = this.__wbg_ptr;
    return this.__wbg_ptr = 0, At.unregister(this), o
  }
  free() {
    const o = this.__destroy_into_raw();
    v.__wbg_qrrenderer_free(o, 0)
  }
  buf_len() {
    return v.qrrenderer_buf_len(this.__wbg_ptr) >>> 0
  }
  buf_ptr() {
    return v.qrrenderer_buf_ptr(this.__wbg_ptr) >>> 0
  }
  last_matrix_size() {
    return v.qrrenderer_last_matrix_size(this.__wbg_ptr) >>> 0
  }
  matrix_len() {
    return v.qrrenderer_matrix_len(this.__wbg_ptr) >>> 0
  }
  matrix_ptr() {
    return v.qrrenderer_matrix_ptr(this.__wbg_ptr) >>> 0
  }
  constructor() {
    const o = v.qrrenderer_new();
    return this.__wbg_ptr = o, At.register(this, this.__wbg_ptr, this), this
  }
  render(o, d, p, u) {
    try {
      const y = v.__wbindgen_add_to_stack_pointer(-16),
        x = Nr(o, v.__wbindgen_export),
        I = Wr;
      v.qrrenderer_render(y, this.__wbg_ptr, x, I, d, p, u);
      var g = H().getInt32(y + 0, !0),
        w = H().getInt32(y + 4, !0),
        R = H().getInt32(y + 8, !0);
      if (R) throw Lr(w);
      return g >>> 0
    } finally {
      v.__wbindgen_add_to_stack_pointer(16)
    }
  }
  render_matrix(o, d, p) {
    try {
      const R = v.__wbindgen_add_to_stack_pointer(-16),
        y = Nr(o, v.__wbindgen_export),
        x = Wr;
      v.qrrenderer_render_matrix(R, this.__wbg_ptr, y, x, d, p);
      var u = H().getInt32(R + 0, !0),
        g = H().getInt32(R + 4, !0),
        w = H().getInt32(R + 8, !0);
      if (w) throw Lr(g);
      return u >>> 0
    } finally {
      v.__wbindgen_add_to_stack_pointer(16)
    }
  }
  render_rgba(o, d, p, u) {
    try {
      const y = v.__wbindgen_add_to_stack_pointer(-16),
        x = Nr(o, v.__wbindgen_export),
        I = Wr;
      v.qrrenderer_render_rgba(y, this.__wbg_ptr, x, I, d, p, u);
      var g = H().getInt32(y + 0, !0),
        w = H().getInt32(y + 4, !0),
        R = H().getInt32(y + 8, !0);
      if (R) throw Lr(w);
      return g >>> 0
    } finally {
      v.__wbindgen_add_to_stack_pointer(16)
    }
  }
  rgba_len() {
    return v.qrrenderer_rgba_len(this.__wbg_ptr) >>> 0
  }
  rgba_ptr() {
    return v.qrrenderer_rgba_ptr(this.__wbg_ptr) >>> 0
  }
}
Symbol.dispose && ($r.prototype[Symbol.dispose] = $r.prototype.free);

function kn() {
  return {
    __proto__: null,
    "./raptorqr_fast_qr_wasm_bg.js": {
      __proto__: null,
      __wbg___wbindgen_throw_344f42d3211c4765: function(o, d) {
        throw new Error(Rt(o, d))
      },
      __wbindgen_cast_0000000000000001: function(o, d) {
        const p = Rt(o, d);
        return jn(p)
      }
    }
  }
}
const At = typeof FinalizationRegistry > "u" ? {
  register: () => {},
  unregister: () => {}
} : new FinalizationRegistry(a => v.__wbg_qrrenderer_free(a, 1));

function jn(a) {
  dr === V.length && V.push(V.length + 1);
  const o = dr;
  return dr = V[o], V[o] = a, o
}

function Nn(a) {
  a < 1028 || (V[a] = dr, dr = a)
}
let er = null;

function H() {
  return (er === null || er.buffer.detached === !0 || er.buffer.detached === void 0 && er.buffer !== v.memory.buffer) && (er = new DataView(v.memory.buffer)), er
}

function Rt(a, o) {
  return Vn(a >>> 0, o)
}
let fr = null;

function Tt() {
  return (fr === null || fr.byteLength === 0) && (fr = new Uint8Array(v.memory.buffer)), fr
}

function Ln(a) {
  return V[a]
}
let V = new Array(1024).fill(void 0);
V.push(void 0, null, !0, !1);
let dr = V.length;

function Nr(a, o) {
  const d = o(a.length * 1, 1) >>> 0;
  return Tt().set(a, d / 1), Wr = a.length, d
}

function Lr(a) {
  const o = Ln(a);
  return Nn(a), o
}
let Dr = new TextDecoder("utf-8", {
  ignoreBOM: !0,
  fatal: !0
});
Dr.decode();
const Hn = 2146435072;
let Hr = 0;

function Vn(a, o) {
  return Hr += o, Hr >= Hn && (Dr = new TextDecoder("utf-8", {
    ignoreBOM: !0,
    fatal: !0
  }), Dr.decode(), Hr = o), Dr.decode(Tt().subarray(a, a + o))
}
let Wr = 0,
  v;

function Gn(a, o) {
  return v = a.exports, er = null, fr = null, v
}
async function Zn(a, o) {
  if (typeof Response == "function" && a instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming == "function") try {
      return await WebAssembly.instantiateStreaming(a, o)
    } catch (u) {
      if (a.ok && d(a.type) && a.headers.get("Content-Type") !== "application/wasm") console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", u);
      else throw u
    }
    const p = await a.arrayBuffer();
    return await WebAssembly.instantiate(p, o)
  } else {
    const p = await WebAssembly.instantiate(a, o);
    return p instanceof WebAssembly.Instance ? {
      instance: p,
      module: a
    } : p
  }

  function d(p) {
    switch (p) {
      case "basic":
      case "cors":
      case "default":
        return !0
    }
    return !1
  }
}
async function Xn(a) {
  if (v !== void 0) return v;
  a !== void 0 && (Object.getPrototypeOf(a) === Object.prototype ? {
    module_or_path: a
  } = a : console.warn("using deprecated parameters for the initialization function; pass a single object instead")), a === void 0 && (a = new URL("" + new URL(__RQR_WASM_URL("raptorqr_fast_qr_wasm_bg-DEFhihBP.wasm"), import.meta.url).href, import.meta.url));
  const o = kn();
  (typeof a == "string" || typeof Request == "function" && a instanceof Request || typeof URL == "function" && a instanceof URL) && (a = fetch(a));
  const {
    instance: d,
    module: p
  } = await Zn(await a, o);
  return Gn(d)
}
let Ir = null,
  Sr = null;

function Zr() {
  return "fast_qr WASM artifacts are not installed. Run packages/raptorqr-fast-qr-wasm/src/build_fast_qr_wasm_colab.py in Google Colab, then copy the generated files into packages/raptorqr-fast-qr-wasm/src/wasm."
}
async function Et() {
  Ir || (Ir = Promise.resolve(Xn()).then(a => {
    Sr = a
  }).catch(a => {
    throw Ir = null, a instanceof Error ? a : new Error(String(a))
  })), await Ir
}

function xt() {
  return Sr !== null
}

function It() {
  if (!Sr) throw new Error("fast_qr WASM not initialized — call ensureFastQrWasm() first.");
  return Sr.memory
}
var O = [
    ["All", "*", "*", "     ", 0, "All"],
    ["AllReadable", "*", "r", "     ", 0, "All Readable"],
    ["AllCreatable", "*", "w", "     ", 0, "All Creatable"],
    ["AllLinear", "*", "l", "     ", 0, "All Linear"],
    ["AllMatrix", "*", "m", "     ", 0, "All Matrix"],
    ["AllGS1", "*", "G", "     ", 0, "All GS1"],
    ["AllRetail", "*", "R", "     ", 0, "All Retail"],
    ["AllIndustrial", "*", "I", "     ", 0, "All Industrial"],
    ["Codabar", "F", " ", "lrw  ", 18, "Codabar"],
    ["Code39", "A", " ", "lrw I", 8, "Code 39"],
    ["Code39Std", "A", "s", "lrw I", 8, "Code 39 Standard"],
    ["Code39Ext", "A", "e", "lr  I", 9, "Code 39 Extended"],
    ["Code32", "A", "2", "lr  I", 129, "Code 32"],
    ["PZN", "A", "p", "lr  I", 52, "Pharmazentralnummer"],
    ["Code93", "G", " ", "lrw I", 25, "Code 93"],
    ["Code128", "C", " ", "lrwGI", 20, "Code 128"],
    ["ITF", "I", " ", "lrw I", 3, "ITF"],
    ["ITF14", "I", "4", "lr  I", 89, "ITF-14"],
    ["DataBar", "e", " ", "lr GR", 29, "DataBar"],
    ["DataBarOmni", "e", "o", "lr GR", 29, "DataBar Omni"],
    ["DataBarStk", "e", "s", "lr GR", 79, "DataBar Stacked"],
    ["DataBarStkOmni", "e", "O", "lr GR", 80, "DataBar Stacked Omni"],
    ["DataBarLtd", "e", "l", "lr GR", 30, "DataBar Limited"],
    ["DataBarExp", "e", "e", "lr GR", 31, "DataBar Expanded"],
    ["DataBarExpStk", "e", "E", "lr GR", 81, "DataBar Expanded Stacked"],
    ["EANUPC", "E", " ", "lr  R", 15, "EAN/UPC"],
    ["EAN13", "E", "1", "lrw R", 15, "EAN-13"],
    ["EAN8", "E", "8", "lrw R", 10, "EAN-8"],
    ["EAN5", "E", "5", "l   R", 12, "EAN-5"],
    ["EAN2", "E", "2", "l   R", 11, "EAN-2"],
    ["ISBN", "E", "i", "lr  R", 69, "ISBN"],
    ["UPCA", "E", "a", "lrw R", 34, "UPC-A"],
    ["UPCE", "E", "e", "lrw R", 37, "UPC-E"],
    ["Telepen", "B", " ", "lr  I", 32, "Telepen"],
    ["TelepenAlpha", "B", "0", "lr  I", 32, "Telepen Alpha"],
    ["TelepenNumeric", "B", "1", "lr  I", 87, "Telepen Numeric"],
    ["OtherBarcode", "X", " ", " r   ", 0, "Other barcode"],
    ["DXFilmEdge", "X", "x", "lr   ", 147, "DX Film Edge"],
    ["PDF417", "L", " ", "mrw  ", 55, "PDF417"],
    ["CompactPDF417", "L", "c", "mr   ", 56, "Compact PDF417"],
    ["MicroPDF417", "L", "m", "mr   ", 84, "MicroPDF417"],
    ["Aztec", "z", " ", "mr G ", 92, "Aztec"],
    ["AztecCode", "z", "c", "mrwG ", 92, "Aztec Code"],
    ["AztecRune", "z", "r", "mr   ", 128, "Aztec Rune"],
    ["QRCode", "Q", " ", "mrwG ", 58, "QR Code"],
    ["QRCodeModel1", "Q", "1", "mr   ", 0, "QR Code Model 1"],
    ["QRCodeModel2", "Q", "2", "mr   ", 58, "QR Code Model 2"],
    ["MicroQRCode", "Q", "m", "mr   ", 97, "Micro QR Code"],
    ["RMQRCode", "Q", "r", "mr G ", 145, "rMQR Code"],
    ["DataMatrix", "d", " ", "mrwG ", 71, "Data Matrix"],
    ["MaxiCode", "U", " ", "mr   ", 57, "MaxiCode"]
  ],
  Yn = {
    DataBarExpanded: "DataBarExp",
    DataBarLimited: "DataBarLtd",
    "Linear-Codes": "AllLinear",
    "Matrix-Codes": "AllMatrix",
    Any: "All",
    rMQRCode: "RMQRCode"
  };
O.map(a => a[5]);
O.filter(a => a[1] === "*").map(a => a[0]);
O.filter(a => a[1] !== "*").map(a => a[0]);
O.filter(a => a[2] === " ").map(a => a[0]);
O.filter(a => a[3][0] === "l").map(a => a[0]);
O.filter(a => a[3][0] === "m").map(a => a[0]);
O.filter(a => a[3][1] === "r").map(a => a[0]);
O.filter(a => a[3][2] === "w" || a[4] !== 0).map(a => a[0]);
O.filter(a => a[3][3] === "G").map(a => a[0]);
O.filter(a => a[3][4] === "R").map(a => a[0]);
O.filter(a => a[3][4] === "I").map(a => a[0]);

function Kn(a) {
  var o;
  return (o = Yn[a]) == null ? a : o
}
var Jn = {
  formats: []
};

function Ct(a) {
  var o;
  return {
    ...a,
    image: (o = a.image && new Blob([a.image], {
      type: "image/png"
    })) == null ? null : o
  }
}
var $ = {
  format: "QRCode",
  readerInit: !1,
  forceSquareDataMatrix: !1,
  ecLevel: "",
  scale: 1,
  sizeHint: 0,
  rotate: 0,
  invert: !1,
  withHRT: !1,
  withQuietZones: !0,
  addHRT: !1,
  addQuietZones: !0,
  options: ""
};

function ra(a = $) {
  var o, d;
  let {
    format: p = $.format,
    sizeHint: u = $.sizeHint,
    readerInit: g = $.readerInit,
    forceSquareDataMatrix: w = $.forceSquareDataMatrix,
    ecLevel: R = $.ecLevel,
    withHRT: y,
    withQuietZones: x,
    addHRT: I,
    addQuietZones: S,
    options: Q = $.options,
    scale: q,
    rotate: hr = $.rotate,
    invert: G = $.invert
  } = a, U = Q.split(",").map(Y => Y.trim()).filter(Boolean), nr = Y => {
    let gr = Y.split("=")[0];
    U.some(wr => wr.split("=")[0] === gr) || U.push(Y)
  };
  g && nr("readerInit"), w && nr("forceSquare"), R && nr(`ecLevel=${R}`);
  let pr = q ?? (u > 0 ? -Math.trunc(Math.abs(u)) : $.scale);
  return {
    format: Kn(p),
    options: U.join(","),
    scale: pr,
    rotate: hr,
    invert: G,
    addHRT: (o = I ?? y) == null ? $.addHRT : o,
    addQuietZones: (d = S ?? x) == null ? $.addQuietZones : d
  }
}
var ta = {
    locateFile: (a, o) => {
      let d = a.match(/_(.+?)\.wasm$/);
      return d ? `https://fastly.jsdelivr.net/npm/zxing-wasm@3.1.0/dist/${d[1]}/${a}` : o + a
    }
  },
  Vr = new WeakMap;

function ea(a, o) {
  return Object.is(a, o) || Object.keys(a).length === Object.keys(o).length && Object.keys(a).every(d => Object.hasOwn(o, d) && a[d] === o[d])
}

function Mt(a, {
  overrides: o,
  equalityFn: d = ea,
  fireImmediately: p = !1
} = {}) {
  var u, g;
  let [w, R] = (u = Vr.get(a)) == null ? [ta] : u, y = o ?? w, x;
  if (p) {
    if (R && (x = d(w, y))) return R;
    let I = a({
      ...y
    });
    return Vr.set(a, [y, I]), I
  }((g = x) == null ? d(w, y) : g) || Vr.set(a, [y])
}
async function na(a, o, d = $) {
  let p = ra(d),
    u = await Mt(a, {
      fireImmediately: !0
    });
  if (typeof o == "string") return Ct(u.writeBarcodeFromText(o, p));
  let {
    byteLength: g
  } = o, w = u._malloc(g);
  if (!w) throw Error(`Failed to allocate ${g} bytes in WASM memory`);
  try {
    return u.HEAPU8.set(o, w), Ct(u.writeBarcodeFromBytes(w, g, p))
  } finally {
    u._free(w)
  }
} [...Jn.formats];
({
  ...$
});
async function Dt(a = {}) {
  var o, d, p, u = a,
    g = !!globalThis.window,
    w = typeof Bun < "u",
    R = !!globalThis.WorkerGlobalScope;
  !((d = globalThis.process) == null || (d = d.versions) == null) && d.node && ((p = globalThis.process) == null || p.type);
  var y = "./this.program",
    x, I = "";

  function S(r) {
    return u.locateFile ? u.locateFile(r, I) : I + r
  }
  var Q, q;
  if (g || R || w) {
    try {
      I = new URL(".", x).href
    } catch {}
    R && (q = r => {
      var t = new XMLHttpRequest;
      return t.open("GET", r, !1), t.responseType = "arraybuffer", t.send(null), new Uint8Array(t.response)
    }), Q = async r => {
      var t = await fetch(r, {
        credentials: "same-origin"
      });
      if (t.ok) return t.arrayBuffer();
      throw Error(t.status + " : " + t.url)
    }
  }
  var hr = console.log.bind(console),
    G = console.error.bind(console),
    U, nr = !1,
    pr, Y, gr = !1;

  function wr() {
    var r = Tr.buffer;
    K = new Int8Array(r), yr = new Int16Array(r), u.HEAPU8 = z = new Uint8Array(r), sr = new Uint16Array(r), or = new Int32Array(r), _ = new Uint32Array(r), Xr = new Float32Array(r), Yr = new Float64Array(r)
  }

  function Wt() {
    if (u.preRun)
      for (typeof u.preRun == "function" && (u.preRun = [u.preRun]); u.preRun.length;) kt(u.preRun.shift());
    Kr(rt)
  }

  function Ft() {
    gr = !0, Er.oa()
  }

  function $t() {
    if (u.postRun)
      for (typeof u.postRun == "function" && (u.postRun = [u.postRun]); u.postRun.length;) zt(u.postRun.shift());
    Kr(Jr)
  }

  function Pr(r) {
    var t, e;
    (t = u.onAbort) == null || t.call(u, r), r = "Aborted(" + r + ")", G(r), nr = !0, r += ". Build with -sASSERTIONS for more info.";
    var n = new WebAssembly.RuntimeError(r);
    throw (e = Y) == null || e(n), n
  }
  var mr;

  function St() {
    return S("zxing_writer.wasm")
  }

  function Pt(r) {
    if (r == mr && U) return new Uint8Array(U);
    if (q) return q(r);
    throw "both async and sync fetching of the wasm failed"
  }
  async function Qt(r) {
    if (!U) try {
      var t = await Q(r);
      return new Uint8Array(t)
    } catch {}
    return Pt(r)
  }
  async function Bt(r, t) {
    try {
      var e = await Qt(r);
      return await WebAssembly.instantiate(e, t)
    } catch (n) {
      G(`failed to asynchronously prepare wasm: ${n}`), Pr(n)
    }
  }
  async function Ot(r, t, e) {
    if (!r && WebAssembly.instantiateStreaming) try {
      var n = fetch(t, {
        credentials: "same-origin"
      });
      return await WebAssembly.instantiateStreaming(n, e)
    } catch (i) {
      G(`wasm streaming compile failed: ${i}`), G("falling back to ArrayBuffer instantiation")
    }
    return Bt(t, e)
  }

  function qt() {
    return {
      a: wn
    }
  }
  async function Ut() {
    function r(n, i) {
      return Er = n.exports, gn(Er), wr(), Er
    }

    function t(n) {
      return r(n.instance)
    }
    var e = qt();
    return u.instantiateWasm ? new Promise((n, i) => {
      u.instantiateWasm(e, (s, l) => {
        n(r(s))
      })
    }) : (mr != null || (mr = St()), t(await Ot(U, mr, e)))
  }
  var yr, or, K, Xr, Yr, sr, _, z, Kr = r => {
      for (; r.length > 0;) r.shift()(u)
    },
    Jr = [],
    zt = r => Jr.push(r),
    rt = [],
    kt = r => rt.push(r),
    C = r => gt(r),
    T = () => wt(),
    vr = [],
    _r = 0,
    jt = r => {
      var t = new Qr(r);
      return t.get_caught() || (t.set_caught(!0), _r--), t.set_rethrown(!1), vr.push(t), vt(r)
    },
    k = 0,
    Nt = () => {
      b(0, 0);
      var r = vr.pop();
      mt(r.excPtr), k = 0
    };
  class Qr {
    constructor(t) {
      this.excPtr = t, this.ptr = t - 24
    }
    set_type(t) {
      _[this.ptr + 4 >> 2] = t
    }
    get_type() {
      return _[this.ptr + 4 >> 2]
    }
    set_destructor(t) {
      _[this.ptr + 8 >> 2] = t
    }
    get_destructor() {
      return _[this.ptr + 8 >> 2]
    }
    set_caught(t) {
      t = +!!t, K[this.ptr + 12] = t
    }
    get_caught() {
      return K[this.ptr + 12] != 0
    }
    set_rethrown(t) {
      t = +!!t, K[this.ptr + 13] = t
    }
    get_rethrown() {
      return K[this.ptr + 13] != 0
    }
    init(t, e) {
      this.set_adjusted_ptr(0), this.set_type(t), this.set_destructor(e)
    }
    set_adjusted_ptr(t) {
      _[this.ptr + 16 >> 2] = t
    }
    get_adjusted_ptr() {
      return _[this.ptr + 16 >> 2]
    }
  }
  var br = r => pt(r),
    Br = r => {
      var t = k;
      if (!t) return br(0), 0;
      var e = new Qr(t);
      e.set_adjusted_ptr(t);
      var n = e.get_type();
      if (!n) return br(0), t;
      for (var i of r) {
        if (i === 0 || i === n) break;
        var s = e.ptr + 16;
        if (yt(i, n, s)) return br(i), t
      }
      return br(n), t
    },
    Lt = () => Br([]),
    Ht = r => Br([r]),
    Vt = (r, t) => Br([r, t]),
    Gt = () => {
      var r = vr.pop();
      r || Pr("no exception to throw");
      var t = r.excPtr;
      throw r.get_rethrown() || (vr.push(r), r.set_rethrown(!0), r.set_caught(!1), _r++), jr(t), k = t, k
    },
    Zt = (r, t, e) => {
      throw new Qr(r).init(t, e), jr(r), k = r, _r++, k
    },
    Xt = () => _r,
    Yt = r => {
      throw k || (k = r), k
    },
    tt = globalThis.TextDecoder && new TextDecoder,
    et = (r, t, e, n) => {
      var i = t + e;
      if (n) return i;
      for (; r[t] && !(t >= i);) ++t;
      return t
    },
    nt = function(r) {
      let t = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : 0,
        e = arguments.length > 2 ? arguments[2] : void 0,
        n = arguments.length > 3 ? arguments[3] : void 0;
      var i = et(r, t, e, n);
      if (i - t > 16 && r.buffer && tt) return tt.decode(r.subarray(t, i));
      for (var s = ""; t < i;) {
        var l = r[t++];
        if (!(l & 128)) {
          s += String.fromCharCode(l);
          continue
        }
        var c = r[t++] & 63;
        if ((l & 224) == 192) {
          s += String.fromCharCode((l & 31) << 6 | c);
          continue
        }
        var f = r[t++] & 63;
        if (l = (l & 240) == 224 ? (l & 15) << 12 | c << 6 | f : (l & 7) << 18 | c << 12 | f << 6 | r[t++] & 63, l < 65536) s += String.fromCharCode(l);
        else {
          var h = l - 65536;
          s += String.fromCharCode(55296 | h >> 10, 56320 | h & 1023)
        }
      }
      return s
    },
    Kt = (r, t, e) => r ? nt(z, r, t, e) : "";

  function Jt(r, t, e) {
    return 0
  }

  function re(r, t, e) {
    return 0
  }
  var te = (r, t, e) => {};

  function ee(r, t, e, n) {}
  var ne = (r, t) => {},
    ae = () => Pr(""),
    Ar = {},
    Or = r => {
      for (; r.length;) {
        var t = r.pop();
        r.pop()(t)
      }
    };

  function Rr(r) {
    return this.fromWireType(_[r >> 2])
  }
  var ar = {},
    J = {},
    Cr = {},
    ie = class extends Error {
      constructor(r) {
        super(r), this.name = "InternalError"
      }
    },
    at = r => {
      throw new ie(r)
    },
    it = (r, t, e) => {
      r.forEach(c => Cr[c] = t);

      function n(c) {
        var f = e(c);
        f.length !== r.length && at("Mismatched type converter count");
        for (var h = 0; h < r.length; ++h) j(r[h], f[h])
      }
      var i = Array(t.length),
        s = [],
        l = 0;
      {
        let c = t;
        for (let f = 0; f < c.length; ++f) {
          let h = c[f];
          J.hasOwnProperty(h) ? i[f] = J[h] : (s.push(h), ar.hasOwnProperty(h) || (ar[h] = []), ar[h].push(() => {
            i[f] = J[h], ++l, l === s.length && n(i)
          }))
        }
      }
      s.length === 0 && n(i)
    },
    oe = r => {
      var t = Ar[r];
      delete Ar[r];
      var e = t.rawConstructor,
        n = t.rawDestructor,
        i = t.fields,
        s = i.map(l => l.getterReturnType).concat(i.map(l => l.setterArgumentType));
      it([r], s, l => {
        var c = {};
        {
          let f = i;
          for (let h = 0; h < f.length; ++h) {
            let m = f[h],
              E = l[h],
              D = m.getter,
              W = m.getterContext,
              M = l[h + i.length],
              F = m.setter,
              cr = m.setterContext;
            c[m.fieldName] = {
              read: L => E.fromWireType(D(W, L)),
              write: (L, X) => {
                var xr = [];
                F(cr, L, M.toWireType(xr, X)), Or(xr)
              },
              optional: E.optional
            }
          }
        }
        return [{
          name: t.name,
          fromWireType: f => {
            var h = {};
            for (var m in c) h[m] = c[m].read(f);
            return n(f), h
          },
          toWireType: (f, h) => {
            for (var m in c)
              if (!(m in h) && !c[m].optional) throw TypeError(`Missing field: "${m}"`);
            var E = e();
            for (m in c) c[m].write(E, h[m]);
            return f !== null && f.push(n, E), E
          },
          readValueFromPointer: Rr,
          destructorFunction: n
        }]
      })
    },
    se = (r, t, e, n, i) => {},
    P = r => {
      for (var t = "";;) {
        var e = z[r++];
        if (!e) return t;
        t += String.fromCharCode(e)
      }
    },
    ue = class extends Error {
      constructor(r) {
        super(r), this.name = "BindingError"
      }
    },
    B = r => {
      throw new ue(r)
    };

  function le(r, t) {
    let e = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : {};
    var n = t.name;
    if (r || B(`type "${n}" must have a positive integer typeid pointer`), J.hasOwnProperty(r)) {
      if (e.ignoreDuplicateRegistrations) return;
      B(`Cannot register type '${n}' twice`)
    }
    if (J[r] = t, delete Cr[r], ar.hasOwnProperty(r)) {
      var i = ar[r];
      delete ar[r], i.forEach(s => s())
    }
  }

  function j(r, t) {
    return le(r, t, arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : {})
  }
  var ce = (r, t, e, n) => {
      t = P(t), j(r, {
        name: t,
        fromWireType: function(i) {
          return !!i
        },
        toWireType: function(i, s) {
          return s ? e : n
        },
        readValueFromPointer: function(i) {
          return this.fromWireType(z[i])
        },
        destructorFunction: null
      })
    },
    ot = [],
    rr = [0, 1, , 1, null, 1, !0, 1, !1, 1],
    qr = r => {
      r > 9 && --rr[r + 1] === 0 && (rr[r] = void 0, ot.push(r))
    },
    N = {
      toValue: r => (r || B(`Cannot use deleted val. handle = ${r}`), rr[r]),
      toHandle: r => {
        switch (r) {
          case void 0:
            return 2;
          case null:
            return 4;
          case !0:
            return 6;
          case !1:
            return 8;
          default: {
            let t = ot.pop() || rr.length;
            return rr[t] = r, rr[t + 1] = 1, t
          }
        }
      }
    },
    fe = {
      name: "emscripten::val",
      fromWireType: r => {
        var t = N.toValue(r);
        return qr(r), t
      },
      toWireType: (r, t) => N.toHandle(t),
      readValueFromPointer: Rr,
      destructorFunction: null
    },
    de = r => j(r, fe),
    he = (r, t) => {
      switch (t) {
        case 4:
          return function(e) {
            return this.fromWireType(Xr[e >> 2])
          };
        case 8:
          return function(e) {
            return this.fromWireType(Yr[e >> 3])
          };
        default:
          throw TypeError(`invalid float width (${t}): ${r}`)
      }
    },
    pe = (r, t, e) => {
      t = P(t), j(r, {
        name: t,
        fromWireType: n => n,
        toWireType: (n, i) => i,
        readValueFromPointer: he(t, e),
        destructorFunction: null
      })
    },
    st = (r, t) => Object.defineProperty(t, "name", {
      value: r
    });

  function ge(r) {
    for (var t = 1; t < r.length; ++t)
      if (r[t] !== null && r[t].destructorFunction === void 0) return !0;
    return !1
  }

  function we(r, t, e, n, i, s) {
    var l = t.length;
    l < 2 && B("argTypes array size mismatch! Must at least get return value and 'this' types!"), t[1];
    var c = ge(t),
      f = !t[0].isVoid,
      h = l - 2,
      m = Array(h),
      E = [],
      D = [];
    return st(r, function() {
      D.length = 0;
      var W;
      E.length = 1, E[0] = i;
      for (var M = 0; M < h; ++M) m[M] = t[M + 2].toWireType(D, M < 0 || arguments.length <= M ? void 0 : arguments[M]), E.push(m[M]);
      var F = n(...E);

      function cr(L) {
        if (c) Or(D);
        else
          for (var X = 2; X < t.length; X++) {
            var xr = X === 1 ? W : m[X - 2];
            t[X].destructorFunction !== null && t[X].destructorFunction(xr)
          }
        if (f) return t[0].fromWireType(L)
      }
      return cr(F)
    })
  }
  var me = (r, t, e) => {
      if (r[t].overloadTable === void 0) {
        var n = r[t];
        r[t] = function() {
          var i = [...arguments];
          return r[t].overloadTable.hasOwnProperty(i.length) || B(`Function '${e}' called with an invalid number of arguments (${i.length}) - expects one of (${r[t].overloadTable})!`), r[t].overloadTable[i.length].apply(this, i)
        }, r[t].overloadTable = [], r[t].overloadTable[n.argCount] = n
      }
    },
    ye = (r, t, e) => {
      u.hasOwnProperty(r) ? ((e === void 0 || u[r].overloadTable !== void 0 && u[r].overloadTable[e] !== void 0) && B(`Cannot register public name '${r}' twice`), me(u, r, r), u[r].overloadTable.hasOwnProperty(e) && B(`Cannot register multiple overloads of a function with the same number of arguments (${e})!`), u[r].overloadTable[e] = t) : (u[r] = t, u[r].argCount = e)
    },
    ve = (r, t) => {
      for (var e = [], n = 0; n < r; n++) e.push(_[t + n * 4 >> 2]);
      return e
    },
    _e = (r, t, e) => {
      u.hasOwnProperty(r) || at("Replacing nonexistent public symbol"), u[r].overloadTable !== void 0 && e !== void 0 ? u[r].overloadTable[e] = t : (u[r] = t, u[r].argCount = e)
    },
    tr = {},
    be = (r, t, e) => {
      r = r.replace(/p/g, "i");
      var n = tr[r];
      return n(t, ...e)
    },
    ut = [],
    A = r => {
      var t = ut[r];
      return t || (ut[r] = t = bt.get(r)), t
    },
    Ae = function(r, t) {
      let e = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : [];
      if (r.includes("j")) return be(r, t, e);
      var n = A(t)(...e);

      function i(s) {
        return s
      }
      return n
    },
    Re = function(r, t) {
      let e = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : !1;
      return function() {
        return Ae(r, t, [...arguments], e)
      }
    },
    ur = function(r, t) {
      r = P(r);

      function e() {
        return r.includes("j") ? Re(r, t) : A(t)
      }
      var n = e();
      return typeof n != "function" && B(`unknown function pointer with signature ${r}: ${t}`), n
    };
  class Ce extends Error {}
  var lt = r => {
      var t = ht(r),
        e = P(t);
      return Z(t), e
    },
    Te = (r, t) => {
      var e = [],
        n = {};

      function i(s) {
        if (!n[s] && !J[s]) {
          if (Cr[s]) {
            Cr[s].forEach(i);
            return
          }
          e.push(s), n[s] = !0
        }
      }
      throw t.forEach(i), new Ce(`${r}: ` + e.map(lt).join([", "]))
    },
    Ee = r => {
      r = r.trim();
      let t = r.indexOf("(");
      return t === -1 ? r : r.slice(0, t)
    },
    xe = (r, t, e, n, i, s, l, c) => {
      var f = ve(t, e);
      r = P(r), r = Ee(r), i = ur(n, i), ye(r, function() {
        Te(`Cannot call ${r} due to unbound types`, f)
      }, t - 1), it([], f, h => {
        var m = [h[0], null].concat(h.slice(1));
        return _e(r, we(r, m, null, i, s), t - 1), []
      })
    },
    Ie = (r, t, e) => {
      switch (t) {
        case 1:
          return e ? n => K[n] : n => z[n];
        case 2:
          return e ? n => yr[n >> 1] : n => sr[n >> 1];
        case 4:
          return e ? n => or[n >> 2] : n => _[n >> 2];
        default:
          throw TypeError(`invalid integer width (${t}): ${r}`)
      }
    },
    Me = (r, t, e, n, i) => {
      t = P(t);
      let s = n === 0,
        l = f => f;
      if (s) {
        var c = 32 - 8 * e;
        l = f => f << c >>> c, i = l(i)
      }
      j(r, {
        name: t,
        fromWireType: l,
        toWireType: (f, h) => h,
        readValueFromPointer: Ie(t, e, n !== 0),
        destructorFunction: null
      })
    },
    De = (r, t, e) => {
      var n = [Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array][t];

      function i(s) {
        var l = _[s >> 2],
          c = _[s + 4 >> 2];
        return new n(K.buffer, c, l)
      }
      e = P(e), j(r, {
        name: e,
        fromWireType: i,
        readValueFromPointer: i
      }, {
        ignoreDuplicateRegistrations: !0
      })
    },
    We = (r, t, e, n) => {
      if (!(n > 0)) return 0;
      for (var i = e, s = e + n - 1, l = 0; l < r.length; ++l) {
        var c = r.codePointAt(l);
        if (c <= 127) {
          if (e >= s) break;
          t[e++] = c
        } else if (c <= 2047) {
          if (e + 1 >= s) break;
          t[e++] = 192 | c >> 6, t[e++] = 128 | c & 63
        } else if (c <= 65535) {
          if (e + 2 >= s) break;
          t[e++] = 224 | c >> 12, t[e++] = 128 | c >> 6 & 63, t[e++] = 128 | c & 63
        } else {
          if (e + 3 >= s) break;
          t[e++] = 240 | c >> 18, t[e++] = 128 | c >> 12 & 63, t[e++] = 128 | c >> 6 & 63, t[e++] = 128 | c & 63, l++
        }
      }
      return t[e] = 0, e - i
    },
    ir = (r, t, e) => We(r, z, t, e),
    ct = r => {
      for (var t = 0, e = 0; e < r.length; ++e) {
        var n = r.charCodeAt(e);
        n <= 127 ? t++ : n <= 2047 ? t += 2 : n >= 55296 && n <= 57343 ? (t += 4, ++e) : t += 3
      }
      return t
    },
    Fe = (r, t) => {
      t = P(t), j(r, {
        name: t,
        fromWireType(e) {
          var n = _[e >> 2],
            i = e + 4,
            s;
          return s = Kt(i, n, !0), Z(e), s
        },
        toWireType(e, n) {
          n instanceof ArrayBuffer && (n = new Uint8Array(n));
          var i, s = typeof n == "string";
          s || ArrayBuffer.isView(n) && n.BYTES_PER_ELEMENT == 1 || B("Cannot pass non-string to std::string"), i = s ? ct(n) : n.length;
          var l = kr(4 + i + 1),
            c = l + 4;
          return _[l >> 2] = i, s ? ir(n, c, i + 1) : z.set(n, c), e !== null && e.push(Z, l), l
        },
        readValueFromPointer: Rr,
        destructorFunction(e) {
          Z(e)
        }
      })
    },
    ft = globalThis.TextDecoder ? new TextDecoder("utf-16le") : void 0,
    $e = (r, t, e) => {
      var n = r >> 1,
        i = et(sr, n, t / 2, e);
      if (i - n > 16 && ft) return ft.decode(sr.subarray(n, i));
      for (var s = "", l = n; l < i; ++l) {
        var c = sr[l];
        s += String.fromCharCode(c)
      }
      return s
    },
    Se = (r, t, e) => {
      if (e != null || (e = 2147483647), e < 2) return 0;
      e -= 2;
      for (var n = t, i = e < r.length * 2 ? e / 2 : r.length, s = 0; s < i; ++s) {
        var l = r.charCodeAt(s);
        yr[t >> 1] = l, t += 2
      }
      return yr[t >> 1] = 0, t - n
    },
    Pe = r => r.length * 2,
    Qe = (r, t, e) => {
      for (var n = "", i = r >> 2, s = 0; !(s >= t / 4); s++) {
        var l = _[i + s];
        if (!l && !e) break;
        n += String.fromCodePoint(l)
      }
      return n
    },
    Be = (r, t, e) => {
      if (e != null || (e = 2147483647), e < 4) return 0;
      for (var n = t, i = n + e - 4, s = 0; s < r.length; ++s) {
        var l = r.codePointAt(s);
        if (l > 65535 && s++, or[t >> 2] = l, t += 4, t + 4 > i) break
      }
      return or[t >> 2] = 0, t - n
    },
    Oe = r => {
      for (var t = 0, e = 0; e < r.length; ++e) r.codePointAt(e) > 65535 && e++, t += 4;
      return t
    },
    qe = (r, t, e) => {
      e = P(e);
      var n, i, s;
      t === 2 ? (n = $e, i = Se, s = Pe) : (n = Qe, i = Be, s = Oe), j(r, {
        name: e,
        fromWireType: l => {
          var c = _[l >> 2],
            f = n(l + 4, c * t, !0);
          return Z(l), f
        },
        toWireType: (l, c) => {
          typeof c != "string" && B(`Cannot pass non-string to C++ string type ${e}`);
          var f = s(c),
            h = kr(4 + f + t);
          return _[h >> 2] = f / t, i(c, h + 4, f + t), l !== null && l.push(Z, h), h
        },
        readValueFromPointer: Rr,
        destructorFunction(l) {
          Z(l)
        }
      })
    },
    Ue = (r, t, e, n, i, s) => {
      Ar[r] = {
        name: P(t),
        rawConstructor: ur(e, n),
        rawDestructor: ur(i, s),
        fields: []
      }
    },
    ze = (r, t, e, n, i, s, l, c, f, h) => {
      Ar[r].fields.push({
        fieldName: P(t),
        getterReturnType: e,
        getter: ur(n, i),
        getterContext: s,
        setterArgumentType: l,
        setter: ur(c, f),
        setterContext: h
      })
    },
    ke = (r, t) => {
      t = P(t), j(r, {
        isVoid: !0,
        name: t,
        fromWireType: () => {},
        toWireType: (e, n) => {}
      })
    },
    Ur = [],
    je = r => {
      var t = Ur.length;
      return Ur.push(r), t
    },
    Ne = (r, t) => {
      var e = J[r];
      return e === void 0 && B(`${t} has unknown type ${lt(r)}`), e
    },
    Le = (r, t) => {
      for (var e = Array(r), n = 0; n < r; ++n) e[n] = Ne(_[t + n * 4 >> 2], `parameter ${n}`);
      return e
    },
    He = (r, t, e) => {
      var n = [],
        i = r(n, e);
      return n.length && (_[t >> 2] = N.toHandle(n)), i
    },
    Ve = {},
    dt = r => {
      var t = Ve[r];
      return t === void 0 ? P(r) : t
    },
    Ge = (r, t, e) => {
      var n = 8,
        [i, ...s] = Le(r, t),
        l = i.toWireType.bind(i),
        c = s.map(h => h.readValueFromPointer.bind(h));
      r--;
      var f = Array(r);
      return je(st(`methodCaller<(${s.map(h=>h.name)}) => ${i.name}>`, (h, m, E, D) => {
        for (var W = 0, M = 0; M < r; ++M) f[M] = c[M](D + W), W += n;
        var F;
        switch (e) {
          case 0:
            F = N.toValue(h).apply(null, f);
            break;
          case 2:
            F = Reflect.construct(N.toValue(h), f);
            break;
          case 3:
            F = f[0];
            break;
          case 1:
            F = N.toValue(h)[dt(m)](...f);
            break
        }
        return He(l, E, F)
      }))
    },
    Ze = r => r ? (r = dt(r), N.toHandle(globalThis[r])) : N.toHandle(globalThis),
    Xe = r => {
      r > 9 && (rr[r + 1] += 1)
    },
    Ye = (r, t, e, n, i) => Ur[r](t, e, n, i),
    Ke = r => {
      Or(N.toValue(r)), qr(r)
    },
    Je = (r, t, e, n) => {
      var i = new Date().getFullYear(),
        s = new Date(i, 0, 1),
        l = new Date(i, 6, 1),
        c = s.getTimezoneOffset(),
        f = l.getTimezoneOffset(),
        h = Math.max(c, f);
      _[r >> 2] = h * 60, or[t >> 2] = +(c != f);
      var m = W => {
          var M = W >= 0 ? "-" : "+",
            F = Math.abs(W);
          return `UTC${M}${String(Math.floor(F/60)).padStart(2,"0")}${String(F%60).padStart(2,"0")}`
        },
        E = m(c),
        D = m(f);
      f < c ? (ir(E, e, 17), ir(D, n, 17)) : (ir(E, n, 17), ir(D, e, 17))
    },
    rn = () => 2147483648,
    tn = (r, t) => Math.ceil(r / t) * t,
    en = r => {
      var t = (r - Tr.buffer.byteLength + 65535) / 65536 | 0;
      try {
        return Tr.grow(t), wr(), 1
      } catch {}
    },
    nn = r => {
      var t = z.length;
      r >>>= 0;
      var e = rn();
      if (r > e) return !1;
      for (var n = 1; n <= 4; n *= 2) {
        var i = t * (1 + .2 / n);
        if (i = Math.min(i, r + 100663296), en(Math.min(e, tn(Math.max(r, i), 65536)))) return !0
      }
      return !1
    },
    zr = {},
    an = () => y || "./this.program",
    lr = () => {
      if (!lr.strings) {
        var r, t, e = {
          USER: "web_user",
          LOGNAME: "web_user",
          PATH: "/",
          PWD: "/",
          HOME: "/home/web_user",
          LANG: ((r = (t = globalThis.navigator) == null ? void 0 : t.language) == null ? "C" : r).replace("-", "_") + ".UTF-8",
          _: an()
        };
        for (var n in zr) zr[n] === void 0 ? delete e[n] : e[n] = zr[n];
        var i = [];
        for (var n in e) i.push(`${n}=${e[n]}`);
        lr.strings = i
      }
      return lr.strings
    },
    on = (r, t) => {
      var e = 0,
        n = 0;
      for (var i of lr()) {
        var s = t + e;
        _[r + n >> 2] = s, e += ir(i, s, 1 / 0) + 1, n += 4
      }
      return 0
    },
    sn = (r, t) => {
      var e = lr();
      _[r >> 2] = e.length;
      var n = 0;
      for (var i of e) n += ct(i) + 1;
      return _[t >> 2] = n, 0
    },
    un = r => 52,
    ln = (r, t, e, n) => 52;

  function cn(r, t, e, n, i) {
    return 70
  }
  var fn = [null, [],
      []
    ],
    dn = (r, t) => {
      var e = fn[r];
      t === 0 || t === 10 ? ((r === 1 ? hr : G)(nt(e)), e.length = 0) : e.push(t)
    },
    hn = (r, t, e, n) => {
      for (var i = 0, s = 0; s < e; s++) {
        var l = _[t >> 2],
          c = _[t + 4 >> 2];
        t += 8;
        for (var f = 0; f < c; f++) dn(r, z[l + f]);
        i += c
      }
      return _[n >> 2] = i, 0
    },
    pn = r => r;
  if (u.noExitRuntime && u.noExitRuntime, u.print && (hr = u.print), u.printErr && (G = u.printErr), u.wasmBinary && (U = u.wasmBinary), u.arguments && u.arguments, u.thisProgram && (y = u.thisProgram), u.preInit)
    for (typeof u.preInit == "function" && (u.preInit = [u.preInit]); u.preInit.length > 0;) u.preInit.shift()();
  var ht, kr, Z, b, pt, gt, wt, mt, jr, yt, vt, _t, Tr, bt;

  function gn(r) {
    ht = r.pa, kr = u._malloc = r.ra, Z = u._free = r.sa, b = r.ta, pt = r.ua, gt = r.va, wt = r.wa, mt = r.xa, jr = r.ya, yt = r.za, vt = r.Aa, tr.jiji = r.Ba, tr.viijii = r.Ca, _t = tr.jiiii = r.Da, tr.iiiiij = r.Ea, tr.iiiiijj = r.Fa, tr.iiiiiijj = r.Ga, Tr = r.na, bt = r.qa
  }
  var wn = {
    t: jt,
    u: Nt,
    a: Lt,
    g: Ht,
    v: Vt,
    _: Gt,
    p: Zt,
    Z: Xt,
    e: Yt,
    L: Jt,
    da: re,
    ba: te,
    ea: ee,
    aa: ne,
    U: ae,
    ka: oe,
    T: se,
    ia: ce,
    ga: de,
    M: pe,
    N: xe,
    s: Me,
    n: De,
    ha: Fe,
    E: qe,
    F: Ue,
    la: ze,
    ja: ke,
    C: Ge,
    ma: qr,
    Q: Ze,
    G: Xe,
    A: Ye,
    W: Ke,
    V: Je,
    $: nn,
    X: on,
    Y: sn,
    J: un,
    ca: ln,
    S: cn,
    K: hn,
    H: Pn,
    O: Tn,
    I: Sn,
    l: Qn,
    b: Rn,
    c: bn,
    f: Cn,
    j: Mn,
    D: Dn,
    r: Fn,
    B: $n,
    x: On,
    R: Un,
    k: An,
    i: mn,
    d: vn,
    h: _n,
    o: yn,
    y: Wn,
    z: xn,
    q: Bn,
    fa: In,
    m: En,
    w: qn,
    P: pn
  };

  function mn(r, t) {
    var e = T();
    try {
      A(r)(t)
    } catch (n) {
      if (C(e), n !== n + 0) throw n;
      b(1, 0)
    }
  }

  function yn(r, t, e, n, i) {
    var s = T();
    try {
      A(r)(t, e, n, i)
    } catch (l) {
      if (C(s), l !== l + 0) throw l;
      b(1, 0)
    }
  }

  function vn(r, t, e) {
    var n = T();
    try {
      A(r)(t, e)
    } catch (i) {
      if (C(n), i !== i + 0) throw i;
      b(1, 0)
    }
  }

  function _n(r, t, e, n) {
    var i = T();
    try {
      A(r)(t, e, n)
    } catch (s) {
      if (C(i), s !== s + 0) throw s;
      b(1, 0)
    }
  }

  function bn(r, t, e) {
    var n = T();
    try {
      return A(r)(t, e)
    } catch (i) {
      if (C(n), i !== i + 0) throw i;
      b(1, 0)
    }
  }

  function An(r) {
    var t = T();
    try {
      A(r)()
    } catch (e) {
      if (C(t), e !== e + 0) throw e;
      b(1, 0)
    }
  }

  function Rn(r, t) {
    var e = T();
    try {
      return A(r)(t)
    } catch (n) {
      if (C(e), n !== n + 0) throw n;
      b(1, 0)
    }
  }

  function Cn(r, t, e, n) {
    var i = T();
    try {
      return A(r)(t, e, n)
    } catch (s) {
      if (C(i), s !== s + 0) throw s;
      b(1, 0)
    }
  }

  function Tn(r, t, e, n, i, s) {
    var l = T();
    try {
      return A(r)(t, e, n, i, s)
    } catch (c) {
      if (C(l), c !== c + 0) throw c;
      b(1, 0)
    }
  }

  function En(r, t, e, n, i, s, l, c, f, h, m) {
    var E = T();
    try {
      A(r)(t, e, n, i, s, l, c, f, h, m)
    } catch (D) {
      if (C(E), D !== D + 0) throw D;
      b(1, 0)
    }
  }

  function xn(r, t, e, n, i, s, l) {
    var c = T();
    try {
      A(r)(t, e, n, i, s, l)
    } catch (f) {
      if (C(c), f !== f + 0) throw f;
      b(1, 0)
    }
  }

  function In(r, t, e, n, i, s, l, c, f) {
    var h = T();
    try {
      A(r)(t, e, n, i, s, l, c, f)
    } catch (m) {
      if (C(h), m !== m + 0) throw m;
      b(1, 0)
    }
  }

  function Mn(r, t, e, n, i) {
    var s = T();
    try {
      return A(r)(t, e, n, i)
    } catch (l) {
      if (C(s), l !== l + 0) throw l;
      b(1, 0)
    }
  }

  function Dn(r, t, e, n, i, s) {
    var l = T();
    try {
      return A(r)(t, e, n, i, s)
    } catch (c) {
      if (C(l), c !== c + 0) throw c;
      b(1, 0)
    }
  }

  function Wn(r, t, e, n, i, s) {
    var l = T();
    try {
      A(r)(t, e, n, i, s)
    } catch (c) {
      if (C(l), c !== c + 0) throw c;
      b(1, 0)
    }
  }

  function Fn(r, t, e, n, i, s, l) {
    var c = T();
    try {
      return A(r)(t, e, n, i, s, l)
    } catch (f) {
      if (C(c), f !== f + 0) throw f;
      b(1, 0)
    }
  }

  function $n(r, t, e, n, i, s, l, c) {
    var f = T();
    try {
      return A(r)(t, e, n, i, s, l, c)
    } catch (h) {
      if (C(f), h !== h + 0) throw h;
      b(1, 0)
    }
  }

  function Sn(r, t, e, n) {
    var i = T();
    try {
      return A(r)(t, e, n)
    } catch (s) {
      if (C(i), s !== s + 0) throw s;
      b(1, 0)
    }
  }

  function Pn(r, t, e, n) {
    var i = T();
    try {
      return A(r)(t, e, n)
    } catch (s) {
      if (C(i), s !== s + 0) throw s;
      b(1, 0)
    }
  }

  function Qn(r) {
    var t = T();
    try {
      return A(r)()
    } catch (e) {
      if (C(t), e !== e + 0) throw e;
      b(1, 0)
    }
  }

  function Bn(r, t, e, n, i, s, l, c) {
    var f = T();
    try {
      A(r)(t, e, n, i, s, l, c)
    } catch (h) {
      if (C(f), h !== h + 0) throw h;
      b(1, 0)
    }
  }

  function On(r, t, e, n, i, s, l, c, f, h, m, E) {
    var D = T();
    try {
      return A(r)(t, e, n, i, s, l, c, f, h, m, E)
    } catch (W) {
      if (C(D), W !== W + 0) throw W;
      b(1, 0)
    }
  }

  function qn(r, t, e, n, i, s, l, c, f, h, m, E, D, W, M, F) {
    var cr = T();
    try {
      A(r)(t, e, n, i, s, l, c, f, h, m, E, D, W, M, F)
    } catch (L) {
      if (C(cr), L !== L + 0) throw L;
      b(1, 0)
    }
  }

  function Un(r, t, e, n, i) {
    var s = T();
    try {
      return _t(r, t, e, n, i)
    } catch (l) {
      if (C(s), l !== l + 0) throw l;
      b(1, 0)
    }
  }

  function zn() {
    Wt();

    function r() {
      var t, e;
      u.calledRun = !0, !nr && (Ft(), (t = pr) == null || t(u), (e = u.onRuntimeInitialized) == null || e.call(u), $t())
    }
    u.setStatus ? (u.setStatus("Running..."), setTimeout(() => {
      setTimeout(() => u.setStatus(""), 1), r()
    }, 1)) : r()
  }
  var Er = await Ut();
  return zn(), o = gr ? u : new Promise((r, t) => {
    pr = r, Y = t
  }), o
}

function aa(a) {
  return Mt(Dt, a)
}
async function ia(a, o) {
  return na(Dt, a, o)
}
var oa = "" + new URL(__RQR_WASM_URL("zxing_writer-NQHybxPU.wasm"), import.meta.url).href;
const sa = [
    [1, 26, 19],
    [1, 26, 16],
    [1, 26, 13],
    [1, 26, 9],
    [1, 44, 34],
    [1, 44, 28],
    [1, 44, 22],
    [1, 44, 16],
    [1, 70, 55],
    [1, 70, 44],
    [2, 35, 17],
    [2, 35, 13],
    [1, 100, 80],
    [2, 50, 32],
    [2, 50, 24],
    [4, 25, 9],
    [1, 134, 108],
    [2, 67, 43],
    [2, 33, 15, 2, 34, 16],
    [2, 33, 11, 2, 34, 12],
    [2, 86, 68],
    [4, 43, 27],
    [4, 43, 19],
    [4, 43, 15],
    [2, 98, 78],
    [4, 49, 31],
    [2, 32, 14, 4, 33, 15],
    [4, 39, 13, 1, 40, 14],
    [2, 121, 97],
    [2, 60, 38, 2, 61, 39],
    [4, 40, 18, 2, 41, 19],
    [4, 40, 14, 2, 41, 15],
    [2, 146, 116],
    [3, 58, 36, 2, 59, 37],
    [4, 36, 16, 4, 37, 17],
    [4, 36, 12, 4, 37, 13],
    [2, 86, 68, 2, 87, 69],
    [4, 69, 43, 1, 70, 44],
    [6, 43, 19, 2, 44, 20],
    [6, 43, 15, 2, 44, 16],
    [4, 101, 81],
    [1, 80, 50, 4, 81, 51],
    [4, 50, 22, 4, 51, 23],
    [3, 36, 12, 8, 37, 13],
    [2, 116, 92, 2, 117, 93],
    [6, 58, 36, 2, 59, 37],
    [4, 46, 20, 6, 47, 21],
    [7, 42, 14, 4, 43, 15],
    [4, 133, 107],
    [8, 59, 37, 1, 60, 38],
    [8, 44, 20, 4, 45, 21],
    [12, 33, 11, 4, 34, 12],
    [3, 145, 115, 1, 146, 116],
    [4, 64, 40, 5, 65, 41],
    [11, 36, 16, 5, 37, 17],
    [11, 36, 12, 5, 37, 13],
    [5, 109, 87, 1, 110, 88],
    [5, 65, 41, 5, 66, 42],
    [5, 54, 24, 7, 55, 25],
    [11, 36, 12, 7, 37, 13],
    [5, 122, 98, 1, 123, 99],
    [7, 73, 45, 3, 74, 46],
    [15, 43, 19, 2, 44, 20],
    [3, 45, 15, 13, 46, 16],
    [1, 135, 107, 5, 136, 108],
    [10, 74, 46, 1, 75, 47],
    [1, 50, 22, 15, 51, 23],
    [2, 42, 14, 17, 43, 15],
    [5, 150, 120, 1, 151, 121],
    [9, 69, 43, 4, 70, 44],
    [17, 50, 22, 1, 51, 23],
    [2, 42, 14, 19, 43, 15],
    [3, 141, 113, 4, 142, 114],
    [3, 70, 44, 11, 71, 45],
    [17, 47, 21, 4, 48, 22],
    [9, 39, 13, 16, 40, 14],
    [3, 135, 107, 5, 136, 108],
    [3, 67, 41, 13, 68, 42],
    [15, 54, 24, 5, 55, 25],
    [15, 43, 15, 10, 44, 16],
    [4, 144, 116, 4, 145, 117],
    [17, 68, 42],
    [17, 50, 22, 6, 51, 23],
    [19, 46, 16, 6, 47, 17],
    [2, 139, 111, 7, 140, 112],
    [17, 74, 46],
    [7, 54, 24, 16, 55, 25],
    [34, 37, 13],
    [4, 151, 121, 5, 152, 122],
    [4, 75, 47, 14, 76, 48],
    [11, 54, 24, 14, 55, 25],
    [16, 45, 15, 14, 46, 16],
    [6, 147, 117, 4, 148, 118],
    [6, 73, 45, 14, 74, 46],
    [11, 54, 24, 16, 55, 25],
    [30, 46, 16, 2, 47, 17],
    [8, 132, 106, 4, 133, 107],
    [8, 75, 47, 13, 76, 48],
    [7, 54, 24, 22, 55, 25],
    [22, 45, 15, 13, 46, 16],
    [10, 142, 114, 2, 143, 115],
    [19, 74, 46, 4, 75, 47],
    [28, 50, 22, 6, 51, 23],
    [33, 46, 16, 4, 47, 17],
    [8, 152, 122, 4, 153, 123],
    [22, 73, 45, 3, 74, 46],
    [8, 53, 23, 26, 54, 24],
    [12, 45, 15, 28, 46, 16],
    [3, 147, 117, 10, 148, 118],
    [3, 73, 45, 23, 74, 46],
    [4, 54, 24, 31, 55, 25],
    [11, 45, 15, 31, 46, 16],
    [7, 146, 116, 7, 147, 117],
    [21, 73, 45, 7, 74, 46],
    [1, 53, 23, 37, 54, 24],
    [19, 45, 15, 26, 46, 16],
    [5, 145, 115, 10, 146, 116],
    [19, 75, 47, 10, 76, 48],
    [15, 54, 24, 25, 55, 25],
    [23, 45, 15, 25, 46, 16],
    [13, 145, 115, 3, 146, 116],
    [2, 74, 46, 29, 75, 47],
    [42, 54, 24, 1, 55, 25],
    [23, 45, 15, 28, 46, 16],
    [17, 145, 115],
    [10, 74, 46, 23, 75, 47],
    [10, 54, 24, 35, 55, 25],
    [19, 45, 15, 35, 46, 16],
    [17, 145, 115, 1, 146, 116],
    [14, 74, 46, 21, 75, 47],
    [29, 54, 24, 19, 55, 25],
    [11, 45, 15, 46, 46, 16],
    [13, 145, 115, 6, 146, 116],
    [14, 74, 46, 23, 75, 47],
    [44, 54, 24, 7, 55, 25],
    [59, 46, 16, 1, 47, 17],
    [12, 151, 121, 7, 152, 122],
    [12, 75, 47, 26, 76, 48],
    [39, 54, 24, 14, 55, 25],
    [22, 45, 15, 41, 46, 16],
    [6, 151, 121, 14, 152, 122],
    [6, 75, 47, 34, 76, 48],
    [46, 54, 24, 10, 55, 25],
    [2, 45, 15, 64, 46, 16],
    [17, 152, 122, 4, 153, 123],
    [29, 74, 46, 14, 75, 47],
    [49, 54, 24, 10, 55, 25],
    [24, 45, 15, 46, 46, 16],
    [4, 152, 122, 18, 153, 123],
    [13, 74, 46, 32, 75, 47],
    [48, 54, 24, 14, 55, 25],
    [42, 45, 15, 32, 46, 16],
    [20, 147, 117, 4, 148, 118],
    [40, 75, 47, 7, 76, 48],
    [43, 54, 24, 22, 55, 25],
    [10, 45, 15, 67, 46, 16],
    [19, 148, 118, 6, 149, 119],
    [18, 75, 47, 31, 76, 48],
    [34, 54, 24, 34, 55, 25],
    [20, 45, 15, 61, 46, 16]
  ],
  ua = {
    L: 0,
    M: 1,
    Q: 2,
    H: 3
  },
  la = 20;

function ca(a, o) {
  return fa(a, o, la)
}

function fa(a, o, d) {
  const p = da(a, o),
    g = 4 + (a <= 9 ? 8 : 16) + d;
  return Math.max(0, Math.floor((p * 8 - g) / 8))
}

function da(a, o) {
  const d = (a - 1) * 4 + ua[o],
    p = sa[d];
  if (!p) throw new Error(`No RS block table entry for V${a}-${o}`);
  let u = 0;
  for (let g = 0; g < p.length; g += 3) u += p[g] * p[g + 2];
  return u
}
let Gr = null;
async function ha(a, o, d, p) {
  const u = await pa(a, o, d, p),
    g = o * 4 + 17;
  if (u.width === g && u.height === g) return ma(u, p);
  const w = va(o, p);
  if (u.width === w && u.height === w) return wa(u);
  throw new Error(`ZXing QR writer returned ${u.width}x${u.height}, expected ${g}x${g} modules or ${w}x${w} pixels for V${o}-${d} at scale ${p}.`)
}
async function pa(a, o, d, p) {
  ya(o, d, p, a.length), await ga();
  const u = {
      format: "QRCode",
      options: `version=${o},ecLevel=${d}`,
      scale: p,
      addQuietZones: !0,
      addHRT: !1
    },
    g = await ia(a, u);
  if (g.error) throw new Error(`ZXing QR writer failed: ${g.error}`);
  return g.symbol
}

function ga() {
  return Gr || (Gr = Promise.resolve(aa({
    overrides: {
      locateFile: a => a.endsWith(".wasm") ? oa : a
    },
    equalityFn: Object.is,
    fireImmediately: !0
  }))), Gr
}

function wa(a) {
  if (a.data.length !== a.width * a.height) throw new Error(`ZXing QR symbol buffer size mismatch: ${a.data.length} bytes for ${a.width}x${a.height}.`);
  const o = new Uint8ClampedArray(a.width * a.height * 4);
  for (let d = 0; d < a.data.length; d++) {
    const p = a.data[d] === 0 ? 0 : 255,
      u = d * 4;
    o[u] = p, o[u + 1] = p, o[u + 2] = p, o[u + 3] = 255
  }
  return new ImageData(o, a.width, a.height)
}

function ma(a, o) {
  if (a.data.length !== a.width * a.height) throw new Error(`ZXing QR symbol buffer size mismatch: ${a.data.length} bytes for ${a.width}x${a.height}.`);
  const d = 4,
    p = (a.width + d * 2) * o,
    u = new Uint8ClampedArray(p * p * 4);
  u.fill(255);
  for (let g = 0; g < a.height; g++)
    for (let w = 0; w < a.width; w++) {
      if (a.data[g * a.width + w] !== 0) continue;
      const R = (w + d) * o,
        y = (g + d) * o;
      for (let x = 0; x < o; x++) {
        const I = ((y + x) * p + R) * 4;
        for (let S = 0; S < o; S++) {
          const Q = I + S * 4;
          u[Q] = 0, u[Q + 1] = 0, u[Q + 2] = 0, u[Q + 3] = 255
        }
      }
    }
  return new ImageData(u, p, p)
}

function ya(a, o, d, p) {
  if (!Number.isInteger(a) || a < 1 || a > 40) throw new RangeError(`Invalid QR version: ${a}. Must be 1-40.`);
  if (o !== "L" && o !== "M" && o !== "Q" && o !== "H") throw new RangeError(`Invalid QR ECC level: ${o}.`);
  if (!Number.isInteger(d) || d < 1) throw new RangeError(`Invalid QR render scale: ${d}.`);
  if (p !== void 0) {
    const u = ca(a, o);
    if (p > u) throw new Error(`Data too large for ZXing QR writer V${a}-${o}. Maximum ${u} bytes for binary Uint8Array payload, got ${p}.`)
  }
}

function va(a, o) {
  return (a * 4 + 17 + 8) * o
}
const _a = "fast-qr-wasm";

function ba(a) {
  switch (a) {
    case "fast-qr-wasm":
    case "fast_qr_wasm":
    case "fastQrWasm":
      return "fast-qr-wasm";
    case "zxing-wasm":
    case "zxing":
    case "zxingWasm":
      return "zxing-wasm";
    default:
      return _a
  }
}
const Aa = {
  L: 0,
  M: 1,
  Q: 2,
  H: 3
};
let Mr = null;
async function Ra(a, o, d, p, u = "fast-qr-wasm") {
  switch (u) {
    case "fast-qr-wasm":
      return Ta(a, o, d, p);
    case "zxing-wasm":
      return ha(a, o, d, p)
  }
}
async function Ca() {
  Mr || (Mr = Et().then(() => new $r).catch(o => {
    Mr = null;
    const d = o instanceof Error ? o.message : String(o);
    throw new Error(`${Zr()} ${d}`)
  }));
  const a = await Mr;
  if (!a || !xt()) throw new Error(Zr());
  return a
}
async function Ta(a, o, d, p) {
  const u = await Ca(),
    g = Aa[d],
    w = u.render_rgba(a, o, g, p),
    R = w * w * 4,
    y = It(),
    x = u.rgba_ptr(),
    I = new Uint8ClampedArray(y.buffer, x, R),
    S = new Uint8ClampedArray(R);
  return S.set(I), new ImageData(S, w, w)
}
const Ea = {
  L: 0,
  M: 1,
  Q: 2,
  H: 3
};
let Fr = null;
const xa = Et().then(() => (Fr = new $r, Fr)).catch(() => (Fr = null, null));
self.onmessage = a => {
  const o = a.data;
  o.type === "render" && Ia(o)
};
async function Ia(a) {
  try {
    const o = new Uint8Array(a.packet),
      d = ba(a.qrEncoder);
    let p, u, g;
    if (Ma(d)) {
      const w = Fr ?? await xa;
      if (xt() && w !== null) {
        const R = Ea[a.ecc],
          y = w.render_rgba(o, a.version, R, a.scale),
          x = y * y * 4,
          I = It(),
          S = w.rgba_ptr(),
          Q = new Uint8ClampedArray(I.buffer, S, x),
          q = new Uint8ClampedArray(x);
        q.set(Q), p = q.buffer, u = y, g = y
      } else throw new Error(Zr())
    } else {
      const w = await Ra(o, a.version, a.ecc, a.scale, d);
      p = w.data.buffer.slice(w.data.byteOffset, w.data.byteOffset + w.data.byteLength), u = w.width, g = w.height
    }
    self.postMessage({
      type: "rendered",
      buffer: p,
      width: u,
      height: g,
      jobId: a.jobId
    }, {
      transfer: [p]
    })
  } catch (o) {
    self.postMessage({
      type: "error",
      message: o instanceof Error ? o.message : String(o),
      jobId: a.jobId
    })
  }
}

function Ma(a) {
  const o = String(a);
  return o === "fast-qr-wasm" || o === "fast_qr_wasm" || o === "fastQrWasm"
}