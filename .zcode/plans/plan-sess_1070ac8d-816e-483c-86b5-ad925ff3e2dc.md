## 目标

按你的四项要求改造 send_manager：① Stop 即"完成"、去掉单独完成按钮；② 界面按角色区分，总管理可查每个成员的全部记录；③ 传输内容在服务器备份（保留 7 天）；④ 总管理"账号管理"= 管理所有账号，据此重做仪表盘；⑤ 修复 /app 发送页"回不来"的问题。

## 一、状态语义：Stop → 完成，去掉"标记完成"按钮

**app/bridge.js（发送页桥接）**
- 删除工具栏"✔ 标记完成"按钮及其事件。
- 状态轮询（1500ms）：检测到应用状态为 `Stopped.` 且存在进行中记录 → `POST /records/:id/status {status:'completed'}`（不再是 stopped）。
- 新增"应用报错"检测：扫描 `#root` 内以 `⚠` 开头的短文本，若进行中记录存在 → 标 `failed`。
- 新发送开始时自动关闭上一笔 → 也标 `completed`（note"上一笔自动完成"），新流程不再产生 `stopped` 状态（枚举保留兼容旧数据）。

**app/static/js/records.js（记录页）**
- 对 `sending` 状态的记录，操作列从"标记完成 / 停止"改为单个"停止"（确认提示后 `POST completed`），删除"标记完成"。

## 二、服务端文件备份（保留 7 天）

**app/config.js + config.json / config.example.json**
- 新增 `backup: { enabled: true, retentionDays: 7, maxFileBytes: 8388608 }`。
- 新增 `limits.uploadBody: 16777216`（仅 /api/records 使用，16MB 容纳 8MB 文件的 base64；其余接口保持 100KB 上限不变）。

**app/db.js**
- 迁移 v2：`ALTER TABLE records ADD COLUMN backup_path TEXT NOT NULL DEFAULT ''`、`backup_size INTEGER NOT NULL DEFAULT 0`。
- `insertRecord` 写入 backup_path/backup_size；新增 `setRecordBackup(id, path, size)`、`clearRecordBackup(id)`。

**新增 app/backup.js（存储/下载/清理）**
- `storeBackup({dataDir, recordId, filename, buffer})`：写入 `dataDir/backups/records/<recordId>/<安全文件名>`（文件名做路径穿越/控制字符清洗），返回相对路径。
- `resolveBackup({dataDir, record})`：返回绝对路径与原始文件名，供下载；无备份返回 null。
- `cleanupBackups({dataDir, retentionDays})`：删除 mtime 超过 retentionDays 的备份文件与空目录，返回被清理的 recordId 列表。

**app/records.js（后端）**
- `createSchema` 增加可选 `content`（base64 字符串）。校验解码后 ≤ maxFileBytes，写入备份目录，设置 backup_path/backup_size（无 content 则留空，兼容旧客户端/测试）。
- 新增 `GET /api/records/:id/backup`：总管理或记录本人可下载（403 越权、404 无备份/已过期），流式返回 + `Content-Disposition` 附件名。
- `list` 返回中已含 backup_path（SELECT *），前端据此显示"可下载"。

**app/server.js**
- `/api/records` 的 JSON body 上限改用 `limits.uploadBody`。
- 新增备份下载路由（requireAuth + 归属校验）。
- 在现有 10 分钟定时任务中追加 `cleanupBackups`（按 retentionDays 清理并回写 DB）。

**app/bridge.js**
- 创建记录 payload 增加 `content`：文件模式 = base64(文件字节)；文本模式 = base64(UTF-8 文本)。8MB 上限不变。

## 三、角色区分 + 总管理查看每成员记录

**app/static/js/records.js + records.html**
- 总管理视图新增"用户"筛选下拉（数据源 /api/users），选择后带 `?userId=N` 请求（后端已支持）。
- 备份列：有 backup_path 且有权时显示"下载"（总管理全部可见；普通用户仅自己的记录页出现）。

**app/static/js/common.js（全站导航）**
- 总管理导航：`首页 / 发送 / 我的记录 / 统计 / 账号管理(/users) / 审计日志`（不再出现普通"账号"项）。
- 顶栏用户区：`总管理 · admin [改密→/account] [退出]`；普通用户保持 `首页 / 发送 / 我的记录 / 账号(/account)`。

## 四、仪表盘改版（总管理 = 管理所有账号）

**app/static/pages/dashboard.html + dashboard.js**
- 总管理视图新增两块：
  1. **待审批账号**卡片：拉取 `/api/users?status=pending`，每条带"通过/驳回"快捷按钮（无 pending 时隐藏卡片）。
  2. **成员传输记录浏览**卡片：`/api/stats/users` 表格（用户/次数/大小/已完成），用户名可点击 → `/records?userId=N` 查看该成员全部记录（替换原 Top10 纯数字展示）。
- 保留：统计卡、按目的地、最近记录（含用户列）、管理入口。
- 普通用户视图不变（自己的概览 + 自己的记录）。

## 五、/app 发送页"回不来"修复

**app/bridge.js 工具栏**：注入后先取会话（已有 refreshCsrf → /api/auth/session 返回 user.role），在工具栏渲染角色感知导航：`首页 / 我的记录`（总管理追加 `统计 / 账号管理 / 审计日志`）+ `退出登录`（POST logout 后回 /login），替换现有的"我的记录"单链接。

## 六、测试与验证

**test/server.test.js（新增用例，复用现有 helper）**
- 创建记录带 content → 备份文件落盘、backup_path 正确；无 content → 兼容（不落盘）。
- 备份下载：本人/总管理 200，他人 403，无备份 404。
- 超限 content → 400/413；非法 base64 → 400。
- 清理：制造 8 天前 mtime 的备份 → cleanupBackups 删除文件并清空 backup_path。
- 现有 34 项用例保持通过（content 为可选字段，旧测试不受影响）。

**验证步骤**
1. `./runtime/bin/node --test "test/*.test.js"` 全绿。
2. 隔离实例 + 真实 Edge CDP 回归：管理员/普通用户登录跳转；记录页用户筛选与"停止→完成"；桥接点 Stop 后记录变为 completed；带文件与文本各建一条记录，确认 `data/backups/records/` 落盘且 7 天窗口内可下载；普通用户在 /app 有导航可返回 /dashboard；总管理仪表盘显示待审批与成员记录。

## 七、兼容与安全
- 存量记录（无 backup_path）下载入口不显示，不影响。
- 备份文件名做路径清洗，防路径穿越；下载走归属校验；上传走 uploadBody 限流 + 速率限制 + 8MB 上限。
- 发送页单文件源码不动（桥接仍为服务时注入），接收端构建不受影响。

## 涉及文件
app/server.js、app/db.js、app/records.js、app/config.js、app/bridge.js、app/static/js/common.js、app/static/js/records.js、app/static/pages/records.html、app/static/js/dashboard.js、app/static/pages/dashboard.html、config.json、config.example.json、test/server.test.js（新增 app/backup.js）。