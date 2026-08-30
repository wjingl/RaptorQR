# RaptorQR 彩色版（GitHub Pages 托管）

摄像头二维码文件传输，单文件离线应用。在既有 RaptorQR（黑白 QR + RaptorQ 喷泉码）基础上完成彩色化改进：

- **Color CimQR 模式**：混合彩色编码（借鉴 libcimbar），QR 三寻像 + 时序 + 右下对齐标记做固定识别，112×112 彩色网格，每格 6bit（16 子图案 × 4 色）
- **7229 B/帧**（约为黑白 V10-L 的 34 倍），RS(155,125,30) + RaptorQ 双层纠错
- 容错：旋转/缩放/透视/亮度/轻度模糊实测可解；解码 40ms/帧
- 单文件、零依赖、可离线下载使用

## 使用

1. 打开 [应用页](RaptorQR_%E5%BD%A9%E8%89%B2%E7%89%88.html)（HTTPS 静态托管，手机相机可用）
2. 发送端：Advanced settings → QR encoder → **Color CimQR** → 输入文本/选文件 → Start Live QR
3. 接收端：Start Scan 对准屏幕，自动识别（黑白 QR 模式同样兼容）

详细设计见 `README_彩色化.md`（本地项目）。
