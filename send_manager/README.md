# RaptorQR 发送端文件传出管理系统

内网部署的**发送端文件传出记录管理**系统：用户登录 → 在发送工作台选择文件/文本 → 指定目的地（**jzw / bgw / my / sjw**）→ 播放彩色 CimQR 符号 → 系统自动记录本次传出；普通用户仅见自己的记录，**总管理**可见全部记录、全局统计与每人统计。

- 复用现有 RaptorQR 彩色版发送页（**零改动**，服务时注入桥接层），接收端仍为纯本地 HTML（无需服务器）
- 适配 **Linux x86 服务器**，服务器**无环境、不可联网下载**也能部署（全依赖本地化 + 捆绑 Node 运行时）
- 默认端口 **1145**，IP:端口 访问；一键部署 + 后续维护自动化

---

## 一、架构总览

```
浏览器（办公网）                         服务器（Linux x86，内网 1145）
┌──────────────────────┐                ┌──────────────────────────────┐
│ 登录页/管理页(暗色)    │  HTTPS?不，内网HTTP │ Express 5 + helmet + 会话     │
│ 发送工作台(单文件+桥接) │ ────────────────▶ │  better-sqlite3 (WAL)         │
│ 接收端(纯本地HTML)     │                  │  bcryptjs / captcha / 限流    │
└──────────────────────┘                └──────────────────────────────┘
                                         数据(data/)：db.sqlite + 日志 + secrets
```

| 模块 | 说明 |
|---|---|
| `app/server.js` | Express 5 入口：helmet 安全头、CSP 分级、会话、限流、CSRF、错误处理、优雅停机 |
| `app/db.js` | better-sqlite3：建表、版本化迁移、WAL、checkpoint、backup API；全参数化查询 |
| `app/auth.js` | 注册/审批/登录（限流+锁定+验证码）/会话/改密/首启建管 |
| `app/users.js` | 总管理专属：审批/批量注册/重置密码/停用归档/角色 |
| `app/records.js` | 传出记录 + 统计聚合 |
| `app/bridge.js` | 发送页桥接（目的地选择、文件/文本、开始/完成、自动记录） |
| `receiver/build_receiver.js` | 生成接收端 真实版/发布版 |
| `scripts/cli.js` | 离线维护（建号/重置/备份/导出/统计） |
| `deploy/*.sh` | 一键部署与维护（systemd/nohup、备份、更新、启停） |

### 依赖清单（全部成熟开源组件，npm 安装，部署包全量内置）
express 5 · better-sqlite3 v13(N-API 预编译) · express-session + SQLite 会话存储（自制 ~60 行哈希键 Store）· bcryptjs · helmet · express-rate-limit · @depup/svg-captcha · joi · morgan + rotating-file-stream · csrf(pillarjs)

## 二、开发环境

```bash
# 在项目根目录（本文件夹）：
./runtime/bin/node scripts/prep.js          # 从 ../RaptorQR_彩色版.html 复制发送页副本
./runtime/bin/node receiver/build_receiver.js  # 生成接收端 real/release
./runtime/bin/node --test test/             # 全量测试（服务端 + 接收端）
./runtime/bin/node app/server.js            # 本地启动（读 config.json）
```

> 运行环境为 **Node 24 LTS**（`runtime/` 内捆绑，开发与部署共用保证原生模块 ABI 一致）。依赖安装后 node_modules 须随部署包分发。

## 三、部署（服务器离线可用）

### 1. 在联网构建机打部署包
```bash
./scripts/build_package.sh          # 产物 dist/RaptorQR_Server_v1.0.0.tar.gz
# 内含 node_modules 全量 + runtime/（Node 24）+ deploy 脚本 + README
```

### 2. 拷贝到服务器并解压
```bash
tar -xzf RaptorQR_Server_v1.0.0.tar.gz -C /opt/raptorqr
cd /opt/raptorqr
```

### 3. 一键部署（推荐 root，启用 systemd 安全加固）
```bash
sudo ./deploy/deploy.sh
# 完成后浏览器打开 http://<服务器IP>:1145 → 首次初始化创建『总管理』
```

无 systemd 的环境自动退回 nohup 托管（日志 `data/nohup.log`）。

### 4. 检查 config.json
部署时自动从 `config.example.json` 生成，重点项：
- `admin.bootstrap`：**部署时自动创建超级管理员**（首启无管理员时生效）
  - `enabled` 默认 `true`；`username`/`password` 留空则使用**默认凭据** `admin / Admin@1145`（`forcePasswordChange: true`，首次登录强制改密）
  - 也可用环境变量注入：`RQR_ADMIN_USERNAME` / `RQR_ADMIN_PASSWORD` / `RQR_ADMIN_DISPLAY`
  - 将 `enabled` 设为 `false` 则退回 `/setup` 初始化向导（手动建管）
