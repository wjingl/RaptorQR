/* ============================================================================
 * RaptorQR 彩色化构建脚本
 * 将 CimQR 编解码器注入 3 个 worker（render/gif/decode），并修补主 bundle，
 * 最终生成彩色化单文件 HTML。
 * ========================================================================== */
const fs = require('fs');

const SRC = 'RaptorQR_离线单文件版.html';
const DST = 'RaptorQR_彩色版.html';
const CODEC = fs.readFileSync('cimqr_codec.js', 'utf8');

const html = fs.readFileSync(SRC, 'utf8');

// ---- 提取两个 script ----
const script1TagStart = html.indexOf('<script>');
const s1Start = script1TagStart + '<script>'.length;
const s1End = html.indexOf('</script>', s1Start);
const moduleTagStart = html.indexOf('<script type="module">');
const s2Start = moduleTagStart + '<script type="module">'.length;
const s2End = html.indexOf('</script>', s2Start);
if (script1TagStart < 0 || moduleTagStart < 0) throw new Error('script boundaries not found');
const head = html.slice(0, script1TagStart);
const script1 = html.slice(s1Start, s1End);
const between = html.slice(s1End + '</script>'.length, moduleTagStart);
const script2 = html.slice(s2Start, s2End);
const tail = html.slice(s2End + '</script>'.length);

// ---- 1. 从 script1 中提取并修补 worker（逐次累积）----
function patchWorker(source, name, patchFn) {
  const re = new RegExp('(__RQR_WORKERS\\.' + name + '\\s*=\\s*"data:text/javascript;base64,)([^"]+)(")', 'g');
  let found = false;
  const patched = source.replace(re, (m, pre, b64, post) => {
    found = true;
    let code = Buffer.from(b64, 'base64').toString('utf8');
    code = patchFn(code);
    return pre + Buffer.from(code, 'utf8').toString('base64') + post;
  });
  if (!found) throw new Error('worker ' + name + ' not found');
  return patched;
}

// 注入编解码器源码（UMD 包装在 worker 中会挂到 self.CimQR）
function injectCodec(code) {
  if (code.includes('CimQR')) return code; // 防重复
  return CODEC + '\n' + code;
}

// --- qr_render：加 color-cimbar 渲染分支 ---
let s1 = patchWorker(script1, 'qr_render', (code) => {
  code = injectCodec(code);
  // ba 归一化需放行 color-cimbar
  const ba = 'function ba(a){switch(a){case"fast-qr-wasm":case"fast_qr_wasm":case"fastQrWasm":return"fast-qr-wasm";case"zxing-wasm":case"zxing":case"zxingWasm":return"zxing-wasm";default:return _a}}';
  if (!code.includes(ba)) throw new Error('qr_render ba not found');
  code = code.replace(ba,
    'function ba(a){switch(a){case"fast-qr-wasm":case"fast_qr_wasm":case"fastQrWasm":return"fast-qr-wasm";case"zxing-wasm":case"zxing":case"zxingWasm":return"zxing-wasm";case"color-cimbar":case"colorCimbar":return"color-cimbar";default:return _a}}');
  const marker = 'let p,u,g;if(Ma(d)){';
  if (!code.includes(marker)) throw new Error('qr_render marker not found');
  code = code.replace(marker,
    'let p,u,g;if(d==="color-cimbar"){const r0=CimQR.render(o,a.scale||1,a.cimSize||0);p=r0.data.buffer,u=r0.width,g=r0.height}else if(Ma(d)){');
  return code;
});

