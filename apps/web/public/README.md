# Transfer Hub Web App

## 本地打开

不要直接双击 `index.html`。浏览器的 `file://` 安全策略会阻止 ES Module、Worker、WASM、`fetch()` 和 Service Worker 正常工作。

启动器会在本机临时启动网页服务并自动打开浏览器，端口由操作系统自动分配（不使用 8080），关闭窗口即停止。

Windows（无需安装任何东西，使用系统自带 PowerShell）：

```text
双击 open-transfer-hub.bat
```

macOS / Linux（需 Python 3，多数系统默认自带）：

```text
bash open-transfer-hub.sh
# 或
python3 server.py
```

手动运行（备选）：

```bash
python3 server.py
```

