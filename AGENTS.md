# AGENTS.md — RaptorQR 工作区说明

## 项目定位
两个并列子系统：
1. **RaptorQR 摄像头二维码文件传输**（单文件离线 Web 应用）：发送端播放彩色 CimQR 符号，接收端相机对准屏幕还原文件/文本；黑白 QR 完全兼容。
2. **发送端管理系统 `send_manager/`**（已实现）：内网部署的服务端"文件传出记录管理"系统（登录/审批/批量注册/目的地 jzw·bgw·my·sjw/记录与统计/总管理与审计/一键部署），详见其 README.md。

开发环境为 WSL/Linux：既有项目用 Node v20.18；**send_manager 一律用其捆绑的 Node 24**（`send_manager/runtime/bin/node`）。**不得破坏现有任何文件**。

## 现有结构（根目录，唯一子目录是 tools/）
- `RaptorQR_离线单文件版.html` — 黑白基线单文件应用（构建源）
- `RaptorQR_彩色版.html` — `node build_color.js` 生成的彩色版产物（与 Pages 托管同根）
- `cimqr_codec.js` — 彩色编解码核心（纯 JS、UMD、无依赖，浏览器/Worker/Node 通用）
- `build_color.js` — 构建脚本：把 codec 注入 render/gif/decode 三个 worker（HTML 内 base64 存储），修补主 bundle 后重新生成单文件
- `worker_encode_color.js` / `worker_decode_color.js` / `worker_gif_color.js` / `worker_qr_render.js` — 抽取出的 worker 源码（`_color` 为修补后彩色版，用于 vm 沙箱测试）
- `bundle_patched.js`、`extracted_script_*.js`、`beautified_*.js`、`wasm_map_extracted.js` — 抽取/美化中间产物（不入库）
- `cdp_*.js` — CDP 真实浏览器自动化（`cdp_drive.js` 启动 Edge + `--remote-debugging-port`）
- `tools/node_modules` — 本地依赖（js-beautify 等），纯本地
- `send_manager/` — **发送端管理系统（服务端）**，独立文件夹，含运行时/依赖/部署脚本，见下节
- `rand_30k.bin`、`cdp_capture.json` 等测试数据在 .gitignore 中

## 构建与测试（全部本地、无需联网）
```bash
node build_color.js    # 重新生成 RaptorQR_彩色版.html
node test_codec.js     # 编解码器单元测试
node test_e2e.js       # RaptorQ 包裹包端到端回路
node test_workers.js / node --experimental-vm-modules test_workers_vm.js  # worker 沙箱验证
node --experimental-vm-modules test_browser_e2e.js   # 真实捕获帧 -> 出厂 worker 逐字节还原
node --experimental-vm-modules test_tolerance.js     # 畸变容错套件
node test_gif_color.js / test_multipacket.js / test_accumulation.js / perf_test.js
node cdp_drive.js      # 真实 Edge UI 驱动 + 彩色帧捕获（需本机 Edge）
```

## 发送端管理系统 send_manager/（已实现）
独立文件夹，**只做发送端**（发送 + 传出记录管理），接收端仍为纯本地 HTML。技术栈：Express 5 + better-sqlite3（WAL）+ bcryptjs + express-session（SQLite，sid 只存 sha256）+ helmet + express-rate-limit + svg-captcha + joi + morgan；Node 24 捆绑在 `runtime/`（开发与部署共用，原生模块 ABI 一致）。
```bash
cd send_manager
./runtime/bin/node scripts/prep.js                 # 从根目录复制发送页副本到 app/sender/
./runtime/bin/node receiver/build_receiver.js      # 生成接收端 real.html / release.html
./runtime/bin/node --test "test/*.test.js"         # 全量测试（29 项：功能+安全）
./runtime/bin/node app/server.js                   # 本地启动（默认 1145，读 config.json）
bash scripts/build_package.sh                      # 打部署包 dist/*.tar.gz（含 node_modules+runtime）
sudo ./deploy/deploy.sh                            # 服务器一键部署（systemd 加固 / nohup 兜底）
./deploy/{start,stop,restart,status,backup,update}.sh  # 日常维护
./runtime/bin/node scripts/cli.js                  # 离线维护（create-admin/reset-password/backup/...）
```
- 架构边界：`RaptorQR_彩色版.html` 副本在 `app/sender/`（prep.js 生成）；`/app` 服务时由 `app/bridge.js` 注入桥接（源文件字节不变）；接收端发布版对 codec 做 base64+XOR 混淆（尽力而为）。
- 关键实现：会话前接口（setup/register/login/captcha）跳过 CSRF 令牌但保留 Origin 校验；请求体上限防内存耗尽；统计用 COALESCE 防空表 null；部署包不能 `npm ci --omit=dev`（会缺依赖 dist），须 `npm ci && npm prune --omit=dev`；tar 打包不能 `--exclude='dist'`（会误删 node_modules 内所有 dist/）。

## 架构边界与规则
- **不要手改 `RaptorQR_彩色版.html`**：它是生成产物；改 codec/worker 后一律 `node build_color.js` 重新生成。
- 彩色帧协议 `[2B长度][magic "QC"][1B格式] + RaptorQ 包裹包（头+负载+CRC32C）` 与黑白完全兼容，不得破坏。
- 彩色模式强制 `parallelCount=1`、`displayFrameCount=包数`（历史"多包卡死"修复，见 README_彩色化.md「发送端播放循环修复」），不要回退。
- 丢帧/容错策略：包级去重 + CRC32C 校验 + RaptorQ 跨帧累积（worker 内），勿改成"等整轮"。
- `cimqr_codec.js` 的 decodeFrame 有容错尝试阶梯，加逻辑须保持第 1 层零额外开销。

## 发送端管理系统设计要点（已实现，详见 send_manager/README.md）
- 用户均为授权者；**总管理**可看所有记录/统计/每人统计，普通用户仅见自己传出记录。
- 账号体系：**自助注册 + 总管理审批**（未审批不能登录）；总管理可手动建号。
- 账号管理（总管理专属）：**注册审批**（通过/驳回+原因）、**批量注册**（粘贴/CSV 导入，统一初始密码 + 首次登录强制改密）、**重置密码**（下次登录强制改密）、**启用/停用/归档**、账号搜索与状态筛选；子账号本人可自行改密（需验证旧密码）。
- 密码安全：密码只存单向哈希（bcrypt），任何人（含总管理）看不到明文、只能重置；登录失败锁定 + 验证码防爆破；所有管理操作写审计日志（谁/何时/做了什么）。
- 传出目的地固定四类：**jzw / bgw / my / sjw**。
- 部署：办公室内网 x86 服务器，默认端口 **1145**，IP+端口访问；服务器无环境且不可联网下载 → 数据库/依赖全本地化进部署包，一键部署 + 维护自动化。
- 安全（企业级标准）：helmet/CSP 分级、CSRF 双提交+Origin 校验、全参数化查询、请求体上限、防路径穿越、专用服务账号 + systemd 加固、无上传/无执行面；接收端 HTML 分"真实版"（完整代码）与"发布版"（base64+XOR 尽力混淆，文档如实声明可被逆向）。
- 现有核心传输业务原样复用（零改动，桥接注入），仅在其上加管理外壳。

## 改前必读
- `README_彩色化.md` — 彩色化完整设计、容错阶梯、播放循环修复、构建/测试清单
- `index.html` — 现有 UI 风格参考（暗色、系统字体、极简）
- `build_color.js` — 改构建相关代码前先理解单文件如何生成