- `batchRegister.initialPassword`：批量注册统一初始密码（务必修改，首次登录强制改密）
- `session` / `lockout` / `captcha`：会话与防爆破策略
- `destinations`：目的地清单（默认 jzw/bgw/my/sjw）

## 四、日常维护

| 操作 | 命令 |
|---|---|
| 状态/启停 | `./deploy/status.sh` `./deploy/start.sh` `./deploy/stop.sh` `./deploy/restart.sh` |
| 备份（保留最近 7 份） | `./deploy/backup.sh` |
| 更新（保留数据，支持回滚） | `./deploy/update.sh /path/to/新包.tar.gz` |
| 离线建号 | `./runtime/bin/node scripts/cli.js create-admin <用户名> [显示名]` |
| 离线重置密码 | `./runtime/bin/node scripts/cli.js reset-password <用户名>` |
| 导出记录 | `./runtime/bin/node scripts/cli.js export-records --format csv --out records.csv` |

日志按天轮转于 `data/logs/`（访问/错误分离，权限 600）。建议配置系统定时任务每日备份：
```bash
# crontab -e（root）
30 2 * * * /opt/raptorqr/deploy/backup.sh >> /opt/raptorqr/data/backup.log 2>&1
```

## 五、安全设计（纵深防御）

**威胁模型**：外部可触达 1145 端口、内网恶意人员、被控客户端。

### 账户安全
- 密码 bcrypt(12) 单向哈希，任何人（含总管理）看不到明文、只能重置；重置后强制改密
- 登录按 **IP+用户名** 双维度限流：5 次失败/15 分钟锁定 15 分钟；失败 2 次后强制验证码
- 验证码：SVG 数学题，答案只存 `sha256(答案+salt)`，5 分钟过期、一次性
- 会话：256-bit 随机 token，**库中只存 sha256**；HttpOnly + SameSite=Strict；绝对/空闲双过期；登录轮换会话；登出/改密/停用即时失效
- 注册：用户名白名单 + 保留名拦截 + 限流；未审批不能登录；自助注册+总管理审批

### 应用层
- helmet 安全头 + 分级 CSP（管理页严格；/app 放行 data:/blob: 因 worker/wasm 需要）
- CSRF 双提交令牌 + Origin 校验（写接口强制）；SameSite=Strict 主防御
- 全参数化查询防 SQL 注入；joi 全端点校验；请求体大小上限（防内存耗尽）
- 静态服务固定目录 + dotfiles ignore，路径穿越不可达
- **零上传/零执行面**：记录仅元数据，不做文件上传/存储/执行；无出站网络；无子进程

### 数据库与服务器
- 专用非 root 服务账号 + systemd 加固（NoNewPrivileges、ProtectSystem=strict、ReadWritePaths 仅 data/）
- data/ 目录权限 700、日志 600；数据库不在 Web 根目录
- 版本化迁移；WAL + 定期 checkpoint；在线备份 + 保留 7 份
- 统一错误中间件：生产不泄漏堆栈；审计日志记录管理操作与登录成败（谁/何时/做了什么）
- 防火墙仅放行办公网段 1145（README 运维提醒）

### 接收端防逆向（尽力而为）
接收端发布版对 CimQR 编解码核心做 **base64+XOR 字节编码 + 运行时解码**，显著提高逆向成本；但浏览器内运行的程序无法做到绝对防逆向，属尽力而为（真实版为完整可读代码）。

## 六、API 速览

| 方法 | 路径 | 权限 |
|---|---|---|
| POST | /api/setup | 首启（无管理员时） |
| POST | /api/auth/register · login · logout · change-password · change-password-forced | 公开/登录 |
| GET | /api/auth/session · /api/captcha · /api/health | 公开 |
| GET/POST | /api/records · /api/records/:id · /api/records/:id/status | 登录（本人/总管理） |
| GET | /api/stats/overview · destinations · users · daily | 登录（本人/总管理） |
| GET/POST | /api/users · batch · :id/approve · :id/reset-password · :id/status · :id/role | 总管理 |
| GET | /api/audit · /api/system/info | 总管理 |

## 七、HTTPS 升级指引（可选）
内网默认 HTTP。如需更高级别，二选一：
1. **反代**：nginx 监听 443（TLS 证书）+ 反代到 127.0.0.1:1145，并在 `config.security.trustProxy: true`；
2. **直连**：生成证书后配置 `config.https = { enabled: true, keyFile, certFile }` 并重启。

## 八、已知边界
- 发布版混淆为尽力而为，不能抵御专业逆向
- 目标服务器须为 Linux x86 glibc 主流发行版（Ubuntu/CentOS 等）；若为 musl（Alpine）等异架构，需在构建机上重新 `npm ci` 编译原生依赖
- 单进程运行；办公规模（数百账号/万级记录）足够，不做集群
