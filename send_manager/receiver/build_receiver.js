'use strict';
/* ============================================================================
 * 接收端构建：从 app/sender/RaptorQR_彩色版.html 生成两个版本
 * - real.html     真实版：完整单文件应用，初始进入接收界面（代码可读）
 * - release.html  发布版：仅保留 decode worker + 必需 WASM；
 *                 CimQR 编解码核心做 base64+XOR 编码、运行时解码（尽力混淆）
 * 说明：浏览器内运行的程序无法做到绝对防逆向；发布版为"提高逆向成本"的
 * 尽力而为方案，详见 README。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'app', 'sender', 'RaptorQR_彩色版.html');
const CODEC_PATH = path.join(ROOT, '..', 'cimqr_codec.js');
const OUT_DIR = path.join(ROOT, 'receiver', 'out');

const XOR_KEY = 'RaptorQR.CimQR@2026#Receiver';
const BOOT_CALL = 'Er(r(pa,{}),_r)';
const BOOT_KO = 'Er(r(Ko,{}),_r)';
const BOOT_BO = 'Er(r(Bo,{}),_r)';

function splitScripts(html) {
  const s1s = html.indexOf('<script>') + '<script>'.length;
  const s1e = html.indexOf('</script>', s1s);
  const s2s = html.indexOf('<script type="module">') + '<script type="module">'.length;
  const s2e = html.indexOf('</script>', s2s);
  if (s1s < 0 || s2s < 0 || s1e < 0 || s2e < 0) throw new Error('脚本边界定位失败');
  return { script1: html.slice(s1s, s1e), script2: html.slice(s2s, s2e) };
}

function extractWorkerB64(script1, name) {
  const re = new RegExp(`window\\.__RQR_WORKERS\\.${name}\\s*=\\s*"data:text/javascript;base64,([^"]+)"`);
  const m = script1.match(re);
  if (!m) throw new Error(`未找到 ${name} worker`);
  return m[1];
}

function obfuscateCodecLoader(codecSrc) {
  const keyBuf = Buffer.from(XOR_KEY, 'utf8');
  const srcBuf = Buffer.from(codecSrc, 'utf8');
  const out = Buffer.alloc(srcBuf.length);
  for (let i = 0; i < srcBuf.length; i++) out[i] = srcBuf[i] ^ keyBuf[i % keyBuf.length];
  const b64 = out.toString('base64');
  const keyArr = Array.from(keyBuf).join(',');
  // 紧凑 loader：解码 + 间接 eval（worker 全局作用域），设置 self.CimQR
  return `(function(){var K=[${keyArr}];var B=atob("${b64}");var C=new Uint8Array(B.length);for(var i=0;i<B.length;i++){C[i]=B.charCodeAt(i)^K[i%K.length];}var s=new TextDecoder().decode(C);(0,eval)(s);})();\n`;
}

function shell(script1, script2, label) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="theme-color" content="#0d1117" />
<meta name="generator" content="RaptorQR Receiver ${label}" />
<title>RaptorQR 接收端</title>
<style>html,body{margin:0;padding:0;background:#0d1117;color:#c9d1d9;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;}</style>
</head>
<body>
<div id="root"></div>
<script>
${script1}
</script>
<script type="module">
${script2}
</script>
</body>
</html>
`;
}

function buildReal(html, script1, script2) {
  if (!script2.includes(BOOT_CALL)) throw new Error('未找到启动调用（真实版）');
  const s2 = script2.replace(BOOT_CALL, BOOT_KO);
  // 直接渲染主应用，避免启动屏/预载对 file:// 环境不友好；初始 hash 进入接收端
  const hashScript = '<script>location.hash = "receiver";</script>\n';
  const s1 = script1;
  const out = html
    .replace('<script type="module">', hashScript + '<script type="module">')
    .replace(script2, () => s2) // 函数式替换：避免 $ 特殊模式
    .replace(/<title>[^<]*<\/title>/, '<title>RaptorQR 接收端（真实版）</title>');
  // 校验启动调用已替换
  if (out.includes(BOOT_CALL)) throw new Error('真实版启动调用替换失败');
  return out;
}

function buildRelease(script1, script2) {
  if (!script2.includes(BOOT_CALL)) throw new Error('未找到启动调用（发布版）');
  // 1) 取出 decode worker，混淆其内置 CimQR codec
  const workerB64 = extractWorkerB64(script1, 'decode');
  const workerSrc = Buffer.from(workerB64, 'base64').toString('utf8');
  const codec = fs.readFileSync(CODEC_PATH, 'utf8');
  if (!workerSrc.startsWith(codec)) throw new Error('decode worker 未以 CimQR codec 开头，请先执行 node build_color.js 与 scripts/prep.js');
  const releaseWorkerSrc = obfuscateCodecLoader(codec) + workerSrc.slice(codec.length);
  const releaseWorkerB64 = Buffer.from(releaseWorkerSrc, 'utf8').toString('base64');

  // 2) script1 仅保留 decode worker；encode/gif/qr_render 一并移除（接收端不需要）
  let s1 = script1.replace(/window\.__RQR_WORKERS\.(encode|gif|qr_render)\s*=\s*"[^"]*";\s*\n?/g, '');
  s1 = s1.replace(/window\.__RQR_WORKERS\.decode\s*=\s*"[^"]*";/, `window.__RQR_WORKERS.decode = "data:text/javascript;base64,${releaseWorkerB64}";`);

  // 3) script2 直接渲染接收端组件（跳过启动屏/预载/发送端）
  const s2 = script2.replace(BOOT_CALL, BOOT_BO);
  if (s2.includes(BOOT_CALL)) throw new Error('发布版启动调用替换失败');

  const html = shell(s1, s2, 'Release');
  // 安全校验：发布版不应包含可读的 codec 明文特征串
  const checks = ['CimQR — 彩色 cimbar/QR 混合编解码器', 'decodeFrame', 'rsEncode', 'maybeColor', 'detectFinders'];
  for (const c of checks) {
    if (html.includes(c)) {
      // decodeFrame 等可能出现在 codec 之外？codec 已编码，应无明文
      throw new Error(`发布版泄露明文特征：${c}`);
    }
  }
  return html;
}

function main() {
  if (!fs.existsSync(SRC)) throw new Error(`缺少发送页副本：${SRC}\n请先执行 node scripts/prep.js`);
  if (!fs.existsSync(CODEC_PATH)) throw new Error(`缺少 codec：${CODEC_PATH}`);
  const html = fs.readFileSync(SRC, 'utf8');
  const { script1, script2 } = splitScripts(html);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const real = buildReal(html, script1, script2);
  const release = buildRelease(script1, script2);

  fs.writeFileSync(path.join(OUT_DIR, 'real.html'), real);
  fs.writeFileSync(path.join(OUT_DIR, 'release.html'), release);

  const mb = (n) => (n / 1048576).toFixed(2);
  console.log('接收端构建完成:');
  console.log(`  real.html    ${mb(real.length)} MB`);
  console.log(`  release.html ${mb(release.length)} MB`);
}

if (require.main === module) main();

module.exports = { buildReal, buildRelease, obfuscateCodecLoader, splitScripts, extractWorkerB64, OUT_DIR };
