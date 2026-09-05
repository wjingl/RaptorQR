Transfer Hub 便携版 · 使用说明
================================

一、这是什么
  一个整合 RaptorQR（标准二维码）与 Cimbar（彩色条码）的本地传输应用。
  发送/接收全程在本机完成，不联网、不上传文件。

二、为什么不能直接双击 index.html
  浏览器安全限制禁止 file:// 页面加载 WebAssembly / Web Worker / fetch。
  这是所有现代浏览器（Chrome/Edge/Firefox）的统一规则，不是软件缺陷。
  因此请使用下面的启动器 —— 它会在本机临时启动网页服务并自动打开浏览器，
  用完关闭窗口即自动清理，无需任何安装。

三、启动方法（端口由操作系统自动分配的空闲本地端口，不使用 8080）

  Windows（无需安装任何东西，系统自带 PowerShell）：
      双击  open-transfer-hub.bat

  macOS / Linux（需系统装有 Python 3，多数系统默认自带）：
      双击或终端运行  open-transfer-hub.sh
      也可在终端执行  bash open-transfer-hub.sh
      或直接运行      python3 server.py

  启动后浏览器自动打开 http://127.0.0.1:<端口>/

四、使用提示
  - 发送与接收端协议必须一致：RaptorQR 对 RaptorQR，Cimbar 对 Cimbar。
  - 摄像头接收要求 HTTPS 或 localhost；同一电脑用上述地址即可。
    若需在局域网内用手机摄像头接收，请使用在线 HTTPS 版：
    https://wjingl.github.io/transfer-hub/
  - 画面含动态闪烁，光敏敏感者请降低速度或暂停。
