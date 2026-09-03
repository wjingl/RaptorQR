# RaptorQR 接收端整体架构设计

## 目标

接收端要解决的不是“再放宽一个色相阈值”，而是把真实相机输入拆成五个独立阶段：

```text
相机采集 → 帧标准化 → 结构/几何锁定 → 格式专属单码解析 → 包/FEC 传输
```

彩色 CimQR 和普通 QR 共用前两阶段、状态机、质量遥测和 tracking；两种格式从结构解析开始分叉，不能把彩色单应直接套给普通 QR，也不能让 FEC 掩盖单码视觉失败。

不修改线上协议：CimQR 的 6 bit/格、帧头、RS、RaptorQ 包头、CRC 和发送端 `parallelCount=1` 保持不变。

---

## 一、五层职责边界

### 1. 采集层：只负责取得不同的相机帧

输入：`video`。

输出：

```js
{
  frameId,
  timestamp,
  rgba,
  width,
  height,
  streamReady,
  receivedFrames,
  droppedFrames,
  duplicateFrame
}
```

采集层只做：

- `video → canvas → ImageData`；
- 尺寸规整和帧节流；
- 保留最新帧；
- 廉价帧哈希去重；
- 报告无视频、无帧、帧丢弃。

采集层禁止做：

- 判断彩色/黑白；
- 调用 `maybeColor` 决定旁路；
- 解析帧头、RS 或 RaptorQ；
- 把“没有解析结果”误报成“没有采样到帧”。

### 2. 标准化层：一次生成可复用的 `NormalizedFrame`

同一输入帧只生成一次：

```js
{
  rawRGBA,
  width,
  height,
  rawLuma,              // 原始结构亮度，首层低开销定位
  enhancedLuma,         // 局部对比度 + 受限 unsharp
  localIllumination,    // 低频照明场
  correctedRGB,         // 全局/局部白点校正后的颜色视图
  chroma,
  highlightMask,
  qualityMap,
  wbGain,
  hueOffsets,
  glareRate
}
```

处理规则：

1. Finder、Timing、TL size mark、BR marker 首层使用 `rawLuma`；
2. 首层无可靠三角、Timing 低分或 tracking 失锁时才使用 `enhancedLuma`；
3. 彩色数据格使用 `correctedRGB + chroma + raw/enhanced local contrast`；
4. 普通 QR 使用 `rawLuma`，失败后尝试 `enhancedLuma`，但保留标准 QR 自己的 Finder/H；
5. 高光不直接当作黑或白，而是质量降权或 unknown；
6. 原始 RGBA 永不被校正结果覆盖。

局部白平衡必须使用空间连续的双线性增益，不能让 16×16 网格形成明显的块状色偏。中性参考不足时回退全局增益。

屏幕白底本身不能被整个标记为 glare。高光检测应满足“接近饱和、低色度、相对局部背景突然变亮”，并只在采样时降低权重。

### 3. 结构/几何层：输出 `GeometryLock`

```js
{
  formatHint,             // unknown | color-cimqr | qr-standard
  anchors,                // finder、TL size mark、BR marker、timing
  homography,
  homographyMode,         // four-point | three-finder-fallback
  reprojectionResidual,
  timingScore,
  moduleScale,
  finderAngle,
  inBoundsRate,
  confidence,
  source                  // raw | enhanced | tracking | full
}
```

#### CimQR 结构锁定

- 三 Finder 只负责初始三角、方向和模块尺度；
- TL size mark 负责尺寸档位确认；
- BR 5×5 回字型是第四个真实测量点；
- Timing 线参与候选排序、H 质量评分和 tracking 门控；
- 满分 BR 不等于几何正确，必须同时检查 marker 位置、局部方向、Timing 和数据区越界率；
- marker 未命中时可以用三 Finder 平行四边形作为临时初值，但必须遥测为 `three-finder-fallback`，不能把它当作完成透视校正。

#### 透视与镜头模型

实际手机拍屏的平面透视通常由四点单应足够处理。对轻微非对称、单边近远和旋转，使用四锚点 DLT；不再用固定的 1.5% 近似作为能力证明。

如果多条 Timing 线在四点 H 下出现系统性弯曲，而不是随机采样误差，再启用二级镜头校正：

```text
四点 H → 局部 Timing 残差 → 估计轻量径向项/网格校正 → 数据采样
```

