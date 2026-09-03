/* ============================================================================
 * RaptorQR 彩色化构建脚本
 * 将 CimQR 编解码器注入 3 个 worker（render/gif/decode），并修补主 bundle，
 * 最终生成彩色化单文件 HTML。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'RaptorQR_离线单文件版.html');
const DST = path.join(ROOT, 'RaptorQR_彩色版.html');
const CODEC_PATH = path.join(ROOT, 'cimqr_codec.js');
const CODEC = fs.readFileSync(CODEC_PATH, 'utf8');

const html = fs.readFileSync(SRC, 'utf8');

// ---- 提取两个 script ----
const script1TagStart = html.indexOf('<script>');
const s1Start = script1TagStart + '<script>'.length;
const s1End = html.indexOf('</script>', s1Start);
const moduleTagStart = html.indexOf('<script type="module">');
const s2Start = moduleTagStart + '<script type="module">'.length;
const s2End = html.indexOf('</script>', s2Start);
if (script1TagStart < 0 || moduleTagStart < 0) throw new Error('script boundaries not found');
// 剥离静态 boot-shell：React 18 createRoot 不清空容器，壳会残留在应用下方显示 "Preparing runtime assets…"
const head = html.slice(0, script1TagStart).replace(/<main class="boot-shell">[\s\S]*?<\/main>/, '');
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
  // 只按 codec 的稳定导出标记防重复；worker 业务代码本身也可能出现 "CimQR" 文本，
  // 不能用宽泛 includes('CimQR') 跳过注入，否则 source 与出厂 worker 会静默漂移。
  if (code.includes('CimQR — 彩色 cimbar/QR 混合编解码器')) return code;
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
    'async function ys(r,epoch){if(epoch!==void 0&&epoch!==queueEpoch)return;var mc=CimQR.maybeColor(r.data,r.width,r.height),cp=[],n=[],qrSource="raw";' +
    // maybeColor 只作为顺序优化提示：黑白帧先走标准 QR，标准 QR 失败后仍继续彩色解析。
    'try{if(!r||!r.data||!r.width||!r.height)return;const accept=async(list,standard,source)=>{if(!list||!list.length)return false;try{var inf=standard?{stage:"qr-standard",format:"qr-standard",symbols:list.length,source:source,version:list[0]&&list[0].version||0}:{...CimQR.info(),source:source};inf.symbols=list.length;inf.symbolsPerFrame=list.length;self.postMessage({type:"single-code",info:inf,color:!standard})}catch{}let accepted=0;for(const item of list){let packet;try{packet=standard?Di(item.bytes):Di(item)}catch{continue}if(await ws(standard?item:{version:0},packet,accepted===0)&&(accepted++,b!=null&&b.completed)){Vr(b);return true}}if(b&&accepted>0)Vr(b);return accepted>0};' +
    'if(!mc){n=await mi(r,{..._t,maxSymbols:vs()});if(await accept(n,true,"raw"))return;n=[];}' +
    'try{cp=CimQR.decode(r.data,r.width,r.height)||[]}catch(e2){cp=[]}' +
    'try{self.postMessage({type:"single-code",info:CimQR.info(),color:cp.length>0||mc})}catch(e3){}' +
    'if(cp.length&&await accept(cp,false,"full"))return;' +
    'if(mc)n=await mi(r,{..._t,maxSymbols:vs()});' +
    'if(n.length===0){try{const e=CimQR.enhance(r.data,r.width,r.height);qrSource="enhanced";n=await mi({data:e.data,width:e.width,height:e.height},{..._t,maxSymbols:vs()})}catch(e4){}}' +
    'if(n.length===0){try{self.postMessage({type:"single-code",info:{stage:mc?"color-parse-failed":"qr-no-result",format:mc?"color-cimbar":"qr-standard",symbols:0,source:qrSource},color:mc})}catch(e5){}return}' +
    'await accept(n,true,qrSource);' +
    '}finally{try{CimQR.releaseFrame&&CimQR.releaseFrame()}catch{}}}');
  // 实时帧"保最新"策略：解码处理中到达的实时帧不排队（相机 30fps 永远有新帧），
  // 只保留最新一帧（pendingLatest），处理完立即跟进——消除积压与陈旧画面延迟
  // 帧哈希去重：发送端循环播放时重复帧占大多数（同一符号反复出现），
  // 廉价像素哈希命中历史帧 → 直接跳过（包必重复，dedup 会拦），省全部解码开销
  const msgs = 'function ms(r,n){if(n&&Ae.reduce((u,s)=>u+(s.realtime?1:0),0)>=hs){const u=Ae.findIndex(s=>s.realtime);u>=0&&Ae.splice(u,1)}Ae.push({imageData:r,realtime:n}),gs()}async function gs(){if(!Xt){Xt=!0;try{for(;Ae.length>0;){const r=Ae.shift();try{await ys(r.imageData),b!=null&&b.completed&&(Ae=[])}catch(n){self.postMessage({type:"error",message:`Frame error: ${n.message??String(n)}`})}}}finally{Xt=!1}}}';
  if (!code.includes(msgs)) throw new Error('decode ms/gs not found');
  code = code.replace(msgs,
    'var pendingLatest=null,fhCache=new Map,queueEpoch=0,MAX_NONREALTIME_QUEUE=8;function fhKey(r){var d=r.data,w=r.width,h=r.height,hh=0,st=Math.max(4,Math.floor(Math.max(w,h)/64));for(var y=0;y<h;y+=st)for(var x=0;x<w;x+=st){var o=(y*w+x)*4;var v=((d[o]>>4)&3)|((d[o+1]>>4)&3)<<2|((d[o+2]>>4)&3)<<4;hh=((hh*31)+v)>>>0}return hh}function clearDecodeQueue(){Ae.length=0;pendingLatest=null}function ms(r,n){if(b&&b.completed)return;if(n){if(Xt){pendingLatest=r;return}var hk=fhKey(r);if(fhCache.has(hk))return;if(fhCache.size>64)fhCache.clear();fhCache.set(hk,1);if(Ae.length===0){Ae.push({imageData:r,realtime:!0}),gs();return}var u=Ae.findIndex(s=>s.realtime);u>=0&&Ae.splice(u,1);if(Ae.length>1)Ae.splice(0,Ae.length-1)}else{if(Ae.length>=MAX_NONREALTIME_QUEUE)Ae.shift();Ae.push({imageData:r,realtime:!1})}n||gs()}async function gs(){if(!Xt){Xt=!0;var ep=queueEpoch;try{for(;;){if(ep!==queueEpoch)break;if(pendingLatest){Ae.push({imageData:pendingLatest,realtime:!0}),pendingLatest=null}if(Ae.length===0)break;const r=Ae.shift();try{await ys(r.imageData,ep),self.postMessage({type:"frame-ack"}),b!=null&&b.completed&&(clearDecodeQueue(),queueEpoch++)}catch(n){self.postMessage({type:"frame-ack"}),self.postMessage({type:"error",message:`Frame error: ${n.message??String(n)}`})}}}finally{Xt=!1;if(pendingLatest||Ae.length>0)gs()}}}');
  // FEC 状态上限与元数据锁定：永不完成/恶意流不能让 generation Map、dedup Set
  // 和 RLNC 行数据无限增长；完成、reset、异常都主动断开当前 decoder 引用。
  // JS RLNC 的 totalGenerations 是代数，保持 256 上限；WASM RaptorQ 的
  // symbolIndex=31 路由中该 12-bit 字段承载输出包总数，协议上限为 4095。
  const fecMarker = 'const hs=60,ps=4;let b=null,Ae=[],Xt=!1,_t=Te,Ct=nn,nr=!1,ar=!1;';
  if (!code.includes(fecMarker)) throw new Error('FEC state marker not found');
  code = code.replace(fecMarker,
    'const hs=60,ps=4,MAX_DATA_LENGTH=67108864,MAX_GENERATIONS=256,MAX_WASM_GENERATIONS=4095,MAX_UNIQUE_PACKETS=8192,MAX_ACCEPTED_BYTES=134217728;let b=null,Ae=[],Xt=!1,_t=Te,Ct=nn,nr=!1,ar=!1;function disposeFec(){if(!b)return;try{if(b.decoder&&b.decoder.inner&&typeof b.decoder.inner.free==="function")b.decoder.inner.free();else if(b.decoder&&typeof b.decoder.free==="function")b.decoder.free();}catch{};b=null}function guardHeader(u,payloadLen){var maxGenerations=u&&u.symbolIndex===31?MAX_WASM_GENERATIONS:MAX_GENERATIONS;if(!u||!Number.isInteger(u.dataLength)||u.dataLength<0||u.dataLength>MAX_DATA_LENGTH||!Number.isInteger(u.totalGenerations)||u.totalGenerations<1||u.totalGenerations>maxGenerations||!Number.isInteger(u.generationIndex)||u.generationIndex<0||u.generationIndex>=u.totalGenerations||!Number.isInteger(u.symbolIndex)||u.symbolIndex<0||u.symbolIndex>31||!Number.isInteger(payloadLen)||payloadLen<5||payloadLen>1048576)return false;return true}');
  const wsGuard = 'async function ws(r,n,i){const u=ki(n.header);return $s(u)?u==="wasm-raptorq"?_s(r,n,i):bs(r,n,i):(lr(u),!1)}';
  if (!code.includes(wsGuard)) throw new Error('FEC ws marker not found');
  code = code.replace(wsGuard,
    'async function ws(r,n,i){if(!n||!guardHeader(n.header,n.payload&&n.payload.length)){disposeFec();self.postMessage({type:"error",message:"FEC header rejected: limits or metadata invalid"});return false}const u=ki(n.header);return $s(u)?u==="wasm-raptorq"?_s(r,n,i):bs(r,n,i):(lr(u),!1)}');
  code = code.replace('function bs(r,n,i){const u=n.header;',
    'function bs(r,n,i){const u=n.header;if(b&&((b.codec!=="js-rlnc")||b.dataLength!==u.dataLength||b.totalGenerations!==u.totalGenerations||b.symbolSize!==n.payload.length||b.isText!==u.isText||b.isCompressed!==u.compressed))return false;');
  code = code.replace('function _s(r,n,i){const u=n.header;',
    'function _s(r,n,i){const u=n.header;if(b&&((b.codec!=="wasm-raptorq")||b.dataLength!==u.dataLength||b.totalGenerations!==u.totalGenerations||b.symbolSize!==n.payload.length||b.isText!==u.isText||b.isCompressed!==u.compressed))return false;');
  code = code.replace('completed:!1,stats:{totalFrames:0,framesWithQR:0,acceptedPackets:0}}}',
    'completed:!1,acceptedBytes:0,stats:{totalFrames:0,framesWithQR:0,acceptedPackets:0}}}', true);
  code = code.replace('completed:!1,stats:{totalFrames:0,framesWithQR:0,acceptedPackets:0}}}',
    'completed:!1,acceptedBytes:0,stats:{totalFrames:0,framesWithQR:0,acceptedPackets:0}}}', true);
  code = code.replace('b.dedup.add(s);const h=u.generationIndex;',
    'if(b.dedup.size>=MAX_UNIQUE_PACKETS||b.acceptedBytes+n.payload.length>MAX_ACCEPTED_BYTES){disposeFec();return false}b.dedup.add(s);b.acceptedBytes+=n.payload.length;const h=u.generationIndex;');
  code = code.replace('b.dedup.add(s),b.stats.acceptedPackets++,b.receivedPackets++;',
    'if(b.dedup.size>=MAX_UNIQUE_PACKETS||b.acceptedBytes+n.payload.length>MAX_ACCEPTED_BYTES){disposeFec();return false}b.dedup.add(s),b.acceptedBytes+=n.payload.length,b.stats.acceptedPackets++,b.receivedPackets++;');

  // 将单码 codec 的全分辨率缓存限制在当前帧生命周期内，避免排队帧长期持有 rawRGBA。
  const ysHead = 'async function ys(r,epoch){if(epoch!==void 0&&epoch!==queueEpoch)return;var mc=CimQR.maybeColor(r.data,r.width,r.height),cp=[],n=[],qrSource="raw";';
  if (!code.includes(ysHead)) throw new Error('decode ys head not found');
  // `ys` replacement already owns the per-frame try/finally; do not wrap it a second time.
  code = code.replace('r.completed=!0}', 'r.completed=!0;try{if(r.decoder&&r.decoder.inner&&typeof r.decoder.inner.free==="function")r.decoder.inner.free();}catch{};r.decoder=null;r.dedup&&r.dedup.clear();clearDecodeQueue()}');
  code = code.replace('if(n.type==="frame"){let i=n.imageData??n.frameData??null;', 'if(n.type==="frame"){if(b&&b.completed)return;let i=n.imageData??n.frameData??null;');

  // reset 时清空帧哈希、pendingLatest 和队列 epoch；旧异步 drain 返回后不能复活旧帧。
  code = code.split('if(n.type==="reset"){b=null,Ae=[],nr=!1,ar=!1;return}')
             .join('if(n.type==="reset"){disposeFec(),clearDecodeQueue(),queueEpoch++,nr=!1,ar=!1,fhCache&&fhCache.clear();return}');
  return code;
});

// ---- 2. 修补主 bundle（script2）----
let s2 = script2;

// 2a0. 彩色符号尺寸（像素）模块变量：Standard 1088 / HD 2176，UI 下拉可调，Start 时生效
s2 = 'var colorSizeVar=1088,grabLast=0,grabInterval=40,progLast=0,userPickedSize=false,CIM_CS=[[112,1024,7241],[104,952,6116],[96,880,5241],[80,736,3491],[64,592,2116],[56,520,1616],[48,448,1116],[40,376,616],[32,304,366],[28,268,241],[24,232,116]];' +
     'function _cix(o){return o<=10?10:o<=15?9:o<=20?8:o<=25?6:o<=30?4:o<=35?2:0}' + s2;

// 接收端生命周期补丁：所有异步扫描动作共享会话序号，旧的 getUserMedia、RAF、worker
// 和 GIF 任务在 Stop/切换/卸载后都不能重新接管资源或继续向 UI/FEC 写入。
{
  const init = 'de=I(0),we=I(0),ve=I(0),Ke=I([]),me=I(pt),Ue=I(tn),Fe=Wo(qe),N=I(Fe);';
  if (!s2.includes(init)) throw new Error('receiver state init marker not found');
  s2 = s2.replace(init,
    'scanEpoch=I(0),scanStarting=I(!1),gifAck=I(null),scanScrollRaf=I(null),scanScrollTimer=I(null),' + init);

  const atStart = s2.indexOf('function at(){');
  const atEnd = s2.indexOf('const At=', atStart);
  if (atStart < 0 || atEnd < 0) throw new Error('receiver worker handler bounds not found');
  let atCode = s2.slice(atStart, atEnd);
  atCode = atCode.replace('function at(){', 'function at(token){token=token==null?scanEpoch.current:token;');
  atCode = atCode.replace('const l=T.data;switch(l.type)', 'if(token!==scanEpoch.current||d.current&&d.current!==h)return;const l=T.data;if(l.type==="frame-ack"){const a=gifAck.current;if(a){gifAck.current=null;a()}return}switch(l.type)');
  atCode = atCode.replace('F("Complete ✓"),l.autoStop&&Je(),scanScrollRaf.current=', 'F("Complete ✓"),l.autoStop&&stopSession(),scanScrollRaf.current=');
  atCode = atCode.replace('h.onerror=T=>{ce(`Worker error: ${T.message}`)}',
    'h.onerror=T=>{if(token!==scanEpoch.current||d.current&&d.current!==h)return;ce(`Worker error: ${T.message}`);if(d.current===h){d.current=null;try{h.onmessage=null;h.onerror=null;h.terminate()}catch{};scanEpoch.current++}}');
  s2 = s2.slice(0, atStart) + atCode + s2.slice(atEnd);

  const stopMarker = 'const At=C(async h=>{';
  if (!s2.includes(stopMarker)) throw new Error('receiver stop insertion marker not found');
  const stopFn = 'const stopSession=C(status=>{scanEpoch.current++;scanStarting.current=!1;y.current=!1;v(!1);if(u.current!==null){cancelAnimationFrame(u.current);u.current=null}if(scanScrollRaf.current!==null){cancelAnimationFrame(scanScrollRaf.current);scanScrollRaf.current=null}if(scanScrollTimer.current!==null){window.clearTimeout(scanScrollTimer.current);scanScrollTimer.current=null}if(e.current){try{e.current.pause()}catch{};e.current.srcObject=null}if(f.current){try{f.current.getTracks().forEach(h=>h.stop())}catch{};f.current=null}if(d.current){const h=d.current;d.current=null;try{h.onmessage=null;h.onerror=null;h.terminate()}catch{}}if(gifAck.current){const h=gifAck.current;gifAck.current=null;try{h()}catch{}}if(status!==void 0)F(status);Z(!1);We(1)},[]),';
  s2 = s2.replace(stopMarker, stopFn + 'At=C(async h=>{');

  const start = 'Qt=C(async()=>{var h;';
  if (!s2.includes(start)) throw new Error('receiver camera start marker not found');
  s2 = s2.replace(start,
    'Qt=C(async()=>{var h;if(scanStarting.current||b)return;stopSession();const token=scanEpoch.current;scanStarting.current=!0;');
  s2 = s2.replace('!((h=navigator.mediaDevices)!=null&&h.getUserMedia)){ce(jo());return}', '!((h=navigator.mediaDevices)!=null&&h.getUserMedia)){scanStarting.current=!1;ce(jo());return}');
  s2 = s2.replace('f.current=T;const l=T.getVideoTracks()[0];',
    'if(token!==scanEpoch.current){try{T.getTracks().forEach(h=>h.stop())}catch{};scanStarting.current=!1;return}f.current=T;const l=T.getVideoTracks()[0];');
  s2 = s2.replace('e.current&&(e.current.srcObject=T,await e.current.play());const g=at();',
    'e.current&&(e.current.srcObject=T,await e.current.play());if(token!==scanEpoch.current){try{T.getTracks().forEach(h=>h.stop())}catch{};if(e.current)e.current.srcObject=null;scanStarting.current=!1;return}const g=at(token);');
  s2 = s2.replace('}),d.current=g,v(!0),y.current=!0,F("Scanning…");let x=0;const E=z=>{y.current&&(z-x>=N.current&&(Bt(),x=z),u.current=requestAnimationFrame(E))};u.current=requestAnimationFrame(E)}catch(T){ce(`Camera error: ${T.message??String(T)}`)}',
    '}),d.current=g,v(!0),y.current=!0,scanStarting.current=!1,F("Scanning…");let x=0;const E=z=>{if(token!==scanEpoch.current||!y.current){u.current=null;return}if(z-x>=N.current){Bt();x=z}u.current=requestAnimationFrame(E)};u.current=requestAnimationFrame(E)}catch(T){scanStarting.current=!1;stopSession();ce(`Camera error: ${T.message??String(T)}`)}');

  const gifStart = 'Nt=C(async h=>{var x;';
  if (!s2.includes(gifStart)) throw new Error('receiver GIF start marker not found');
  s2 = s2.replace(gifStart,
    'Nt=C(async h=>{var x;if(scanStarting.current||b)return;stopSession();const token=scanEpoch.current;scanStarting.current=!0;');
  s2 = s2.replace('const l=(x=h.target.files)==null?void 0:x[0];if(!l)return;', 'const l=(x=h.target.files)==null?void 0:x[0];if(!l){scanStarting.current=!1;return};');
  s2 = s2.replace('const g=at();g.postMessage({', 'const g=at(token);g.postMessage({');
  s2 = s2.replace('for(let P=0;P<L.frames.length&&y.current;P++){const M=Do(L,P),W=M.buffer.slice(M.byteOffset,M.byteOffset+M.byteLength);g.postMessage({type:"frame",pixels:W,width:L.width,height:L.height},[W])}F("GIF processed")',
    'for(let P=0;P<L.frames.length&&y.current&&token===scanEpoch.current;P++){const M=Do(L,P),W=M.buffer.slice(M.byteOffset,M.byteOffset+M.byteLength);await new Promise((resolve,reject)=>{let done=!1;const timer=window.setTimeout(()=>{if(done)return;done=!0;if(gifAck.current===ack)gifAck.current=null;reject(new Error("GIF worker timeout"))},5000);const ack=()=>{if(done)return;done=!0;window.clearTimeout(timer);if(gifAck.current===ack)gifAck.current=null;resolve()};gifAck.current=ack;try{g.postMessage({type:"frame",pixels:W,width:L.width,height:L.height},[W])}catch(err){window.clearTimeout(timer);if(gifAck.current===ack)gifAck.current=null;reject(err)}})}F("GIF processed")');
  s2 = s2.replace('}finally{y.current=!1,v(!1)}},[]),Je=',
    '}finally{scanStarting.current=!1;y.current=!1;v(!1);if(d.current===g){d.current=null;try{g.onmessage=null;g.onerror=null;g.terminate()}catch{}}}},[]),Je=');
  s2 = s2.replace('Je=C(()=>{v(!1),y.current=!1,cancelAnimationFrame(u.current),e.current&&(e.current.pause(),e.current.srcObject=null),f.current&&(f.current.getTracks().forEach(h=>h.stop()),f.current=null),d.current&&(d.current.terminate(),d.current=null),F("Stopped"),Z(!1),We(1)},[])',
    'Je=C(()=>{stopSession("Stopped")},[])');
  s2 = s2.replace('return Re(()=>()=>{cancelAnimationFrame(u.current),f.current&&f.current.getTracks().forEach(h=>h.stop()),d.current&&d.current.terminate(),s.current!==null&&window.clearTimeout(s.current)}',
    'return Re(()=>()=>{stopSession();s.current!==null&&window.clearTimeout(s.current)}');
  // complete 后的滚动句柄也纳入统一清理，避免卸载后闭包继续持有 DOM。
  s2 = s2.replace('requestAnimationFrame(()=>{setTimeout(()=>{',
    'scanScrollRaf.current=requestAnimationFrame(()=>{scanScrollRaf.current=null;scanScrollTimer.current=window.setTimeout(()=>{scanScrollTimer.current=null;');
  s2 = s2.replace('},100)});break}case"error"', '},100)});break}case"error"');
}

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
// 2e3. 彩色模式强制并行=1：xo() 调用处把 parallelCount 参数替换（displayFrameCount=ceil(包数/1)=包数，循环恢复）
{
  const old = 'const W=xo(M.packets,z,k,ye,';
  if (!s2.includes(old)) throw new Error('xo call not found');
  s2 = s2.replace(old, 'const W=xo(M.packets,z,k,k==="color-cimbar"?1:ye,');
}
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
  s2 = s2.replace(old, 'case"single-code":{if(l.info){const q=l.info;F(q.format==="qr-standard"?`标准 QR ✓ · ${q.symbols||1} 码/帧 · ${q.source||"raw"}`:q.stage==="single-code-ok"?`彩色 CimQR ✓ ${q.grid||"?"}×${q.grid||"?"} · ${q.symbolSize||"?"}px · ${q.informationDensity||"?"} B/码 · ${q.symbols||0} 码/帧`:q.stage==="no-anchor"?"彩色 CimQR：未找到结构锚点（调整距离/反光/对焦）":q.stage==="cell-parse-failed"||q.stage==="color-parse-failed"?`彩色 CimQR：已定位 ${q.grid||"?"}×${q.grid||"?"} 锚点，但单码图形/颜色解析失败`:"正在采样单码结构")}break}case"progress":{if(progLast){var gi=performance.now()-progLast;grabInterval=Math.max(30,Math.min(120,gi*1.3));}progLast=performance.now();$(l.totalFrames??0);');
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
  // 版本下拉手动选择后，自动版本不再覆盖（QR 式：默认按数据量自动选最小网格）
  {
    const oldOn = 'onChange:l=>zt(l.target.value),children:Ft.map';
    if (!s2.includes(oldOn)) throw new Error('version select onChange not found');
    s2 = s2.split(oldOn).join('onChange:l=>{userPickedSize=true;zt(l.target.value)},children:Ft.map');
  }
  // 自动版本（QR 式）：编码前按数据量（压缩后 ×1.2 + 开销）选最小网格——
  // 符号始终充满信息格，无绿色填充/大片空白；手动选档后跳过
  {
    const oldEn = 'const E=g.byteLength>64,z=st(c,b,k);';
    if (!s2.includes(oldEn)) throw new Error('encode anchor not found');
    s2 = s2.replace(oldEn,
      'const E=g.byteLength>64;var _chosen=null;if(k==="color-cimbar"&&!userPickedSize){try{var _comp=g.byteLength;if(E&&typeof CompressionStream!=="undefined"){var _arr=await new Response(new Blob([g]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer();_comp=_arr.byteLength}var _need=Math.ceil(_comp*1.2)+32;for(var _vi=0;_vi<Ft.length;_vi++){var _vv=Ft[_vi];if(st(_vv,b,k).maxPayloadSize>=_need){_chosen=_vv;break}}}catch(e3){}}var z=_chosen?st(_chosen,b,k):st(c,b,k);');
  }
  // 渲染池 render：cimSize 必须随消息下发（审计发现：缺此字段时彩色渲染永远用
  // 默认 112×112——版本/容量改了、网格没动，正是用户看到的现象）
  {
    const oldSig = 'render(t,n,o,a,i){';
    if (!s2.includes(oldSig)) throw new Error('render pool sig not found');
    s2 = s2.replace('render(t,n,o,a,i){', 'render(t,n,o,a,i,c){');
    const oldMsg = 'qrEncoder:i,jobId:d}';
    if (!s2.includes(oldMsg)) throw new Error('render msg not found');
    s2 = s2.split(oldMsg).join('qrEncoder:i,cimSize:c,jobId:d}');
  }
  // 实时渲染调用：把配置的 cimSize 传进渲染池
  {
    const oldCall = 'x.render(lt,l.version,l.eccLevel,l.scale,l.qrEncoder)';
    if (!s2.includes(oldCall)) throw new Error('live render call not found');
    s2 = s2.split(oldCall).join('x.render(lt,l.version,l.eccLevel,l.scale,l.qrEncoder,l.cimSize)');
  }
  // 自动版本 UI 同步：编码完成后更新版本显示（编码/渲染已用自动档位，此处仅刷新下拉）
  {
    const oldWe = 'if(l!==le.current)return;We({originalSize:';
    if (!s2.includes(oldWe)) throw new Error('We anchor not found');
    s2 = s2.split(oldWe).join('if(l!==le.current)return;_chosen&&zt(_chosen);We({originalSize:');
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
  if (!code.includes('CimQR — 彩色 cimbar/QR 混合编解码器')) throw new Error('worker ' + name + ' missing injected codec marker');
  if (name === 'decode') {
    const required = ['function estimateWBGain', 'function hueNearest', 'var lastInfo'];
    for (const marker of required) if (!code.includes(marker)) throw new Error('decode worker missing ' + marker);
  }
  fs.writeFileSync(path.join(ROOT, 'test', 'fixtures', 'check_' + name + '.mjs'), code);
  console.log('worker', name, 'extracted,', code.length, 'chars');
}
checkWorker('qr_render');
checkWorker('gif');
checkWorker('decode');
  fs.writeFileSync(path.join(ROOT, 'test', 'fixtures', 'check_bundle.mjs'), s2);
console.log('bundle extracted,', s2.length, 'chars');
