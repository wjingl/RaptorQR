'use strict';
/* ============================================================================
 * 预置脚本：把根目录现有 RaptorQR_彩色版.html 复制到 app/sender/
 * 该副本是服务端 /app 与接收端构建的来源，构建/部署前需执行一次。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'RaptorQR_彩色版.html');
const DST_DIR = path.join(__dirname, '..', 'app', 'sender');
const DST = path.join(DST_DIR, 'RaptorQR_彩色版.html');

if (!fs.existsSync(SRC)) {
  console.error(`未找到源文件: ${SRC}`);
  console.error('请先在项目根目录运行 node build_color.js 生成彩色版单文件。');
  process.exit(1);
}
fs.mkdirSync(DST_DIR, { recursive: true });
fs.copyFileSync(SRC, DST);
const size = fs.statSync(DST).size;
console.log(`已复制 ${path.basename(SRC)} → ${DST}（${(size / 1048576).toFixed(2)} MB）`);