这一区分了“平面透视”与“镜头径向畸变”，不能用继续放大 BR 搜索窗口代替。

#### Finder 策略

- 水平扫描是正常帧首层；
- 只有无可靠三角、Timing 低分或 tracking 失锁时，才在降采样图上做多方向 profile；
- 方向候选只提供轴和初值；
- 当前不把有问题的 `refineFinderOriented` 作为默认中心精化；
- 全分辨率中心仍以多行/多列结构投票为主，方向精化必须经过独立质量门控。

### 4. 格式专属解析层

## CimQR 单码解析

每个数据格生成 `CellEvidence`：

```js
{
  patternTop1,
  patternTop2,
  patternMargin,
  colorTop1,
  colorTop2,
  colorMargin,
  shapeConfidence,
  colorConfidence,
  highlightFraction,
  unknown
}
```

#### 图案位

图案位只能来自亮度/局部对比度/边缘结构：

- 在格内采集 3×3 或 5×5 点；
- 用格内相对亮度和局部背景归一消除暗角、加性偏色；
- 用 16 个 8×8 canonical 图案计算 top-1/top-2；
- 轻微模糊使用受限面积采样，不用色相代替图案。

#### 颜色位

颜色位只能来自颜色视图：

- 对局部白点校正后的 RGB 计算 chroma、色相和到四个标准色的 RGB 距离；
- 四种颜色分别估计偏移，不使用单一全局 hue offset；
- 颜色投票优先使用图案已判为亮点的位置；
- 背景位置只作为低权重反光/错位辅助；
- 局部高光、低色度、色相落在两个中心之间时保留 unknown。

最终不是“颜色决定图案”，而是：

```text
pattern evidence + color evidence + geometry quality - glare penalty
```

对每格保留 top-2 和 margin。margin 不足时不伪造可信值。

当前 RS 输入接口没有真正的擦除语义，因此不能把 unknown 当成普通 0 继续硬解。视觉层应先把低置信度格判为本帧不可接受并等待后续帧；以后若要增加 RS 擦除，必须单独设计并验证，不能偷偷改变现有协议。

## 普通 QR 单码解析

普通 QR 复用：

- `FrameEnvelope`；
- `NormalizedFrame`；
- raw/enhanced luma 顺序；
- 高光、曝光、帧状态和失败阶段遥测。

普通 QR 保留自己的：

- Finder/quiet-zone 检测；
- 标准 QR 四边形/透视校正；
- ZXing 输入图像和二值化策略。

不得直接复用 CimQR 的 BR marker/H，也不得让彩色预检阻止标准 QR 尝试。

## 普通 QR 与彩色共用边界

普通 QR 仍由标准 QR 解码器负责 Finder、quiet-zone、四边形/透视归一、二值化、版本、mask 和标准 ECC；不得复用 CimQR 的 BR 标记、TL 尺寸标记、6 bit/格或 8×8 图样采样。两者只共享相机帧标准化、原始/增强灰度视图、帧节流/保最新、状态遥测、队列和资源生命周期。

当前 decode worker 的普通 QR 顺序是：

```text
maybeColor 仅作顺序提示
  ├─ 明显黑白帧：ZXing raw 灰度优先
  └─ 其他帧：CimQR 彩色单码优先
        ↓ 无有效彩色 packet
      ZXing raw 灰度
        ↓ 无结果
      ZXing enhanced 灰度
```

标准 QR 成功通过 `codeType=qr-standard` 报告，`source=raw|enhanced`；彩色预检为 false 不能阻止标准 QR，也不代表采集失败。增强图只在 raw 无结果时生成，不改变原始 RGBA，也不把彩色 BR/H 套到普通 QR。

## RS/FEC 决策

RS(155,125,30) 是 CimQR 单帧字节纠错层，最多纠正 15 个未知字节错误；packet CRC32C 和 RaptorQ/RLNC 仍分别负责包完整性与跨帧恢复。独立基线已验证 clean、1/4/8/12/15 个错误纠正以及 16 个错误拒绝，RS 不是主要性能瓶颈，因此生产继续使用稳定的 errors-only `rsDecode`。

低置信度 cell 暂时不能直接接入 RS 擦除：当前 6 bit/格会跨字节，未知位到字节擦除的映射需要额外验证；实验性 errors+erasures 实现未达到纯擦除和混合错误正确性要求，已撤回，不进入生产 API。视觉层遇到 unknown 应等待后续帧，而不是把它伪装成可信 0。