// --- gif：加 color-cimbar 编码器与渲染 ---
s1 = patchWorker(s1, 'gif', (code) => {
  code = injectCodec(code);
  // Ta 归一化
  const ta = 'function Ta(e){switch(e){case"fast-qr-wasm":case"fast_qr_wasm":case"fastQrWasm":return"fast-qr-wasm";case"zxing-wasm":case"zxing":case"zxingWasm":return"zxing-wasm";default:return Ca}}';
  if (!code.includes(ta)) throw new Error('gif Ta not found');
  code = code.replace(ta,
    'function Ta(e){switch(e){case"fast-qr-wasm":case"fast_qr_wasm":case"fastQrWasm":return"fast-qr-wasm";case"zxing-wasm":case"zxing":case"zxingWasm":return"zxing-wasm";case"color-cimbar":case"colorCimbar":return"color-cimbar";default:return Ca}}');
  // Ma 渲染分发
  const ma = 'async function Ma(e,i,c,l,o="fast-qr-wasm"){switch(o){case"fast-qr-wasm":return Da(e,i,c,l);case"zxing-wasm":return sa(e,i,c,l)}}';
  if (!code.includes(ma)) throw new Error('gif Ma not found');
  code = code.replace(ma,
    'async function Ma(e,i,c,l,o="fast-qr-wasm",s=1,z=0){switch(o){case"color-cimbar":{const r0=CimQR.render(new Uint8Array(e),s,z||0);return new ImageData(r0.data,r0.width,r0.height)}case"fast-qr-wasm":return Da(e,i,c,l);case"zxing-wasm":return sa(e,i,c,l)}}');
  // 帧尺寸与并行数（const 链内一次声明；彩色大瓦片 1088×scale，并行数同黑白——多路并发 GIF）
  const q = 'm=ei(e.parallelCount),y=o*4+17,b=360,A=y+8,$=Math.max(2,Math.round(b/A)),q=A*$,z=ai(m)';
  if (!code.includes(q)) throw new Error('gif q not found');
  code = code.replace(q,
    'm=ei(e.parallelCount),y=o*4+17,b=360,A=y+8,$=Math.max(2,Math.round(b/A)),q=(w==="color-cimbar"?Math.round((CimQR.SIZES[e.cimSize||0]||CimQR.SIZES[0]).total*(e.scale||1)):A*$),z=ai(m)');
  // Ma 调用传 scale（彩色尺寸倍率）
  const macall = 'const Z=await Ma(i[J],o,h,$,w)';
  if (!code.includes(macall)) throw new Error('gif Ma call not found');
  code = code.replace(macall, 'const Z=await Ma(i[J],o,h,$,w,e.scale||1,e.cimSize||0)');
  return code;
});

// --- decode：帧处理先尝试彩色解码 ---
s1 = patchWorker(s1, 'decode', (code) => {
  code = injectCodec(code);
  const ys = 'async function ys(r){const n=await mi(r,{..._t,maxSymbols:vs()});if(n.length===0)return;let i=0;for(const u of n){let s;try{s=Di(u.bytes)}catch{continue}if(await ws(u,s,i===0)&&(i++,b!=null&&b.completed)){Vr(b);return}}b&&i>0&&Vr(b)}';
  if (!code.includes(ys)) throw new Error('decode ys not found');
  code = code.replace(ys,
    'async function ys(r){let cp=[];if(CimQR.maybeColor(r.data,r.width,r.height)){try{cp=CimQR.decode(r.data,r.width,r.height)||[]}catch(e2){cp=[]}}if(cp.length>0){let i=0;for(const by of cp){let s;try{s=Di(by)}catch{continue}if(await ws({version:0},s,i===0)&&(i++,b!=null&&b.completed)){Vr(b);return}}b&&i>0&&Vr(b);return}' +
    'const n=await mi(r,{..._t,maxSymbols:vs()});if(n.length===0)return;let i=0;for(const u of n){let s;try{s=Di(u.bytes)}catch{continue}if(await ws(u,s,i===0)&&(i++,b!=null&&b.completed)){Vr(b);return}}b&&i>0&&Vr(b)}');
  // 实时帧"保最新"策略：解码处理中到达的实时帧不排队（相机 30fps 永远有新帧），
  // 只保留最新一帧（pendingLatest），处理完立即跟进——消除积压与陈旧画面延迟
  // 帧哈希去重：发送端循环播放时重复帧占大多数（同一符号反复出现），
  // 廉价像素哈希命中历史帧 → 直接跳过（包必重复，dedup 会拦），省全部解码开销
  const msgs = 'function ms(r,n){if(n&&Ae.reduce((u,s)=>u+(s.realtime?1:0),0)>=hs){const u=Ae.findIndex(s=>s.realtime);u>=0&&Ae.splice(u,1)}Ae.push({imageData:r,realtime:n}),gs()}async function gs(){if(!Xt){Xt=!0;try{for(;Ae.length>0;){const r=Ae.shift();try{await ys(r.imageData),b!=null&&b.completed&&(Ae=[])}catch(n){self.postMessage({type:"error",message:`Frame error: ${n.message??String(n)}`})}}}finally{Xt=!1}}}';
  if (!code.includes(msgs)) throw new Error('decode ms/gs not found');
  code = code.replace(msgs,
    'var pendingLatest=null;var fhCache=new Map;function fhKey(r){var d=r.data,w=r.width,h=r.height,hh=0,st=Math.max(4,Math.floor(Math.max(w,h)/64));for(var y=0;y<h;y+=st)for(var x=0;x<w;x+=st){var o=(y*w+x)*4;var v=((d[o]>>4)&3)|((d[o+1]>>4)&3)<<2|((d[o+2]>>4)&3)<<4;hh=((hh*31)+v)>>>0}return hh}function ms(r,n){if(n){if(Xt){pendingLatest=r;return}var hk=fhKey(r);if(fhCache.has(hk)){return}if(fhCache.size>64)fhCache.clear();fhCache.set(hk,1);if(Ae.length===0){Ae.push({imageData:r,realtime:!0}),gs();return}const u=Ae.findIndex(s=>s.realtime);u>=0&&Ae.splice(u,1)}Ae.push({imageData:r,realtime:n}),n||gs()}async function gs(){if(!Xt){Xt=!0;try{for(;;){if(pendingLatest){Ae.push({imageData:pendingLatest,realtime:!0}),pendingLatest=null}if(Ae.length===0)break;const r=Ae.shift();try{await ys(r.imageData),b!=null&&b.completed&&(Ae=[],pendingLatest=null)}catch(n){self.postMessage({type:"error",message:`Frame error: ${n.message??String(n)}`})}}}finally{Xt=!1}}}');
  // reset 时清空帧哈希缓存（新扫描画面全新）
  code = code.split('if(n.type==="reset"){b=null,Ae=[],nr=!1,ar=!1;return}')
             .join('if(n.type==="reset"){b=null,Ae=[],nr=!1,ar=!1,fhCache&&fhCache.clear();return}');
  return code;
});

