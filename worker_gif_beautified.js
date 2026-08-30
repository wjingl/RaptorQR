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
var Y = [
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
  Ln = {
    DataBarExpanded: "DataBarExp",
    DataBarLimited: "DataBarLtd",
    "Linear-Codes": "AllLinear",
    "Matrix-Codes": "AllMatrix",
    Any: "All",
    rMQRCode: "RMQRCode"
  };
Y.map(e => e[5]);
Y.filter(e => e[1] === "*").map(e => e[0]);
Y.filter(e => e[1] !== "*").map(e => e[0]);
Y.filter(e => e[2] === " ").map(e => e[0]);
Y.filter(e => e[3][0] === "l").map(e => e[0]);
Y.filter(e => e[3][0] === "m").map(e => e[0]);
Y.filter(e => e[3][1] === "r").map(e => e[0]);
Y.filter(e => e[3][2] === "w" || e[4] !== 0).map(e => e[0]);
Y.filter(e => e[3][3] === "G").map(e => e[0]);
Y.filter(e => e[3][4] === "R").map(e => e[0]);
Y.filter(e => e[3][4] === "I").map(e => e[0]);

function jn(e) {
  var i;
  return (i = Ln[e]) == null ? e : i
}
var Gn = {
  formats: []
};

function Mr(e) {
  var i;
  return {
    ...e,
    image: (i = e.image && new Blob([e.image], {
      type: "image/png"
    })) == null ? null : i
  }
}
var j = {
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

function Hn(e = j) {
  var i, c;
  let {
    format: l = j.format,
    sizeHint: o = j.sizeHint,
    readerInit: h = j.readerInit,
    forceSquareDataMatrix: w = j.forceSquareDataMatrix,
    ecLevel: m = j.ecLevel,
    withHRT: y,
    withQuietZones: b,
    addHRT: _,
    addQuietZones: A,
    options: $ = j.options,
    scale: q,
    rotate: z = j.rotate,
    invert: B = j.invert
  } = e, P = $.split(",").map(W => W.trim()).filter(Boolean), D = W => {
    let C = W.split("=")[0];
    P.some(S => S.split("=")[0] === C) || P.push(W)
  };
  h && D("readerInit"), w && D("forceSquare"), m && D(`ecLevel=${m}`);
  let H = q ?? (o > 0 ? -Math.trunc(Math.abs(o)) : j.scale);
  return {
    format: jn(l),
    options: P.join(","),
    scale: H,
    rotate: z,
    invert: B,
    addHRT: (i = _ ?? y) == null ? j.addHRT : i,
    addQuietZones: (c = A ?? b) == null ? j.addQuietZones : c
  }
}
var Zn = {
    locateFile: (e, i) => {
      let c = e.match(/_(.+?)\.wasm$/);
      return c ? `https://fastly.jsdelivr.net/npm/zxing-wasm@3.1.0/dist/${c[1]}/${e}` : i + e
    }
  },
  Zt = new WeakMap;

function Xn(e, i) {
  return Object.is(e, i) || Object.keys(e).length === Object.keys(i).length && Object.keys(e).every(c => Object.hasOwn(i, c) && e[c] === i[c])
}

function Pr(e, {
  overrides: i,
  equalityFn: c = Xn,
  fireImmediately: l = !1
} = {}) {
  var o, h;
  let [w, m] = (o = Zt.get(e)) == null ? [Zn] : o, y = i ?? w, b;
  if (l) {
    if (m && (b = c(w, y))) return m;
    let _ = e({
      ...y
    });
    return Zt.set(e, [y, _]), _
  }((h = b) == null ? c(w, y) : h) || Zt.set(e, [y])
}
async function Yn(e, i, c = j) {
  let l = Hn(c),
    o = await Pr(e, {
      fireImmediately: !0
    });
  if (typeof i == "string") return Mr(o.writeBarcodeFromText(i, l));
  let {
    byteLength: h
  } = i, w = o._malloc(h);
  if (!w) throw Error(`Failed to allocate ${h} bytes in WASM memory`);
  try {
    return o.HEAPU8.set(i, w), Mr(o.writeBarcodeFromBytes(w, h, l))
  } finally {
    o._free(w)
  }
} [...Gn.formats];
({
  ...j
});
async function Wr(e = {}) {
  var i, c, l, o = e,
    h = !!globalThis.window,
    w = typeof Bun < "u",
    m = !!globalThis.WorkerGlobalScope;
  !((c = globalThis.process) == null || (c = c.versions) == null) && c.node && ((l = globalThis.process) == null || l.type);
  var y = "./this.program",
    b, _ = "";

  function A(t) {
    return o.locateFile ? o.locateFile(t, _) : _ + t
  }
  var $, q;
  if (h || m || w) {
    try {
      _ = new URL(".", b).href
    } catch {}
    m && (q = t => {
      var r = new XMLHttpRequest;
      return r.open("GET", t, !1), r.responseType = "arraybuffer", r.send(null), new Uint8Array(r.response)
    }), $ = async t => {
      var r = await fetch(t, {
        credentials: "same-origin"
      });
      if (r.ok) return r.arrayBuffer();
      throw Error(r.status + " : " + r.url)
    }
  }
  var z = console.log.bind(console),
    B = console.error.bind(console),
    P, D = !1,
    H, W, C = !1;

  function S() {
    var t = Ft.buffer;
    ct = new Int8Array(t), xt = new Int16Array(t), o.HEAPU8 = tt = new Uint8Array(t), vt = new Uint16Array(t), yt = new Int32Array(t), E = new Uint32Array(t), nr = new Float32Array(t), ar = new Float64Array(t)
  }

  function V() {
    if (o.preRun)
      for (typeof o.preRun == "function" && (o.preRun = [o.preRun]); o.preRun.length;) Lr(o.preRun.shift());
    ir(sr)
  }

  function J() {
    C = !0, $t.oa()
  }

  function Z() {
    if (o.postRun)
      for (typeof o.postRun == "function" && (o.postRun = [o.postRun]); o.postRun.length;) Nr(o.postRun.shift());
    ir(or)
  }

  function U(t) {
    var r, n;
    (r = o.onAbort) == null || r.call(o, t), t = "Aborted(" + t + ")", B(t), D = !0, t += ". Build with -sASSERTIONS for more info.";
    var a = new WebAssembly.RuntimeError(t);
    throw (n = W) == null || n(a), a
  }
  var K;

  function mt() {
    return A("zxing_writer.wasm")
  }

  function N(t) {
    if (t == K && P) return new Uint8Array(P);
    if (q) return q(t);
    throw "both async and sync fetching of the wasm failed"
  }
  async function zt(t) {
    if (!P) try {
      var r = await $(t);
      return new Uint8Array(r)
    } catch {}
    return N(t)
  }
  async function zr(t, r) {
    try {
      var n = await zt(t);
      return await WebAssembly.instantiate(n, r)
    } catch (a) {
      B(`failed to asynchronously prepare wasm: ${a}`), U(a)
    }
  }
  async function Ur(t, r, n) {
    if (!t && WebAssembly.instantiateStreaming) try {
      var a = fetch(r, {
        credentials: "same-origin"
      });
      return await WebAssembly.instantiateStreaming(a, n)
    } catch (s) {
      B(`wasm streaming compile failed: ${s}`), B("falling back to ArrayBuffer instantiation")
    }
    return zr(r, n)
  }

  function kr() {
    return {
      a: vn
    }
  }
  async function Vr() {
    function t(a, s) {
      return $t = a.exports, yn($t), S(), $t
    }

    function r(a) {
      return t(a.instance)
    }
    var n = kr();
    return o.instantiateWasm ? new Promise((a, s) => {
      o.instantiateWasm(n, (u, f) => {
        a(t(u))
      })
    }) : (K != null || (K = mt()), r(await Ur(P, K, n)))
  }
  var xt, yt, ct, nr, ar, vt, E, tt, ir = t => {
      for (; t.length > 0;) t.shift()(o)
    },
    or = [],
    Nr = t => or.push(t),
    sr = [],
    Lr = t => sr.push(t),
    I = t => Ar(t),
    M = () => Rr(),
    Ct = [],
    Tt = 0,
    jr = t => {
      var r = new Ut(t);
      return r.get_caught() || (r.set_caught(!0), Tt--), r.set_rethrown(!1), Ct.push(r), Cr(t)
    },
    rt = 0,
    Gr = () => {
      x(0, 0);
      var t = Ct.pop();
      Er(t.excPtr), rt = 0
    };
  class Ut {
    constructor(r) {
      this.excPtr = r, this.ptr = r - 24
    }
    set_type(r) {
      E[this.ptr + 4 >> 2] = r
    }
    get_type() {
      return E[this.ptr + 4 >> 2]
    }
    set_destructor(r) {
      E[this.ptr + 8 >> 2] = r
    }
    get_destructor() {
      return E[this.ptr + 8 >> 2]
    }
    set_caught(r) {
      r = +!!r, ct[this.ptr + 12] = r
    }
    get_caught() {
      return ct[this.ptr + 12] != 0
    }
    set_rethrown(r) {
      r = +!!r, ct[this.ptr + 13] = r
    }
    get_rethrown() {
      return ct[this.ptr + 13] != 0
    }
    init(r, n) {
      this.set_adjusted_ptr(0), this.set_type(r), this.set_destructor(n)
    }
    set_adjusted_ptr(r) {
      E[this.ptr + 16 >> 2] = r
    }
    get_adjusted_ptr() {
      return E[this.ptr + 16 >> 2]
    }
  }
  var It = t => br(t),
    kt = t => {
      var r = rt;
      if (!r) return It(0), 0;
      var n = new Ut(r);
      n.set_adjusted_ptr(r);
      var a = n.get_type();
      if (!a) return It(0), r;
      for (var s of t) {
        if (s === 0 || s === a) break;
        var u = n.ptr + 16;
        if (xr(s, a, u)) return It(s), r
      }
      return It(a), r
    },
    Hr = () => kt([]),
    Zr = t => kt([t]),
    Xr = (t, r) => kt([t, r]),
    Yr = () => {
      var t = Ct.pop();
      t || U("no exception to throw");
      var r = t.excPtr;
      throw t.get_rethrown() || (Ct.push(t), t.set_rethrown(!0), t.set_caught(!1), Tt++), Ht(r), rt = r, rt
    },
    Kr = (t, r, n) => {
      throw new Ut(t).init(r, n), Ht(t), rt = t, Tt++, rt
    },
    Jr = () => Tt,
    te = t => {
      throw rt || (rt = t), rt
    },
    ur = globalThis.TextDecoder && new TextDecoder,
    lr = (t, r, n, a) => {
      var s = r + n;
      if (a) return s;
      for (; t[r] && !(r >= s);) ++r;
      return r
    },
    cr = function(t) {
      let r = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : 0,
        n = arguments.length > 2 ? arguments[2] : void 0,
        a = arguments.length > 3 ? arguments[3] : void 0;
      var s = lr(t, r, n, a);
      if (s - r > 16 && t.buffer && ur) return ur.decode(t.subarray(r, s));
      for (var u = ""; r < s;) {
        var f = t[r++];
        if (!(f & 128)) {
          u += String.fromCharCode(f);
          continue
        }
        var d = t[r++] & 63;
        if ((f & 224) == 192) {
          u += String.fromCharCode((f & 31) << 6 | d);
          continue
        }
        var g = t[r++] & 63;
        if (f = (f & 240) == 224 ? (f & 15) << 12 | d << 6 | g : (f & 7) << 18 | d << 12 | g << 6 | t[r++] & 63, f < 65536) u += String.fromCharCode(f);
        else {
          var p = f - 65536;
          u += String.fromCharCode(55296 | p >> 10, 56320 | p & 1023)
        }
      }
      return u
    },
    re = (t, r, n) => t ? cr(tt, t, r, n) : "";

  function ee(t, r, n) {
    return 0
  }

  function ne(t, r, n) {
    return 0
  }
  var ae = (t, r, n) => {};

  function ie(t, r, n, a) {}
  var oe = (t, r) => {},
    se = () => U(""),
    Mt = {},
    Vt = t => {
      for (; t.length;) {
        var r = t.pop();
        t.pop()(r)
      }
    };

  function Bt(t) {
    return this.fromWireType(E[t >> 2])
  }
  var gt = {},
    ft = {},
    Dt = {},
    ue = class extends Error {
      constructor(t) {
        super(t), this.name = "InternalError"
      }
    },
    fr = t => {
      throw new ue(t)
    },
    dr = (t, r, n) => {
      t.forEach(d => Dt[d] = r);

      function a(d) {
        var g = n(d);
        g.length !== t.length && fr("Mismatched type converter count");
        for (var p = 0; p < t.length; ++p) et(t[p], g[p])
      }
      var s = Array(r.length),
        u = [],
        f = 0;
      {
        let d = r;
        for (let g = 0; g < d.length; ++g) {
          let p = d[g];
          ft.hasOwnProperty(p) ? s[g] = ft[p] : (u.push(p), gt.hasOwnProperty(p) || (gt[p] = []), gt[p].push(() => {
            s[g] = ft[p], ++f, f === u.length && a(s)
          }))
        }
      }
      u.length === 0 && a(s)
    },
    le = t => {
      var r = Mt[t];
      delete Mt[t];
      var n = r.rawConstructor,
        a = r.rawDestructor,
        s = r.fields,
        u = s.map(f => f.getterReturnType).concat(s.map(f => f.setterArgumentType));
      dr([t], u, f => {
        var d = {};
        {
          let g = s;
          for (let p = 0; p < g.length; ++p) {
            let v = g[p],
              F = f[p],
              O = v.getter,
              k = v.getterContext,
              Q = f[p + s.length],
              L = v.setter,
              At = v.setterContext;
            d[v.fieldName] = {
              read: at => F.fromWireType(O(k, at)),
              write: (at, ut) => {
                var St = [];
                L(At, at, Q.toWireType(St, ut)), Vt(St)
              },
              optional: F.optional
            }
          }
        }
        return [{
          name: r.name,
          fromWireType: g => {
            var p = {};
            for (var v in d) p[v] = d[v].read(g);
            return a(g), p
          },
          toWireType: (g, p) => {
            for (var v in d)
              if (!(v in p) && !d[v].optional) throw TypeError(`Missing field: "${v}"`);
            var F = n();
            for (v in d) d[v].write(F, p[v]);
            return g !== null && g.push(a, F), F
          },
          readValueFromPointer: Bt,
          destructorFunction: a
        }]
      })
    },
    ce = (t, r, n, a, s) => {},
    G = t => {
      for (var r = "";;) {
        var n = tt[t++];
        if (!n) return r;
        r += String.fromCharCode(n)
      }
    },
    fe = class extends Error {
      constructor(t) {
        super(t), this.name = "BindingError"
      }
    },
    X = t => {
      throw new fe(t)
    };

  function de(t, r) {
    let n = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : {};
    var a = r.name;
    if (t || X(`type "${a}" must have a positive integer typeid pointer`), ft.hasOwnProperty(t)) {
      if (n.ignoreDuplicateRegistrations) return;
      X(`Cannot register type '${a}' twice`)
    }
    if (ft[t] = r, delete Dt[t], gt.hasOwnProperty(t)) {
      var s = gt[t];
      delete gt[t], s.forEach(u => u())
    }
  }

  function et(t, r) {
    return de(t, r, arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : {})
  }
  var he = (t, r, n, a) => {
      r = G(r), et(t, {
        name: r,
        fromWireType: function(s) {
          return !!s
        },
        toWireType: function(s, u) {
          return u ? n : a
        },
        readValueFromPointer: function(s) {
          return this.fromWireType(tt[s])
        },
        destructorFunction: null
      })
    },
    hr = [],
    dt = [0, 1, , 1, null, 1, !0, 1, !1, 1],
    Nt = t => {
      t > 9 && --dt[t + 1] === 0 && (dt[t] = void 0, hr.push(t))
    },
    nt = {
      toValue: t => (t || X(`Cannot use deleted val. handle = ${t}`), dt[t]),
      toHandle: t => {
        switch (t) {
          case void 0:
            return 2;
          case null:
            return 4;
          case !0:
            return 6;
          case !1:
            return 8;
          default: {
            let r = hr.pop() || dt.length;
            return dt[r] = t, dt[r + 1] = 1, r
          }
        }
      }
    },
    we = {
      name: "emscripten::val",
      fromWireType: t => {
        var r = nt.toValue(t);
        return Nt(t), r
      },
      toWireType: (t, r) => nt.toHandle(r),
      readValueFromPointer: Bt,
      destructorFunction: null
    },
    ge = t => et(t, we),
    pe = (t, r) => {
      switch (r) {
        case 4:
          return function(n) {
            return this.fromWireType(nr[n >> 2])
          };
        case 8:
          return function(n) {
            return this.fromWireType(ar[n >> 3])
          };
        default:
          throw TypeError(`invalid float width (${r}): ${t}`)
      }
    },
    me = (t, r, n) => {
      r = G(r), et(t, {
        name: r,
        fromWireType: a => a,
        toWireType: (a, s) => s,
        readValueFromPointer: pe(r, n),
        destructorFunction: null
      })
    },
    wr = (t, r) => Object.defineProperty(r, "name", {
      value: t
    });

  function ye(t) {
    for (var r = 1; r < t.length; ++r)
      if (t[r] !== null && t[r].destructorFunction === void 0) return !0;
    return !1
  }

  function ve(t, r, n, a, s, u) {
    var f = r.length;
    f < 2 && X("argTypes array size mismatch! Must at least get return value and 'this' types!"), r[1];
    var d = ye(r),
      g = !r[0].isVoid,
      p = f - 2,
      v = Array(p),
      F = [],
      O = [];
    return wr(t, function() {
      O.length = 0;
      var k;
      F.length = 1, F[0] = s;
      for (var Q = 0; Q < p; ++Q) v[Q] = r[Q + 2].toWireType(O, Q < 0 || arguments.length <= Q ? void 0 : arguments[Q]), F.push(v[Q]);
      var L = a(...F);

      function At(at) {
        if (d) Vt(O);
        else
          for (var ut = 2; ut < r.length; ut++) {
            var St = ut === 1 ? k : v[ut - 2];
            r[ut].destructorFunction !== null && r[ut].destructorFunction(St)
          }
        if (g) return r[0].fromWireType(at)
      }
      return At(L)
    })
  }
  var _e = (t, r, n) => {
      if (t[r].overloadTable === void 0) {
        var a = t[r];
        t[r] = function() {
          var s = [...arguments];
          return t[r].overloadTable.hasOwnProperty(s.length) || X(`Function '${n}' called with an invalid number of arguments (${s.length}) - expects one of (${t[r].overloadTable})!`), t[r].overloadTable[s.length].apply(this, s)
        }, t[r].overloadTable = [], t[r].overloadTable[a.argCount] = a
      }
    },
    be = (t, r, n) => {
      o.hasOwnProperty(t) ? ((n === void 0 || o[t].overloadTable !== void 0 && o[t].overloadTable[n] !== void 0) && X(`Cannot register public name '${t}' twice`), _e(o, t, t), o[t].overloadTable.hasOwnProperty(n) && X(`Cannot register multiple overloads of a function with the same number of arguments (${n})!`), o[t].overloadTable[n] = r) : (o[t] = r, o[t].argCount = n)
    },
    Ae = (t, r) => {
      for (var n = [], a = 0; a < t; a++) n.push(E[r + a * 4 >> 2]);
      return n
    },
    Re = (t, r, n) => {
      o.hasOwnProperty(t) || fr("Replacing nonexistent public symbol"), o[t].overloadTable !== void 0 && n !== void 0 ? o[t].overloadTable[n] = r : (o[t] = r, o[t].argCount = n)
    },
    ht = {},
    Ee = (t, r, n) => {
      t = t.replace(/p/g, "i");
      var a = ht[t];
      return a(r, ...n)
    },
    gr = [],
    T = t => {
      var r = gr[t];
      return r || (gr[t] = r = Ir.get(t)), r
    },
    xe = function(t, r) {
      let n = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : [];
      if (t.includes("j")) return Ee(t, r, n);
      var a = T(r)(...n);

      function s(u) {
        return u
      }
      return a
    },
    Ce = function(t, r) {
      let n = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : !1;
      return function() {
        return xe(t, r, [...arguments], n)
      }
    },
    _t = function(t, r) {
      t = G(t);

      function n() {
        return t.includes("j") ? Ce(t, r) : T(r)
      }
      var a = n();
      return typeof a != "function" && X(`unknown function pointer with signature ${t}: ${r}`), a
    };
  class Te extends Error {}
  var pr = t => {
      var r = _r(t),
        n = G(r);
      return st(r), n
    },
    Ie = (t, r) => {
      var n = [],
        a = {};

      function s(u) {
        if (!a[u] && !ft[u]) {
          if (Dt[u]) {
            Dt[u].forEach(s);
            return
          }
          n.push(u), a[u] = !0
        }
      }
      throw r.forEach(s), new Te(`${t}: ` + n.map(pr).join([", "]))
    },
    Me = t => {
      t = t.trim();
      let r = t.indexOf("(");
      return r === -1 ? t : t.slice(0, r)
    },
    Be = (t, r, n, a, s, u, f, d) => {
      var g = Ae(r, n);
      t = G(t), t = Me(t), s = _t(a, s), be(t, function() {
        Ie(`Cannot call ${t} due to unbound types`, g)
      }, r - 1), dr([], g, p => {
        var v = [p[0], null].concat(p.slice(1));
        return Re(t, ve(t, v, null, s, u), r - 1), []
      })
    },
    De = (t, r, n) => {
      switch (r) {
        case 1:
          return n ? a => ct[a] : a => tt[a];
        case 2:
          return n ? a => xt[a >> 1] : a => vt[a >> 1];
        case 4:
          return n ? a => yt[a >> 2] : a => E[a >> 2];
        default:
          throw TypeError(`invalid integer width (${r}): ${t}`)
      }
    },
    Fe = (t, r, n, a, s) => {
      r = G(r);
      let u = a === 0,
        f = g => g;
      if (u) {
        var d = 32 - 8 * n;
        f = g => g << d >>> d, s = f(s)
      }
      et(t, {
        name: r,
        fromWireType: f,
        toWireType: (g, p) => p,
        readValueFromPointer: De(r, n, a !== 0),
        destructorFunction: null
      })
    },
    $e = (t, r, n) => {
      var a = [Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array][r];

      function s(u) {
        var f = E[u >> 2],
          d = E[u + 4 >> 2];
        return new a(ct.buffer, d, f)
      }
      n = G(n), et(t, {
        name: n,
        fromWireType: s,
        readValueFromPointer: s
      }, {
        ignoreDuplicateRegistrations: !0
      })
    },
    Se = (t, r, n, a) => {
      if (!(a > 0)) return 0;
      for (var s = n, u = n + a - 1, f = 0; f < t.length; ++f) {
        var d = t.codePointAt(f);
        if (d <= 127) {
          if (n >= u) break;
          r[n++] = d
        } else if (d <= 2047) {
          if (n + 1 >= u) break;
          r[n++] = 192 | d >> 6, r[n++] = 128 | d & 63
        } else if (d <= 65535) {
          if (n + 2 >= u) break;
          r[n++] = 224 | d >> 12, r[n++] = 128 | d >> 6 & 63, r[n++] = 128 | d & 63
        } else {
          if (n + 3 >= u) break;
          r[n++] = 240 | d >> 18, r[n++] = 128 | d >> 12 & 63, r[n++] = 128 | d >> 6 & 63, r[n++] = 128 | d & 63, f++
        }
      }
      return r[n] = 0, n - s
    },
    pt = (t, r, n) => Se(t, tt, r, n),
    mr = t => {
      for (var r = 0, n = 0; n < t.length; ++n) {
        var a = t.charCodeAt(n);
        a <= 127 ? r++ : a <= 2047 ? r += 2 : a >= 55296 && a <= 57343 ? (r += 4, ++n) : r += 3
      }
      return r
    },
    Pe = (t, r) => {
      r = G(r), et(t, {
        name: r,
        fromWireType(n) {
          var a = E[n >> 2],
            s = n + 4,
            u;
          return u = re(s, a, !0), st(n), u
        },
        toWireType(n, a) {
          a instanceof ArrayBuffer && (a = new Uint8Array(a));
          var s, u = typeof a == "string";
          u || ArrayBuffer.isView(a) && a.BYTES_PER_ELEMENT == 1 || X("Cannot pass non-string to std::string"), s = u ? mr(a) : a.length;
          var f = Gt(4 + s + 1),
            d = f + 4;
          return E[f >> 2] = s, u ? pt(a, d, s + 1) : tt.set(a, d), n !== null && n.push(st, f), f
        },
        readValueFromPointer: Bt,
        destructorFunction(n) {
          st(n)
        }
      })
    },
    yr = globalThis.TextDecoder ? new TextDecoder("utf-16le") : void 0,
    We = (t, r, n) => {
      var a = t >> 1,
        s = lr(vt, a, r / 2, n);
      if (s - a > 16 && yr) return yr.decode(vt.subarray(a, s));
      for (var u = "", f = a; f < s; ++f) {
        var d = vt[f];
        u += String.fromCharCode(d)
      }
      return u
    },
    Qe = (t, r, n) => {
      if (n != null || (n = 2147483647), n < 2) return 0;
      n -= 2;
      for (var a = r, s = n < t.length * 2 ? n / 2 : t.length, u = 0; u < s; ++u) {
        var f = t.charCodeAt(u);
        xt[r >> 1] = f, r += 2
      }
      return xt[r >> 1] = 0, r - a
    },
    Oe = t => t.length * 2,
    qe = (t, r, n) => {
      for (var a = "", s = t >> 2, u = 0; !(u >= r / 4); u++) {
        var f = E[s + u];
        if (!f && !n) break;
        a += String.fromCodePoint(f)
      }
      return a
    },
    ze = (t, r, n) => {
      if (n != null || (n = 2147483647), n < 4) return 0;
      for (var a = r, s = a + n - 4, u = 0; u < t.length; ++u) {
        var f = t.codePointAt(u);
        if (f > 65535 && u++, yt[r >> 2] = f, r += 4, r + 4 > s) break
      }
      return yt[r >> 2] = 0, r - a
    },
    Ue = t => {
      for (var r = 0, n = 0; n < t.length; ++n) t.codePointAt(n) > 65535 && n++, r += 4;
      return r
    },
    ke = (t, r, n) => {
      n = G(n);
      var a, s, u;
      r === 2 ? (a = We, s = Qe, u = Oe) : (a = qe, s = ze, u = Ue), et(t, {
        name: n,
        fromWireType: f => {
          var d = E[f >> 2],
            g = a(f + 4, d * r, !0);
          return st(f), g
        },
        toWireType: (f, d) => {
          typeof d != "string" && X(`Cannot pass non-string to C++ string type ${n}`);
          var g = u(d),
            p = Gt(4 + g + r);
          return E[p >> 2] = g / r, s(d, p + 4, g + r), f !== null && f.push(st, p), p
        },
        readValueFromPointer: Bt,
        destructorFunction(f) {
          st(f)
        }
      })
    },
    Ve = (t, r, n, a, s, u) => {
      Mt[t] = {
        name: G(r),
        rawConstructor: _t(n, a),
        rawDestructor: _t(s, u),
        fields: []
      }
    },
    Ne = (t, r, n, a, s, u, f, d, g, p) => {
      Mt[t].fields.push({
        fieldName: G(r),
        getterReturnType: n,
        getter: _t(a, s),
        getterContext: u,
        setterArgumentType: f,
        setter: _t(d, g),
        setterContext: p
      })
    },
    Le = (t, r) => {
      r = G(r), et(t, {
        isVoid: !0,
        name: r,
        fromWireType: () => {},
        toWireType: (n, a) => {}
      })
    },
    Lt = [],
    je = t => {
      var r = Lt.length;
      return Lt.push(t), r
    },
    Ge = (t, r) => {
      var n = ft[t];
      return n === void 0 && X(`${r} has unknown type ${pr(t)}`), n
    },
    He = (t, r) => {
      for (var n = Array(t), a = 0; a < t; ++a) n[a] = Ge(E[r + a * 4 >> 2], `parameter ${a}`);
      return n
    },
    Ze = (t, r, n) => {
      var a = [],
        s = t(a, n);
      return a.length && (E[r >> 2] = nt.toHandle(a)), s
    },
    Xe = {},
    vr = t => {
      var r = Xe[t];
      return r === void 0 ? G(t) : r
    },
    Ye = (t, r, n) => {
      var a = 8,
        [s, ...u] = He(t, r),
        f = s.toWireType.bind(s),
        d = u.map(p => p.readValueFromPointer.bind(p));
      t--;
      var g = Array(t);
      return je(wr(`methodCaller<(${u.map(p=>p.name)}) => ${s.name}>`, (p, v, F, O) => {
        for (var k = 0, Q = 0; Q < t; ++Q) g[Q] = d[Q](O + k), k += a;
        var L;
        switch (n) {
          case 0:
            L = nt.toValue(p).apply(null, g);
            break;
          case 2:
            L = Reflect.construct(nt.toValue(p), g);
            break;
          case 3:
            L = g[0];
            break;
          case 1:
            L = nt.toValue(p)[vr(v)](...g);
            break
        }
        return Ze(f, F, L)
      }))
    },
    Ke = t => t ? (t = vr(t), nt.toHandle(globalThis[t])) : nt.toHandle(globalThis),
    Je = t => {
      t > 9 && (dt[t + 1] += 1)
    },
    tn = (t, r, n, a, s) => Lt[t](r, n, a, s),
    rn = t => {
      Vt(nt.toValue(t)), Nt(t)
    },
    en = (t, r, n, a) => {
      var s = new Date().getFullYear(),
        u = new Date(s, 0, 1),
        f = new Date(s, 6, 1),
        d = u.getTimezoneOffset(),
        g = f.getTimezoneOffset(),
        p = Math.max(d, g);
      E[t >> 2] = p * 60, yt[r >> 2] = +(d != g);
      var v = k => {
          var Q = k >= 0 ? "-" : "+",
            L = Math.abs(k);
          return `UTC${Q}${String(Math.floor(L/60)).padStart(2,"0")}${String(L%60).padStart(2,"0")}`
        },
        F = v(d),
        O = v(g);
      g < d ? (pt(F, n, 17), pt(O, a, 17)) : (pt(F, a, 17), pt(O, n, 17))
    },
    nn = () => 2147483648,
    an = (t, r) => Math.ceil(t / r) * r,
    on = t => {
      var r = (t - Ft.buffer.byteLength + 65535) / 65536 | 0;
      try {
        return Ft.grow(r), S(), 1
      } catch {}
    },
    sn = t => {
      var r = tt.length;
      t >>>= 0;
      var n = nn();
      if (t > n) return !1;
      for (var a = 1; a <= 4; a *= 2) {
        var s = r * (1 + .2 / a);
        if (s = Math.min(s, t + 100663296), on(Math.min(n, an(Math.max(t, s), 65536)))) return !0
      }
      return !1
    },
    jt = {},
    un = () => y || "./this.program",
    bt = () => {
      if (!bt.strings) {
        var t, r, n = {
          USER: "web_user",
          LOGNAME: "web_user",
          PATH: "/",
          PWD: "/",
          HOME: "/home/web_user",
          LANG: ((t = (r = globalThis.navigator) == null ? void 0 : r.language) == null ? "C" : t).replace("-", "_") + ".UTF-8",
          _: un()
        };
        for (var a in jt) jt[a] === void 0 ? delete n[a] : n[a] = jt[a];
        var s = [];
        for (var a in n) s.push(`${a}=${n[a]}`);
        bt.strings = s
      }
      return bt.strings
    },
    ln = (t, r) => {
      var n = 0,
        a = 0;
      for (var s of bt()) {
        var u = r + n;
        E[t + a >> 2] = u, n += pt(s, u, 1 / 0) + 1, a += 4
      }
      return 0
    },
    cn = (t, r) => {
      var n = bt();
      E[t >> 2] = n.length;
      var a = 0;
      for (var s of n) a += mr(s) + 1;
      return E[r >> 2] = a, 0
    },
    fn = t => 52,
    dn = (t, r, n, a) => 52;

  function hn(t, r, n, a, s) {
    return 70
  }
  var wn = [null, [],
      []
    ],
    gn = (t, r) => {
      var n = wn[t];
      r === 0 || r === 10 ? ((t === 1 ? z : B)(cr(n)), n.length = 0) : n.push(r)
    },
    pn = (t, r, n, a) => {
      for (var s = 0, u = 0; u < n; u++) {
        var f = E[r >> 2],
          d = E[r + 4 >> 2];
        r += 8;
        for (var g = 0; g < d; g++) gn(t, tt[f + g]);
        s += d
      }
      return E[a >> 2] = s, 0
    },
    mn = t => t;
  if (o.noExitRuntime && o.noExitRuntime, o.print && (z = o.print), o.printErr && (B = o.printErr), o.wasmBinary && (P = o.wasmBinary), o.arguments && o.arguments, o.thisProgram && (y = o.thisProgram), o.preInit)
    for (typeof o.preInit == "function" && (o.preInit = [o.preInit]); o.preInit.length > 0;) o.preInit.shift()();
  var _r, Gt, st, x, br, Ar, Rr, Er, Ht, xr, Cr, Tr, Ft, Ir;

  function yn(t) {
    _r = t.pa, Gt = o._malloc = t.ra, st = o._free = t.sa, x = t.ta, br = t.ua, Ar = t.va, Rr = t.wa, Er = t.xa, Ht = t.ya, xr = t.za, Cr = t.Aa, ht.jiji = t.Ba, ht.viijii = t.Ca, Tr = ht.jiiii = t.Da, ht.iiiiij = t.Ea, ht.iiiiijj = t.Fa, ht.iiiiiijj = t.Ga, Ft = t.na, Ir = t.qa
  }
  var vn = {
    t: jr,
    u: Gr,
    a: Hr,
    g: Zr,
    v: Xr,
    _: Yr,
    p: Kr,
    Z: Jr,
    e: te,
    L: ee,
    da: ne,
    ba: ae,
    ea: ie,
    aa: oe,
    U: se,
    ka: le,
    T: ce,
    ia: he,
    ga: ge,
    M: me,
    N: Be,
    s: Fe,
    n: $e,
    ha: Pe,
    E: ke,
    F: Ve,
    la: Ne,
    ja: Le,
    C: Ye,
    ma: Nt,
    Q: Ke,
    G: Je,
    A: tn,
    W: rn,
    V: en,
    $: sn,
    X: ln,
    Y: cn,
    J: fn,
    ca: dn,
    S: hn,
    K: pn,
    H: On,
    O: In,
    I: Qn,
    l: qn,
    b: Cn,
    c: En,
    f: Tn,
    j: Fn,
    D: $n,
    r: Pn,
    B: Wn,
    x: Un,
    R: Vn,
    k: xn,
    i: _n,
    d: An,
    h: Rn,
    o: bn,
    y: Sn,
    z: Bn,
    q: zn,
    fa: Dn,
    m: Mn,
    w: kn,
    P: mn
  };

  function _n(t, r) {
    var n = M();
    try {
      T(t)(r)
    } catch (a) {
      if (I(n), a !== a + 0) throw a;
      x(1, 0)
    }
  }

  function bn(t, r, n, a, s) {
    var u = M();
    try {
      T(t)(r, n, a, s)
    } catch (f) {
      if (I(u), f !== f + 0) throw f;
      x(1, 0)
    }
  }

  function An(t, r, n) {
    var a = M();
    try {
      T(t)(r, n)
    } catch (s) {
      if (I(a), s !== s + 0) throw s;
      x(1, 0)
    }
  }

  function Rn(t, r, n, a) {
    var s = M();
    try {
      T(t)(r, n, a)
    } catch (u) {
      if (I(s), u !== u + 0) throw u;
      x(1, 0)
    }
  }

  function En(t, r, n) {
    var a = M();
    try {
      return T(t)(r, n)
    } catch (s) {
      if (I(a), s !== s + 0) throw s;
      x(1, 0)
    }
  }

  function xn(t) {
    var r = M();
    try {
      T(t)()
    } catch (n) {
      if (I(r), n !== n + 0) throw n;
      x(1, 0)
    }
  }

  function Cn(t, r) {
    var n = M();
    try {
      return T(t)(r)
    } catch (a) {
      if (I(n), a !== a + 0) throw a;
      x(1, 0)
    }
  }

  function Tn(t, r, n, a) {
    var s = M();
    try {
      return T(t)(r, n, a)
    } catch (u) {
      if (I(s), u !== u + 0) throw u;
      x(1, 0)
    }
  }

  function In(t, r, n, a, s, u) {
    var f = M();
    try {
      return T(t)(r, n, a, s, u)
    } catch (d) {
      if (I(f), d !== d + 0) throw d;
      x(1, 0)
    }
  }

  function Mn(t, r, n, a, s, u, f, d, g, p, v) {
    var F = M();
    try {
      T(t)(r, n, a, s, u, f, d, g, p, v)
    } catch (O) {
      if (I(F), O !== O + 0) throw O;
      x(1, 0)
    }
  }

  function Bn(t, r, n, a, s, u, f) {
    var d = M();
    try {
      T(t)(r, n, a, s, u, f)
    } catch (g) {
      if (I(d), g !== g + 0) throw g;
      x(1, 0)
    }
  }

  function Dn(t, r, n, a, s, u, f, d, g) {
    var p = M();
    try {
      T(t)(r, n, a, s, u, f, d, g)
    } catch (v) {
      if (I(p), v !== v + 0) throw v;
      x(1, 0)
    }
  }

  function Fn(t, r, n, a, s) {
    var u = M();
    try {
      return T(t)(r, n, a, s)
    } catch (f) {
      if (I(u), f !== f + 0) throw f;
      x(1, 0)
    }
  }

  function $n(t, r, n, a, s, u) {
    var f = M();
    try {
      return T(t)(r, n, a, s, u)
    } catch (d) {
      if (I(f), d !== d + 0) throw d;
      x(1, 0)
    }
  }

  function Sn(t, r, n, a, s, u) {
    var f = M();
    try {
      T(t)(r, n, a, s, u)
    } catch (d) {
      if (I(f), d !== d + 0) throw d;
      x(1, 0)
    }
  }

  function Pn(t, r, n, a, s, u, f) {
    var d = M();
    try {
      return T(t)(r, n, a, s, u, f)
    } catch (g) {
      if (I(d), g !== g + 0) throw g;
      x(1, 0)
    }
  }

  function Wn(t, r, n, a, s, u, f, d) {
    var g = M();
    try {
      return T(t)(r, n, a, s, u, f, d)
    } catch (p) {
      if (I(g), p !== p + 0) throw p;
      x(1, 0)
    }
  }

  function Qn(t, r, n, a) {
    var s = M();
    try {
      return T(t)(r, n, a)
    } catch (u) {
      if (I(s), u !== u + 0) throw u;
      x(1, 0)
    }
  }

  function On(t, r, n, a) {
    var s = M();
    try {
      return T(t)(r, n, a)
    } catch (u) {
      if (I(s), u !== u + 0) throw u;
      x(1, 0)
    }
  }

  function qn(t) {
    var r = M();
    try {
      return T(t)()
    } catch (n) {
      if (I(r), n !== n + 0) throw n;
      x(1, 0)
    }
  }

  function zn(t, r, n, a, s, u, f, d) {
    var g = M();
    try {
      T(t)(r, n, a, s, u, f, d)
    } catch (p) {
      if (I(g), p !== p + 0) throw p;
      x(1, 0)
    }
  }

  function Un(t, r, n, a, s, u, f, d, g, p, v, F) {
    var O = M();
    try {
      return T(t)(r, n, a, s, u, f, d, g, p, v, F)
    } catch (k) {
      if (I(O), k !== k + 0) throw k;
      x(1, 0)
    }
  }

  function kn(t, r, n, a, s, u, f, d, g, p, v, F, O, k, Q, L) {
    var At = M();
    try {
      T(t)(r, n, a, s, u, f, d, g, p, v, F, O, k, Q, L)
    } catch (at) {
      if (I(At), at !== at + 0) throw at;
      x(1, 0)
    }
  }

  function Vn(t, r, n, a, s) {
    var u = M();
    try {
      return Tr(t, r, n, a, s)
    } catch (f) {
      if (I(u), f !== f + 0) throw f;
      x(1, 0)
    }
  }

  function Nn() {
    V();

    function t() {
      var r, n;
      o.calledRun = !0, !D && (J(), (r = H) == null || r(o), (n = o.onRuntimeInitialized) == null || n.call(o), Z())
    }
    o.setStatus ? (o.setStatus("Running..."), setTimeout(() => {
      setTimeout(() => o.setStatus(""), 1), t()
    }, 1)) : t()
  }
  var $t = await Vr();
  return Nn(), i = C ? o : new Promise((t, r) => {
    H = t, W = r
  }), i
}

function Kn(e) {
  return Pr(Wr, e)
}
async function Jn(e, i) {
  return Yn(Wr, e, i)
}
var ta = "" + new URL(__RQR_WASM_URL("zxing_writer-NQHybxPU.wasm"), import.meta.url).href;
const ra = [
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
  ea = {
    L: 0,
    M: 1,
    Q: 2,
    H: 3
  },
  na = 20;

function aa(e, i) {
  return ia(e, i, na)
}

function ia(e, i, c) {
  const l = oa(e, i),
    h = 4 + (e <= 9 ? 8 : 16) + c;
  return Math.max(0, Math.floor((l * 8 - h) / 8))
}

function oa(e, i) {
  const c = (e - 1) * 4 + ea[i],
    l = ra[c];
  if (!l) throw new Error(`No RS block table entry for V${e}-${i}`);
  let o = 0;
  for (let h = 0; h < l.length; h += 3) o += l[h] * l[h + 2];
  return o
}
let Xt = null;
async function sa(e, i, c, l) {
  const o = await ua(e, i, c, l),
    h = i * 4 + 17;
  if (o.width === h && o.height === h) return fa(o, l);
  const w = ha(i, l);
  if (o.width === w && o.height === w) return ca(o);
  throw new Error(`ZXing QR writer returned ${o.width}x${o.height}, expected ${h}x${h} modules or ${w}x${w} pixels for V${i}-${c} at scale ${l}.`)
}
async function ua(e, i, c, l) {
  da(i, c, l, e.length), await la();
  const o = {
      format: "QRCode",
      options: `version=${i},ecLevel=${c}`,
      scale: l,
      addQuietZones: !0,
      addHRT: !1
    },
    h = await Jn(e, o);
  if (h.error) throw new Error(`ZXing QR writer failed: ${h.error}`);
  return h.symbol
}

function la() {
  return Xt || (Xt = Promise.resolve(Kn({
    overrides: {
      locateFile: e => e.endsWith(".wasm") ? ta : e
    },
    equalityFn: Object.is,
    fireImmediately: !0
  }))), Xt
}

function ca(e) {
  if (e.data.length !== e.width * e.height) throw new Error(`ZXing QR symbol buffer size mismatch: ${e.data.length} bytes for ${e.width}x${e.height}.`);
  const i = new Uint8ClampedArray(e.width * e.height * 4);
  for (let c = 0; c < e.data.length; c++) {
    const l = e.data[c] === 0 ? 0 : 255,
      o = c * 4;
    i[o] = l, i[o + 1] = l, i[o + 2] = l, i[o + 3] = 255
  }
  return new ImageData(i, e.width, e.height)
}

function fa(e, i) {
  if (e.data.length !== e.width * e.height) throw new Error(`ZXing QR symbol buffer size mismatch: ${e.data.length} bytes for ${e.width}x${e.height}.`);
  const c = 4,
    l = (e.width + c * 2) * i,
    o = new Uint8ClampedArray(l * l * 4);
  o.fill(255);
  for (let h = 0; h < e.height; h++)
    for (let w = 0; w < e.width; w++) {
      if (e.data[h * e.width + w] !== 0) continue;
      const m = (w + c) * i,
        y = (h + c) * i;
      for (let b = 0; b < i; b++) {
        const _ = ((y + b) * l + m) * 4;
        for (let A = 0; A < i; A++) {
          const $ = _ + A * 4;
          o[$] = 0, o[$ + 1] = 0, o[$ + 2] = 0, o[$ + 3] = 255
        }
      }
    }
  return new ImageData(o, l, l)
}

function da(e, i, c, l) {
  if (!Number.isInteger(e) || e < 1 || e > 40) throw new RangeError(`Invalid QR version: ${e}. Must be 1-40.`);
  if (i !== "L" && i !== "M" && i !== "Q" && i !== "H") throw new RangeError(`Invalid QR ECC level: ${i}.`);
  if (!Number.isInteger(c) || c < 1) throw new RangeError(`Invalid QR render scale: ${c}.`);
  if (l !== void 0) {
    const o = aa(e, i);
    if (l > o) throw new Error(`Data too large for ZXing QR writer V${e}-${i}. Maximum ${o} bytes for binary Uint8Array payload, got ${l}.`)
  }
}

function ha(e, i) {
  return (e * 4 + 17 + 8) * i
}
class rr {
  __destroy_into_raw() {
    const i = this.__wbg_ptr;
    return this.__wbg_ptr = 0, Br.unregister(this), i
  }
  free() {
    const i = this.__destroy_into_raw();
    R.__wbg_qrrenderer_free(i, 0)
  }
  buf_len() {
    return R.qrrenderer_buf_len(this.__wbg_ptr) >>> 0
  }
  buf_ptr() {
    return R.qrrenderer_buf_ptr(this.__wbg_ptr) >>> 0
  }
  last_matrix_size() {
    return R.qrrenderer_last_matrix_size(this.__wbg_ptr) >>> 0
  }
  matrix_len() {
    return R.qrrenderer_matrix_len(this.__wbg_ptr) >>> 0
  }
  matrix_ptr() {
    return R.qrrenderer_matrix_ptr(this.__wbg_ptr) >>> 0
  }
  constructor() {
    const i = R.qrrenderer_new();
    return this.__wbg_ptr = i, Br.register(this, this.__wbg_ptr, this), this
  }
  render(i, c, l, o) {
    try {
      const y = R.__wbindgen_add_to_stack_pointer(-16),
        b = Yt(i, R.__wbindgen_export),
        _ = Ot;
      R.qrrenderer_render(y, this.__wbg_ptr, b, _, c, l, o);
      var h = it().getInt32(y + 0, !0),
        w = it().getInt32(y + 4, !0),
        m = it().getInt32(y + 8, !0);
      if (m) throw Kt(w);
      return h >>> 0
    } finally {
      R.__wbindgen_add_to_stack_pointer(16)
    }
  }
  render_matrix(i, c, l) {
    try {
      const m = R.__wbindgen_add_to_stack_pointer(-16),
        y = Yt(i, R.__wbindgen_export),
        b = Ot;
      R.qrrenderer_render_matrix(m, this.__wbg_ptr, y, b, c, l);
      var o = it().getInt32(m + 0, !0),
        h = it().getInt32(m + 4, !0),
        w = it().getInt32(m + 8, !0);
      if (w) throw Kt(h);
      return o >>> 0
    } finally {
      R.__wbindgen_add_to_stack_pointer(16)
    }
  }
  render_rgba(i, c, l, o) {
    try {
      const y = R.__wbindgen_add_to_stack_pointer(-16),
        b = Yt(i, R.__wbindgen_export),
        _ = Ot;
      R.qrrenderer_render_rgba(y, this.__wbg_ptr, b, _, c, l, o);
      var h = it().getInt32(y + 0, !0),
        w = it().getInt32(y + 4, !0),
        m = it().getInt32(y + 8, !0);
      if (m) throw Kt(w);
      return h >>> 0
    } finally {
      R.__wbindgen_add_to_stack_pointer(16)
    }
  }
  rgba_len() {
    return R.qrrenderer_rgba_len(this.__wbg_ptr) >>> 0
  }
  rgba_ptr() {
    return R.qrrenderer_rgba_ptr(this.__wbg_ptr) >>> 0
  }
}
Symbol.dispose && (rr.prototype[Symbol.dispose] = rr.prototype.free);

function wa() {
  return {
    __proto__: null,
    "./raptorqr_fast_qr_wasm_bg.js": {
      __proto__: null,
      __wbg___wbindgen_throw_344f42d3211c4765: function(i, c) {
        throw new Error(Dr(i, c))
      },
      __wbindgen_cast_0000000000000001: function(i, c) {
        const l = Dr(i, c);
        return ga(l)
      }
    }
  }
}
const Br = typeof FinalizationRegistry > "u" ? {
  register: () => {},
  unregister: () => {}
} : new FinalizationRegistry(e => R.__wbg_qrrenderer_free(e, 1));

function ga(e) {
  Et === ot.length && ot.push(ot.length + 1);
  const i = Et;
  return Et = ot[i], ot[i] = e, i
}

function pa(e) {
  e < 1028 || (ot[e] = Et, Et = e)
}
let wt = null;

function it() {
  return (wt === null || wt.buffer.detached === !0 || wt.buffer.detached === void 0 && wt.buffer !== R.memory.buffer) && (wt = new DataView(R.memory.buffer)), wt
}

function Dr(e, i) {
  return va(e >>> 0, i)
}
let Rt = null;

function Qr() {
  return (Rt === null || Rt.byteLength === 0) && (Rt = new Uint8Array(R.memory.buffer)), Rt
}

function ma(e) {
  return ot[e]
}
let ot = new Array(1024).fill(void 0);
ot.push(void 0, null, !0, !1);
let Et = ot.length;

function Yt(e, i) {
  const c = i(e.length * 1, 1) >>> 0;
  return Qr().set(e, c / 1), Ot = e.length, c
}

function Kt(e) {
  const i = ma(e);
  return pa(e), i
}
let Qt = new TextDecoder("utf-8", {
  ignoreBOM: !0,
  fatal: !0
});
Qt.decode();
const ya = 2146435072;
let Jt = 0;

function va(e, i) {
  return Jt += i, Jt >= ya && (Qt = new TextDecoder("utf-8", {
    ignoreBOM: !0,
    fatal: !0
  }), Qt.decode(), Jt = i), Qt.decode(Qr().subarray(e, e + i))
}
let Ot = 0,
  R;

function _a(e, i) {
  return R = e.exports, wt = null, Rt = null, R
}
async function ba(e, i) {
  if (typeof Response == "function" && e instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming == "function") try {
      return await WebAssembly.instantiateStreaming(e, i)
    } catch (o) {
      if (e.ok && c(e.type) && e.headers.get("Content-Type") !== "application/wasm") console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", o);
      else throw o
    }
    const l = await e.arrayBuffer();
    return await WebAssembly.instantiate(l, i)
  } else {
    const l = await WebAssembly.instantiate(e, i);
    return l instanceof WebAssembly.Instance ? {
      instance: l,
      module: e
    } : l
  }

  function c(l) {
    switch (l) {
      case "basic":
      case "cors":
      case "default":
        return !0
    }
    return !1
  }
}
async function Aa(e) {
  if (R !== void 0) return R;
  e !== void 0 && (Object.getPrototypeOf(e) === Object.prototype ? {
    module_or_path: e
  } = e : console.warn("using deprecated parameters for the initialization function; pass a single object instead")), e === void 0 && (e = new URL("" + new URL(__RQR_WASM_URL("raptorqr_fast_qr_wasm_bg-DEFhihBP.wasm"), import.meta.url).href, import.meta.url));
  const i = wa();
  (typeof e == "string" || typeof Request == "function" && e instanceof Request || typeof URL == "function" && e instanceof URL) && (e = fetch(e));
  const {
    instance: c,
    module: l
  } = await ba(await e, i);
  return _a(c)
}
let Pt = null,
  qt = null;

function Fr() {
  return "fast_qr WASM artifacts are not installed. Run packages/raptorqr-fast-qr-wasm/src/build_fast_qr_wasm_colab.py in Google Colab, then copy the generated files into packages/raptorqr-fast-qr-wasm/src/wasm."
}
async function Ra() {
  Pt || (Pt = Promise.resolve(Aa()).then(e => {
    qt = e
  }).catch(e => {
    throw Pt = null, e instanceof Error ? e : new Error(String(e))
  })), await Pt
}

function Ea() {
  return qt !== null
}

function xa() {
  if (!qt) throw new Error("fast_qr WASM not initialized — call ensureFastQrWasm() first.");
  return qt.memory
}
const Ca = "fast-qr-wasm";

function Ta(e) {
  switch (e) {
    case "fast-qr-wasm":
    case "fast_qr_wasm":
    case "fastQrWasm":
      return "fast-qr-wasm";
    case "zxing-wasm":
    case "zxing":
    case "zxingWasm":
      return "zxing-wasm";
    default:
      return Ca
  }
}
const Ia = {
  L: 0,
  M: 1,
  Q: 2,
  H: 3
};
let Wt = null;
async function Ma(e, i, c, l, o = "fast-qr-wasm") {
  switch (o) {
    case "fast-qr-wasm":
      return Da(e, i, c, l);
    case "zxing-wasm":
      return sa(e, i, c, l)
  }
}
async function Ba() {
  Wt || (Wt = Ra().then(() => new rr).catch(i => {
    Wt = null;
    const c = i instanceof Error ? i.message : String(i);
    throw new Error(`${Fr()} ${c}`)
  }));
  const e = await Wt;
  if (!e || !Ea()) throw new Error(Fr());
  return e
}
async function Da(e, i, c, l) {
  const o = await Ba(),
    h = Ia[c],
    w = o.render_rgba(e, i, h, l),
    m = w * w * 4,
    y = xa(),
    b = o.rgba_ptr(),
    _ = new Uint8ClampedArray(y.buffer, b, m),
    A = new Uint8ClampedArray(m);
  return A.set(_), new ImageData(A, w, w)
}
var Fa = {
  trailer: 59
};

function Or(e = 256) {
  let i = 0,
    c = new Uint8Array(e);
  return {
    get buffer() {
      return c.buffer
    },
    reset() {
      i = 0
    },
    bytesView() {
      return c.subarray(0, i)
    },
    bytes() {
      return c.slice(0, i)
    },
    writeByte(o) {
      l(i + 1), c[i] = o, i++
    },
    writeBytes(o, h = 0, w = o.length) {
      l(i + w);
      for (let m = 0; m < w; m++) c[i++] = o[m + h]
    },
    writeBytesView(o, h = 0, w = o.byteLength) {
      l(i + w), c.set(o.subarray(h, h + w), i), i += w
    }
  };

  function l(o) {
    var h = c.length;
    if (h >= o) return;
    var w = 1024 * 1024;
    o = Math.max(o, h * (h < w ? 2 : 1.125) >>> 0), h != 0 && (o = Math.max(o, 256));
    let m = c;
    c = new Uint8Array(o), i > 0 && c.set(m.subarray(0, i), 0)
  }
}
var tr = 12,
  $r = 5003,
  $a = [0, 1, 3, 7, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383, 32767, 65535];

function Sa(e, i, c, l, o = Or(512), h = new Uint8Array(256), w = new Int32Array($r), m = new Int32Array($r)) {
  let y = w.length,
    b = Math.max(2, l);
  h.fill(0), m.fill(0), w.fill(-1);
  let _ = 0,
    A = 0,
    $ = b + 1,
    q = $,
    z = !1,
    B = q,
    P = (1 << B) - 1,
    D = 1 << $ - 1,
    H = D + 1,
    W = D + 2,
    C = 0,
    S = c[0],
    V = 0;
  for (let U = y; U < 65536; U *= 2) ++V;
  V = 8 - V, o.writeByte(b), Z(D);
  let J = c.length;
  for (let U = 1; U < J; U++) t: {
    let K = c[U],
      mt = (K << tr) + S,
      N = K << V ^ S;
    if (w[N] === mt) {
      S = m[N];
      break t
    }
    let zt = N === 0 ? 1 : y - N;
    for (; w[N] >= 0;)
      if (N -= zt, N < 0 && (N += y), w[N] === mt) {
        S = m[N];
        break t
      } Z(S),
    S = K,
    W < 1 << tr ? (m[N] = W++, w[N] = mt) : (w.fill(-1), W = D + 2, z = !0, Z(D))
  }
  return Z(S), Z(H), o.writeByte(0), o.bytesView();

  function Z(U) {
    for (_ &= $a[A], A > 0 ? _ |= U << A : _ = U, A += B; A >= 8;) h[C++] = _ & 255, C >= 254 && (o.writeByte(C), o.writeBytesView(h, 0, C), C = 0), _ >>= 8, A -= 8;
    if ((W > P || z) && (z ? (B = q, P = (1 << B) - 1, z = !1) : (++B, P = B === tr ? 1 << B : (1 << B) - 1)), U == H) {
      for (; A > 0;) h[C++] = _ & 255, C >= 254 && (o.writeByte(C), o.writeBytesView(h, 0, C), C = 0), _ >>= 8, A -= 8;
      C > 0 && (o.writeByte(C), o.writeBytesView(h, 0, C), C = 0)
    }
  }
}
var Pa = Sa;

function Wa(e = {}) {
  let {
    initialCapacity: i = 4096,
    auto: c = !0
  } = e, l = Or(i), o = 5003, h = new Uint8Array(256), w = new Int32Array(o), m = new Int32Array(o), y = !1;
  return {
    reset() {
      l.reset(), y = !1
    },
    finish() {
      l.writeByte(Fa.trailer)
    },
    bytes() {
      return l.bytes()
    },
    bytesView() {
      return l.bytesView()
    },
    get buffer() {
      return l.buffer
    },
    get stream() {
      return l
    },
    writeHeader: b,
    writeFrame(_, A, $, q = {}) {
      let {
        transparent: z = !1,
        transparentIndex: B = 0,
        delay: P = 0,
        palette: D = null,
        repeat: H = 0,
        colorDepth: W = 8,
        dispose: C = -1
      } = q, S = !1;
      if (c ? y || (S = !0, b(), y = !0) : S = !!q.first, A = Math.max(0, Math.floor(A)), $ = Math.max(0, Math.floor($)), S) {
        if (!D) throw new Error("First frame must include a { palette } option");
        Oa(l, A, $, D, W), Sr(l, D), H >= 0 && qa(l, H)
      }
      let V = Math.round(P / 10);
      Qa(l, C, V, z, B);
      let J = !!D && !S;
      za(l, A, $, J ? D : null), J && Sr(l, D), Ua(l, _, A, $, W, h, w, m)
    }
  };

  function b() {
    qr(l, "GIF89a")
  }
}

function Qa(e, i, c, l, o) {
  e.writeByte(33), e.writeByte(249), e.writeByte(4), o < 0 && (o = 0, l = !1);
  var h, w;
  l ? (h = 1, w = 2) : (h = 0, w = 0), i >= 0 && (w = i & 7), w <<= 2, e.writeByte(0 | w | 0 | h), lt(e, c), e.writeByte(o || 0), e.writeByte(0)
}

function Oa(e, i, c, l, o = 8) {
  let h = 1,
    w = 0,
    m = er(l.length) - 1,
    y = h << 7 | o - 1 << 4 | w << 3 | m;
  lt(e, i), lt(e, c), e.writeBytes([y, 0, 0])
}

function qa(e, i) {
  e.writeByte(33), e.writeByte(255), e.writeByte(11), qr(e, "NETSCAPE2.0"), e.writeByte(3), e.writeByte(1), lt(e, i), e.writeByte(0)
}

function Sr(e, i) {
  let c = 1 << er(i.length);
  for (let l = 0; l < c; l++) {
    let o = [0, 0, 0];
    l < i.length && (o = i[l]), e.writeByte(o[0]), e.writeByte(o[1]), e.writeByte(o[2])
  }
}

function za(e, i, c, l) {
  if (e.writeByte(44), lt(e, 0), lt(e, 0), lt(e, i), lt(e, c), l) {
    let o = 0,
      h = 0,
      w = er(l.length) - 1;
    e.writeByte(128 | o | h | 0 | w)
  } else e.writeByte(0)
}

function Ua(e, i, c, l, o = 8, h, w, m) {
  Pa(c, l, i, o, e, h, w, m)
}

function lt(e, i) {
  e.writeByte(i & 255), e.writeByte(i >> 8 & 255)
}

function qr(e, i) {
  for (var c = 0; c < i.length; c++) e.writeByte(i.charCodeAt(c))
}

function er(e) {
  return Math.max(Math.ceil(Math.log2(e)), 1)
}
const ka = [
    [255, 255, 255],
    [0, 0, 0]
  ],
  Va = 100;

function Na(e) {
  const i = e.length / 4,
    c = new Uint8Array(i);
  for (let l = 0; l < i; l++) {
    const o = l * 4,
      h = e[o] + e[o + 1] + e[o + 2];
    c[l] = h < 384 ? 1 : 0
  }
  return c
}

function La(e, i = Va, c, l) {
  if (e.length === 0) throw new Error("At least one frame is required");
  const o = typeof i == "number" ? new Array(e.length).fill(i) : i;
  if (o.length !== e.length) throw new Error(`Delay array length (${o.length}) must match frame count (${e.length})`);
  const h = Wa({
    auto: !0
  });
  for (let w = 0; w < e.length; w++) {
    const m = Na(new Uint8Array(e[w].buffer, e[w].byteOffset, e[w].byteLength)),
      y = w === 0;
    h.writeFrame(m, c, l, {
      palette: y ? ka : void 0,
      delay: o[w],
      repeat: y ? 0 : void 0
    })
  }
  return h.finish(), h.bytes()
}
const ja = 10,
  Ga = "M",
  Ha = 200;

function Za(e, i) {
  if (!Number.isInteger(e) || e < 0) throw new RangeError(`Invalid packet count: ${e}`);
  return Math.max(1, Math.ceil(e / i))
}

function Xa(e, i, c, l) {
  if (!Number.isInteger(e) || e < 0) throw new RangeError(`Invalid packet count: ${e}`);
  if (!Number.isInteger(l) || l < 0 || l >= i) throw new RangeError(`Invalid tile index: ${l}`);
  const o = c * i + l;
  return o < e ? o : null
}

function Ya(e, i, c, l) {
  const o = Xa(e.length, i, c, l);
  return o === null ? null : e[o] ?? null
}
self.onmessage = e => {
  const i = e.data;
  i.type === "generate" && (async () => {
    try {
      const c = await Ka(i);
      self.postMessage(c, {
        transfer: [c.gifData]
      })
    } catch (c) {
      self.postMessage({
        type: "error",
        message: c.message ?? String(c)
      })
    }
  })()
};
async function Ka(e) {
  const {
    packets: i
  } = e, c = ni(e.packetOrder, i.length), l = Ja(e.frameDelayMs), o = ti(e.qrVersion), h = ri(e.eccLevel), w = Ta(e.qrEncoder), m = ei(e.parallelCount), y = o * 4 + 17, b = 360, A = y + 8, $ = Math.max(2, Math.round(b / A)), q = A * $, z = ai(m), B = [], P = q * z.columns, D = q * z.rows, H = Za(c.length, m);
  for (let C = 0; C < H; C++) {
    const S = new Uint8ClampedArray(P * D * 4);
    S.fill(255);
    for (let V = 0; V < m; V++) {
      const J = Ya(c, m, C, V);
      if (J === null) continue;
      const Z = await Ma(i[J], o, h, $, w),
        U = V % z.columns * q,
        K = Math.floor(V / z.columns) * q;
      ii(S, P, Z.data, Z.width, Z.height, U, K)
    }
    B.push(new Uint8Array(S.buffer))
  }
  const W = La(B, l, P, D);
  return {
    type: "gifReady",
    gifData: W.buffer.slice(W.byteOffset, W.byteOffset + W.byteLength),
    width: P,
    height: D,
    frameCount: B.length
  }
}

function Ja(e) {
  return Number.isFinite(e) ? Math.min(500, Math.max(17, Math.round(e))) : Ha
}

function ti(e) {
  if (e === void 0) return ja;
  if (!Number.isInteger(e) || e < 1 || e > 40) throw new RangeError(`Invalid QR version: ${e}`);
  return e
}

function ri(e) {
  return e ?? Ga
}

function ei(e) {
  return e === 1 || e === 2 || e === 4 || e === 6 || e === 8 ? e : 4
}

function ni(e, i) {
  if (!e) return Array.from({
    length: i
  }, (l, o) => o);
  if (e.length !== i) throw new RangeError(`Invalid GIF packet order length: ${e.length}, expected ${i}`);
  const c = new Set;
  for (const l of e) {
    if (!Number.isInteger(l) || l < 0 || l >= i) throw new RangeError(`Invalid GIF packet index: ${l}`);
    if (c.has(l)) throw new RangeError(`Duplicate GIF packet index: ${l}`);
    c.add(l)
  }
  return e
}

function ai(e) {
  return e === 1 ? {
    columns: 1,
    rows: 1
  } : e === 2 ? {
    columns: 2,
    rows: 1
  } : e === 4 ? {
    columns: 2,
    rows: 2
  } : e === 6 ? {
    columns: 3,
    rows: 2
  } : {
    columns: 4,
    rows: 2
  }
}

function ii(e, i, c, l, o, h, w) {
  for (let m = 0; m < o; m++) {
    const y = m * l * 4,
      b = y + l * 4,
      _ = ((w + m) * i + h) * 4;
    e.set(c.subarray(y, b), _)
  }
}