- 包级 CRC32C；
- 包去重；
- RaptorQ/RLNC 跨帧累积；
- 完成状态。

传输层不负责判断单码是否正确。只有单码解析阶段输出了通过格式、帧头和视觉质量门控的 packet，才允许进入 FEC。

---

## 二、统一状态机和遥测

前端必须区分：

```text
capture-no-frame
capture-ready
structure-search
no-anchor
geometry-locked
single-code-sampling
single-code-ambiguous
packet-invalid
fec-collecting
complete
```

关键原则：

- `maybeColor=false` 只表示预检没有足够颜色样本，不表示没有彩色帧；
- `finderCount>0`、`selectedAnchors=3` 但 RS 失败，应显示“已采样但单码解析失败”；
- `complete` 只能在当前 packet 通过帧头/CRC 后进入 FEC，不得掩盖此前视觉阶段；
- 显示码型、网格、实际单码像素尺寸、信息密度、每帧码数/并发、Finder/BR/Timing 状态和当前阶段；
- 详细字段限频发送，不在每个采样点发消息。

---

## 三、Tracking 设计

缓存对象：

```js
{
  homography,
  anchors,
  moduleScale,
  timingScore,
  reprojectionResidual,
  confidence,
  sizeIndex,
  lastFrameId
}
```

下一帧流程：

1. 用旧 H 预测四锚点；
2. 在 Finder/BR/Timing 邻域沿局部轴重新测量；
3. 通过加权四点更新 H；
4. 检查残差、Timing、BR 和 H 变化幅度；
5. 质量通过才走快速单码采样；
6. 一次失败后立即降低 tracking 置信度，连续失败或几何变化超限时回到全局检测。

不能只缓存一个旧 H 后直接采样，也不能等 FEC 失败才发现 tracking 已失锁。

---

## 四、代码重构顺序

1. 保留当前线上协议和现有发送端逻辑；
2. 在 `cimqr_codec.js` 内先完成 `NormalizedFrame` 和统一状态字段；
3. 抽出一个共享的 `sampleColorCell()` / `samplePatternEvidence()`，消除 `decodeAttempt` 与 `decodeFromH` 两份漂移逻辑；
4. 让 soft/hard 都调用同一份图案/颜色证据函数，只改变采样密度和阈值策略；
5. 将 Finder、TL、BR、Timing 的几何质量统一成 `GeometryLock`；
6. 加入 tracking 局部重定位和失锁回退；
7. 在 decode worker 中把 CimQR 与普通 QR 放在同一标准化帧下，但保持两个解析器；
8. 扩展前端 side-channel 遥测；
9. 源码稳定后才执行 `build_color.js`、sender/receiver 构建和产物 parity；
10. 测试只保留分层门禁，不再靠大量随机场景驱动设计：
   - 干净彩色/普通 QR 回路；
   - 代表性旋转、单边/非对称轻透视；
   - 非均匀照明、暗角、轻微屏幕反光；
   - release/real UI；
   - 真机帧 fixture（没有 fixture 时明确标记未完成真机验收）；
   - 重模糊/强噪声/大遮挡只做边界安全检查。

---

## 当前结论

当前实现的验收重点是室内固定相机的正常工作区，而不是极端退化：

- 采集层只负责取得和转发不同帧；
- 标准化层提供原始/增强灰度、局部白平衡、色相校准和反光质量信息；
- 结构层使用三个 Finder、TL 尺寸标记、BR 第四锚点和 Timing 完成定位与标定；
- CimQR 单码层同时使用 8×8 图案亮度证据和四颜色色相证据；
- 普通 QR 保留自己的标准 Finder/透视解析，但共享采集、增强和诊断；
- packet/CRC/FEC 只接收已通过单码格式校验的结果。

主工作区是固定相机、二维码占画面约 50% 以上、偏移构图、轻微旋转/平面透视、室内曝光变化和小面积反光。重模糊、强噪声、大面积遮挡和极端透视只做禁止误接受的边界检查，不再作为正常能力目标。

因此验收应关注：能否从正常相机帧稳定识别正确内容、是否正确显示码型/网格/尺寸/信息密度、是否能区分采集失败与单码解析失败，以及图案与颜色是否共同参与判定；不应再用大量随机极端测试替代真实工作区验证。