// ---- 2. 修补主 bundle（script2）----
let s2 = script2;

// 2a0. 彩色符号尺寸（像素）模块变量：Standard 1088 / HD 2176，UI 下拉可调，Start 时生效
s2 = 'var colorSizeVar=1088,grabLast=0,grabInterval=40,progLast=0,CIM_CS=[[112,1024,7241],[104,952,6116],[96,880,5241],[80,736,3491],[64,592,2116],[56,520,1616],[48,448,1116],[40,376,616],[32,304,366],[28,268,241],[24,232,116]];' +
     'function _cix(o){return o<=10?10:o<=15?9:o<=20?8:o<=25?6:o<=30?4:o<=35?2:0}' + s2;

// 2a. 编码器列表
{
  const old = 'const Or=["fast-qr-wasm","zxing-wasm"],cn="fast-qr-wasm";';
  if (!s2.includes(old)) throw new Error('Or not found');
  s2 = s2.replace(old, 'const Or=["fast-qr-wasm","zxing-wasm","color-cimbar"],cn="fast-qr-wasm";');
}
// 2b. Wr 归一化 + qt 编码器标签（中英双语）
{
  const old = 'case"zxing-wasm":case"zxing":case"zxingWasm":return"zxing-wasm";default:return cn}}function qt(e){switch(e){case"fast-qr-wasm":return"fast_qr WASM";case"zxing-wasm":return"ZXing WASM"}}';
  if (!s2.includes(old)) throw new Error('Wr/qt not found');
  s2 = s2.replace(old,
    'case"zxing-wasm":case"zxing":case"zxingWasm":return"zxing-wasm";case"color-cimbar":case"colorCimbar":return"color-cimbar";default:return cn}}function qt(e){switch(e){case"fast-qr-wasm":return"fast_qr WASM (快速)";case"zxing-wasm":return"ZXing WASM (兼容)";case"color-cimbar":return"Color CimQR (彩色高速)"}}');
}
// 2c. st 容量（彩色符号：包裹包 7241B → 负载 7229B）
{
  const old = 'function st(e,t,n=cn){const o=Vr(e),a=qr(t),i=n==="zxing-wasm"?Nr(o,a):Qr(o,a),s=i-$r-Ur;return{id:Hn(o,a),label:`V${o}-${a}`,version:o,eccLevel:a,qrEncoder:n,maxPacketSize:i,maxPayloadSize:s}}';
  if (!s2.includes(old)) throw new Error('st not found');
  s2 = s2.replace(old,
    'function st(e,t,n=cn){const o=Vr(e),a=qr(t);let i,s;let ix=0;if(n==="color-cimbar"){ix=_cix(o);i=CIM_CS[ix][2];s=i-$r-Ur}else{i=n==="zxing-wasm"?Nr(o,a):Qr(o,a);s=i-$r-Ur}return{id:Hn(o,a),label:`V${o}-${a}`,version:o,eccLevel:a,qrEncoder:n,maxPacketSize:i,maxPayloadSize:s,cimSize:ix,grid:CIM_CS[ix][0]}}');
}
// 2d. xo 瓦片尺寸（彩色符号固定 1088px 大瓦片；网格/并行按用户选择——多路并发支持）
{
  const old = 'const f=t.version*4+17+so*2,u=Math.max(2,Math.round(lo/f)),y=f*u,R=Po(o),c=Array.from({length:e.length},(b,v)=>v);';
  if (!s2.includes(old)) throw new Error('xo not found');
  s2 = s2.replace(old,
    'const f=t.version*4+17+so*2,u=n==="color-cimbar"?1:Math.max(2,Math.round(lo/f)),y=n==="color-cimbar"?(colorSizeVar||1088):f*u,R=Po(o),c=Array.from({length:e.length},(b,v)=>v);');
}
// 2d2. （已删除：parallelCount/displayFrameCount 原逻辑即正确——R=Po(o) 网格下各瓦片位置不重叠，
//      彩色多路并发由 2d 的大瓦片 + 原逻辑天然支持；单包冻结问题根源是 R 被强制 1 而 parallelCount 仍为 o）
// 2e. 接收端采集分辨率 640 → 1024（彩色符号需要更高分辨率）
{
  const old = 'E=h.videoHeight||640,z=640,L=x/E;';
  if (!s2.includes(old)) throw new Error('z=640 not found');
  s2 = s2.replace(old, 'E=h.videoHeight||640,z=1024,L=x/E;');
}
// 2e1. 采集端节流：按解码速率抓帧（progress 间隔×1.3，30-120ms），
//      省主线程 drawImage/getImageData 开销与无效投递（worker 保最新已兜底）
{
  const old = 'Bt=C(()=>{const h=e.current,T=t.current,l=d.current;if(!h||!T||!l||h.readyState<2)return;';
  if (!s2.includes(old)) throw new Error('Bt not found');
  s2 = s2.replace(old, 'Bt=C(()=>{const h=e.current,T=t.current,l=d.current;if(!h||!T||!l||h.readyState<2)return;if(performance.now()-grabLast<grabInterval)return;grabLast=performance.now();');
}
{
  // progress 到达时自适应抓帧间隔
  const old = 'case"progress":{$(l.totalFrames??0);';
  if (!s2.includes(old)) throw new Error('progress case not found');
  s2 = s2.replace(old, 'case"progress":{if(progLast){var gi=performance.now()-progLast;grabInterval=Math.max(30,Math.min(120,gi*1.3));}progLast=performance.now();$(l.totalFrames??0);');
}
// 2e2. 彩色尺寸：xo scale 传倍率（render worker 用）+ gif 调用传 scale + UI 下拉
{
  const old = 'R.columns,rows:R.rows,version:t.version,eccLevel:t.eccLevel,qrEncoder:n,symbolSize:t.maxPayloadSize,scale:u,displayFrameCount:';
  if (!s2.includes(old)) throw new Error('xo scale not found');
  s2 = s2.replace(old, 'R.columns,rows:R.rows,version:t.version,eccLevel:t.eccLevel,qrEncoder:n,symbolSize:t.maxPayloadSize,scale:n==="color-cimbar"?(colorSizeVar||1088)/(CIM_CS[t.cimSize][1]+64):u,cimSize:t.cimSize,displayFrameCount:');
}
{
  const old = 'parallelCount:l.parallelCount,packetOrder:l.loopOrder})});if(g!==le.current)';
  if (!s2.includes(old)) throw new Error('gif call not found');
  s2 = s2.replace(old, 'parallelCount:l.parallelCount,packetOrder:l.loopOrder,scale:l.qrEncoder==="color-cimbar"?(colorSizeVar||1088)/(CIM_CS[_cix(l.version)][1]+64):1,cimSize:l.qrEncoder==="color-cimbar"?_cix(l.version):0})});if(g!==le.current)');
}
{
  const old = 'children:Or.map(l=>r("option",{value:l,children:qt(l)},l))})]}),r("label",{children:[r("div",{style:{...p.row,justifyContent:"space-between",alignItems:"baseline"},children:[r("spa';
  if (!s2.includes(old)) throw new Error('encoder select not found');
  s2 = s2.replace(old,
    'children:Or.map(l=>r("option",{value:l,children:qt(l)},l))})]}),k==="color-cimbar"&&r("label",{children:[r("div",{style:{...p.row,justifyContent:"space-between",alignItems:"baseline"},children:[r("span",{style:p.label,children:"Color size (彩色尺寸)"}),r("span",{style:p.infoValue,children:[colorSizeVar," px"]})]}),r("select",{style:p.select,onChange:l=>{colorSizeVar=Number(l.target.value)||1088},children:[r("option",{value:544,children:"Compact (紧凑) 544"}),r("option",{value:1088,children:"Standard (标准) 1088"}),r("option",{value:2176,children:"HD (高清) 2176"})]})]}),r("label",{children:[r("div",{style:{...p.row,justifyContent:"space-between",alignItems:"baseline"},children:[r("spa');
}
// 2f. UI 中文化：所有选项/按钮/区域标题 英文后附中文括号翻译
{
  const pairs = [
    // 标签函数（选项下拉）
    ['function wo(e){switch(e){case"L":return"L - low";case"M":return"M - medium";case"Q":return"Q - quartile";case"H":return"H - high"}}',
     'function wo(e){switch(e){case"L":return"L - low (低)";case"M":return"M - medium (中)";case"Q":return"Q - quartile (四分位)";case"H":return"H - high (高)"}}'],
    ['function Ht(e){switch(e){case"fast-start":return"Fast start";case"even-spread":return"Even spread";case"balanced":default:return"Balanced"}}',
     'function Ht(e){switch(e){case"fast-start":return"Fast start (快速开始)";case"even-spread":return"Even spread (均匀分布)";case"balanced":default:return"Balanced (均衡)"}}'],
    ['function Ve(e){return e==="auto"?"Auto":e==="wasm-raptorq"?"RaptorQ WASM":"JS RLNC (deprecated / compatible)"}',
     'function Ve(e){return e==="auto"?"Auto (自动)":e==="wasm-raptorq"?"RaptorQ WASM (喷泉码)":"JS RLNC (旧版兼容)"}'],
    ['function En(e){return e==="fast"?"Fast":e==="balance"?"Balance":e==="robust"?"Robust":"Custom"}',
     'function En(e){return e==="fast"?"Fast (快速)":e==="balance"?"Balance (均衡)":e==="robust"?"Robust (稳健)":"Custom (自定义)"}'],
    ['function Vo(e){return e==="auto"?"Auto (4)":String(e)}',
     'function Vo(e){return e==="auto"?"Auto (4) (自动)":e+" 个"}'],
    // 并行 QR 选项文案
    ['children:or.map(l=>r("option",{value:l,children:[l," QR",l===1?"":"s"," per tick"]},l))',
     'children:or.map(l=>r("option",{value:l,children:[l," QR per tick (每帧 ",l," 个)"]},l))'],
    // 滑杆标签
    ['children:[r("span",{children:"Stable"}),r("span",{children:"Fast"})]',
     'children:[r("span",{children:"Stable (稳定)"}),r("span",{children:"Fast (快速)"})]'],
    ['children:[r("span",{children:"Less QR"}),r("span",{children:"More repair"})]',
     'children:[r("span",{children:"Less QR (少纠错)"}),r("span",{children:"More repair (多纠错)"})]'],
    // 高级设置开关（发送端 + 接收端）
    ['children:U?"Hide advanced settings":"Advanced settings"',
     'children:U?"Hide advanced settings (隐藏高级设置)":"Advanced settings (高级设置)"'],
    ['children:Ce?"Hide advanced settings":"Advanced settings"',
     'children:Ce?"Hide advanced settings (隐藏高级设置)":"Advanced settings (高级设置)"'],
  ];
  for (const [old, neu] of pairs) {
    if (!s2.includes(old)) throw new Error('UI patch not found: ' + old.slice(0, 50));
    s2 = s2.split(old).join(neu);
  }
  // 按钮与文案（多处出现 → 全局替换）
  {
    const oldOpt = 'children:Ft.map(l=>{const g=st(l,b,k);return r("option",{value:l,children:["V",l," · ",g.maxPayloadSize," B/frame"]},l)})';
    if (!s2.includes(oldOpt)) throw new Error('QR size option not found');
    s2 = s2.replace(oldOpt,
      'children:Ft.map(l=>{const g=st(l,b,k);return r("option",{value:l,children:k==="color-cimbar"?["Cim ",g.grid,"×",g.grid," · ",g.maxPayloadSize," B/frame"]:["V",l," · ",g.maxPayloadSize," B/frame"]},l)})');
  }
  const globals = [
    [':"Start Live QR"', ':"Start Live QR (开始实时二维码)"'],
    ['children:"▶ Start Scan"', 'children:"▶ Start Scan (开始扫描)"'],
    ['children:"■ Stop Scan"', 'children:"■ Stop Scan (停止扫描)"'],
    ['children:"Stop"', 'children:"Stop (停止)"'],
    ['children:"Fullscreen QR"', 'children:"Fullscreen QR (全屏)"'],
    ['children:"Choose file"', 'children:"Choose file (选择文件)"'],
    [':"No file selected"', ':"No file selected (未选择文件)"'],
    [':"Prepare GIF"', ':"Prepare GIF (生成动图)"'],
    ['"Download GIF (",Math.round(X.gifData.byteLength/1024)," KB)"]', '"Download GIF (下载动图 ",Math.round(X.gifData.byteLength/1024)," KB)"]'],
    ['children:"File"}),r("button",{style:p.toggleBtn(e==="text"),onClick:()=>at("text"),children:"Text"})',
     'children:"File (文件)"}),r("button",{style:p.toggleBtn(e==="text"),onClick:()=>at("text"),children:"Text (文本)"})'],
    ['children:"QR size"', 'children:"QR size (尺寸)"'],
    ['children:"QR ECC"', 'children:"QR ECC (纠错)"'],
    ['children:"QR encoder"', 'children:"QR encoder (编码器)"'],
    ['children:"FEC codec"', 'children:"FEC codec (纠错码)"'],
    ['children:"RaptorQ repair"', 'children:"RaptorQ repair (修复比例)"'],
    ['children:"RaptorQ playback"', 'children:"RaptorQ playback (播放策略)"'],
    ['children:"QR speed"', 'children:"QR speed (速度)"'],
    ['children:"Parallel QR"', 'children:"Parallel QR (并发数)"'],
    ['children:"Decode preset"', 'children:"Decode preset (解码预设)"'],
    ['children:"Binarizer"', 'children:"Binarizer (二值化)"'],
    ['children:"Max symbols"', 'children:"Max symbols (最大符号数)"'],
    ['children:"Live QR Transfer"', 'children:"Live QR Transfer (实时传输)"'],
    ['children:"Transfer Info"', 'children:"Transfer Info (传输信息)"'],
    ['children:"Original size"', 'children:"Original size (原始大小)"'],
    ['children:"Preprocessed size"', 'children:"Preprocessed size (压缩后)"'],
    ['children:"QR packets"', 'children:"QR packets (包数)"'],
  ];
  for (const [old, neu] of globals) {
    if (!s2.includes(old)) throw new Error('UI global patch not found: ' + old.slice(0, 50));
    s2 = s2.split(old).join(neu);
  }
  console.log('UI 中文化补丁: ' + (pairs.length + globals.length) + ' 处');
}

// ---- 3. 重新组装 ----
const out = head + '<script>' + s1 + '</script>' + between + '<script type="module">' + s2 + '</script>' + tail;
fs.writeFileSync(DST, out);
console.log('written', DST, out.length, 'bytes');

// ---- 4. 校验：提取修补后的 worker 源码（语法检查由外部 node --check 以模块方式完成）----
function checkWorker(name) {
  const re = new RegExp('__RQR_WORKERS\\.' + name + '\\s*=\\s*"data:text/javascript;base64,([^"]+)"');
  const m = s1.match(re);
  if (!m) throw new Error('worker ' + name + ' missing after build');
  const code = Buffer.from(m[1], 'base64').toString('utf8');
  fs.writeFileSync('test/fixtures/check_' + name + '.mjs', code);
  console.log('worker', name, 'extracted,', code.length, 'chars');
}
checkWorker('qr_render');
checkWorker('gif');
checkWorker('decode');
fs.writeFileSync('test/fixtures/check_bundle.mjs', s2);
console.log('bundle extracted,', s2.length, 'chars');
