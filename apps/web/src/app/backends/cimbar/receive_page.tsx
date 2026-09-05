import { useEffect, useRef, useState } from 'preact/hooks';
import { CimbarSink, type CimbarModeValue } from './cimbar_glue';
import { CIMBAR_FILES, cimbarFileUrl, checkCimbarRuntime } from './runtime';

type CSSProps = Record<string, string | number>;

const S = {
  section: { background: '#161b22', border: '1px solid #30363d', borderRadius: 12, padding: 18, marginBottom: 16 } as CSSProps,
  label: { display: 'block', color: '#8b949e', fontSize: 12, fontWeight: 700, letterSpacing: 0.7, textTransform: 'uppercase', marginBottom: 8 } as CSSProps,
  row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } as CSSProps,
  button: { background: '#238636', color: '#fff', border: 0, borderRadius: 7, padding: '10px 16px', fontWeight: 700, cursor: 'pointer' } as CSSProps,
  secondary: { background: '#21262d', color: '#f0f6fc', border: '1px solid #30363d', borderRadius: 7, padding: '10px 14px', cursor: 'pointer' } as CSSProps,
  select: { width: '100%', background: '#0d1117', color: '#c9d1d9', border: '1px solid #30363d', borderRadius: 7, padding: '9px 10px', fontSize: 14 } as CSSProps,
  video: { width: '100%', maxWidth: 720, display: 'block', margin: '14px auto 0', borderRadius: 8, background: '#000' } as CSSProps,
  status: { color: '#8b949e', fontSize: 13, marginTop: 10 } as CSSProps,
  warning: { color: '#d29922', background: '#2d1b00', border: '1px solid #9e6a03', padding: '10px 12px', borderRadius: 8, fontSize: 12, lineHeight: 1.5 } as CSSProps,
  result: { background: '#0d1117', border: '1px solid #30363d', borderRadius: 8, padding: 14, marginTop: 12 } as CSSProps,
  progressTrack: {
    height: 8,
    background: '#21262d',
    borderRadius: 999,
    overflow: 'hidden',
    marginTop: 8,
    position: 'relative',
  } as CSSProps,
  progressFill: (widthPercent: number): CSSProps => ({
    width: `${Math.max(0, Math.min(100, widthPercent))}%`,
    height: '100%',
    background: '#58a6ff',
    transition: 'width 160ms ease',
  }),
  percentText: {
    color: '#58a6ff',
    fontWeight: 700,
    fontFamily: 'monospace',
    fontSize: 13,
  } as CSSProps,
  progressHint: { color: '#8b949e', fontSize: 12, marginTop: 6, lineHeight: 1.5 } as CSSProps,
  indeterminateThumb: {
    position: 'absolute' as const,
    top: 0,
    bottom: 0,
    width: '35%',
    left: '-35%',
    background: '#58a6ff',
    borderRadius: 999,
    animation: 'transferhub-scan 1.15s ease-in-out infinite',
  },
  statsBar: {
    display: 'flex',
    gap: 16,
    alignItems: 'center',
    fontSize: 12,
    color: '#8b949e',
    marginTop: 6,
    flexWrap: 'wrap',
  } as CSSProps,
  statValue: {
    color: '#c9d1d9',
    fontWeight: 600,
    fontFamily: 'monospace',
    fontSize: 13,
  } as CSSProps,
} as const;

const WORKER_COUNT = 4; // official Recv.init_ww(4)
const MAX_FRAMES_IN_FLIGHT = 20; // official stalling threshold
const WORKER_READY_TIMEOUT_MS = 20000;
const MODE_CANDIDATES = [66, 68, 67, 4]; // official auto-detect rotation (Bu, B, Bm, 4C)

const MODE_OPTIONS: Array<{ value: CimbarModeValue; label: string }> = [
  { value: 0, label: '自动检测' },
  { value: 68, label: 'B · 兼容' },
  { value: 66, label: 'Bu · 高密度' },
  { value: 67, label: 'Bm · 平衡' },
  { value: 4, label: '4C · 彩色' },
];

interface RecoveredResult {
  filename: string;
  data: ArrayBuffer;
}

export function CimbarReceivePage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sinkRef = useRef<CimbarSink | null>(null);
  const workersRef = useRef<Worker[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const pumpHandleRef = useRef<number>(0);
  const pumpViaVideoFrameRef = useRef(false);
  const inFlightRef = useRef(0);
  const nextWorkerRef = useRef(0);
  const frameSeqRef = useRef(0);
  const stoppedRef = useRef(true);
  const runningRef = useRef(false);
  const selectedModeRef = useRef<number>(0); // 0 = auto
  const lockedModeRef = useRef(0); // confirmed mode in auto mode (official lock)
  const counterRef = useRef(0); // camera-frame counter (official _counter)
  const recentExtractRef = useRef(-999); // official _recentExtract (30-frame windows)
  const recentDecodeRef = useRef(-999); // official _recentDecode
  const [extractOk, setExtractOk] = useState(0); // 提取成功但无新数据（nodata）计数
  const [extractFail, setExtractFail] = useState(0); // 提取失败（failed_extract）计数
  const [lockedMode, setLockedMode] = useState(0);
  const [xhairState, setXhairState] = useState<'idle' | 'scanning' | 'active'>('idle');
  const packetCountRef = useRef(0);
  const startedAtRef = useRef(0);

  const [running, setRunning] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [status, setStatus] = useState('允许摄像头后，对准 Cimbar 发送画面。');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<number[]>([]);
  const [selectedMode, setSelectedMode] = useState<CimbarModeValue>(0);
  const [framesScanned, setFramesScanned] = useState(0);
  const [decodedPackets, setDecodedPackets] = useState(0);
  const [packetsPerSec, setPacketsPerSec] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [result, setResult] = useState<RecoveredResult | null>(null);

  useEffect(() => () => stop(), []);

  // Per-second stats refresh while a session is active.
  useEffect(() => {
    if (!runningRef.current) return;
    let previous = performance.now();
    let previousCount = packetCountRef.current;
    const timer = window.setInterval(() => {
      const now = performance.now();
      const currentCount = packetCountRef.current;
      const dt = (now - previous) / 1000;
      if (dt > 0) setPacketsPerSec(Math.round((currentCount - previousCount) / dt));
      previous = now;
      previousCount = currentCount;
      setElapsedSec(Math.round((now - startedAtRef.current) / 1000));
    }, 500);
    return () => window.clearInterval(timer);
  }, [running]);

  // 角框状态：绿色=最近有数据包解码；黄色=正在提取但暂无新数据；白色=未识别到码区
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      const c = counterRef.current;
      if (recentDecodeRef.current + 30 > c) setXhairState('active');
      else if (recentExtractRef.current + 30 > c) setXhairState('scanning');
      else setXhairState('idle');
    }, 250);
    return () => window.clearInterval(timer);
  }, [running]);

  const selectMode = (value: CimbarModeValue) => {
    setSelectedMode(value);
    selectedModeRef.current = value;
    lockedModeRef.current = 0;
    sinkRef.current?.configure(value);
  };

  const effectiveMode = (): number => lockedModeRef.current || selectedModeRef.current || 0;
  const modeLabel = (value: number): string =>
    MODE_OPTIONS.find((option) => option.value === value)?.label ?? 'B';

  const modeForFrame = (): number => {
    if (selectedModeRef.current !== 0) return selectedModeRef.current;
    if (lockedModeRef.current !== 0) return lockedModeRef.current;
    return MODE_CANDIDATES[frameSeqRef.current % MODE_CANDIDATES.length];
  };

  const clearPump = () => {
    if (pumpHandleRef.current) {
      if (pumpViaVideoFrameRef.current) {
        // rVFC handle is a number returned by requestVideoFrameCallback; there
        // is no cancel, the stopped flag stops rescheduling instead.
        pumpHandleRef.current = 0;
      } else {
        cancelAnimationFrame(pumpHandleRef.current);
        pumpHandleRef.current = 0;
      }
    }
  };

  const stopWorkers = () => {
    workersRef.current.forEach((worker) => worker.terminate());
    workersRef.current = [];
    inFlightRef.current = 0;
    nextWorkerRef.current = 0;
    frameSeqRef.current = 0;
  };

  const stop = () => {
    stoppedRef.current = true;
    runningRef.current = false;
    clearPump();
    stopWorkers();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
    sinkRef.current?.dispose();
    sinkRef.current = null;
    setRunning(false);
    setInitializing(false);
  };

  // --- capture pump: official on_frame() semantics -----------------------
  // Camera-driven (requestVideoFrameCallback where available), no fixed
  // throttle: we only skip dispatching while more than MAX_FRAMES_IN_FLIGHT
  // frames are still being decoded by the worker pool.
  const startPump = (): void => {
    const video = videoRef.current;
    if (!video) return;
    const hasRequestVideoFrameCallback = typeof (video as HTMLVideoElement & { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback === 'function';
    const hasVideoFrame = typeof (globalThis as { VideoFrame?: unknown }).VideoFrame === 'function';
    pumpViaVideoFrameRef.current = hasRequestVideoFrameCallback && hasVideoFrame;
    let useVideoFramePath = pumpViaVideoFrameRef.current;
    let canvasSized = false;

    const captureWithVideoFrame = (now: number): { pixels: Uint8Array; format: string; width: number; height: number } | null => {
      const VideoFrameCtor = (globalThis as { VideoFrame: new (source: HTMLVideoElement, init?: { timestamp?: number }) => { format?: string; displayWidth: number; displayHeight: number; allocationSize(params?: { format?: string }): number; copyTo(dest: Uint8Array, params?: { format?: string }): void; close(): void } }).VideoFrame;
      const videoElement = videoRef.current;
      if (!videoElement) return null;
      const vf = new VideoFrameCtor(videoElement, { timestamp: now });
      const width = vf.displayWidth;
      const height = vf.displayHeight;
      const params: { format?: string } = {};
      if (vf.format !== 'NV12' && vf.format !== 'I420') params.format = 'RGBA';
      const size = vf.allocationSize(params);
      const pixels = new Uint8Array(size);
      vf.copyTo(pixels, params);
      vf.close();
      let format = params.format || vf.format || 'RGBA';
      if (format === 'RGBA' && size !== width * height * 4) format = vf.format || 'RGBA';
      return { pixels, format, width, height };
    };

    const captureWithCanvas = (): { pixels: Uint8Array; format: string; width: number; height: number } | null => {
      const videoElement = videoRef.current;
      const canvas = canvasRef.current;
      if (!videoElement || !canvas || videoElement.readyState < 2 || videoElement.videoWidth === 0) return null;
      const width = videoElement.videoWidth;
      const height = videoElement.videoHeight;
      if (!canvasSized || canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        canvasSized = true;
      }
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return null;
      context.drawImage(videoElement, 0, 0, width, height);
      const image = context.getImageData(0, 0, width, height);
      return { pixels: new Uint8Array(image.data.buffer), format: 'RGBA', width, height };
    };

    const dispatchFrame = (now: number): void => {
      if (stoppedRef.current) return;
      frameSeqRef.current += 1;
      counterRef.current += 1;
      const workers = workersRef.current;
      if (workers.length === 0) return;
      if (inFlightRef.current >= MAX_FRAMES_IN_FLIGHT) return; // official "stalling"

      let frame: { pixels: Uint8Array; format: string; width: number; height: number } | null = null;
      if (useVideoFramePath) {
        try {
          frame = captureWithVideoFrame(now);
        } catch {
          useVideoFramePath = false;
        }
      }
      if (!frame) frame = captureWithCanvas();
      if (!frame) return;

      setFramesScanned((count) => count + 1);
      inFlightRef.current += 1;
      const workerIndex = nextWorkerRef.current;
      nextWorkerRef.current = (workerIndex + 1) % workers.length;
      const message = {
        type: 'proc',
        pixels: frame.pixels,
        format: frame.format,
        width: frame.width,
        height: frame.height,
        mode: modeForFrame(),
      };
      workers[workerIndex].postMessage(message, [frame.pixels.buffer]);
    };

    const tick = (now: number): void => {
      if (stoppedRef.current) return;
      const scheduleNext = (): void => {
        if (stoppedRef.current) return;
        if (pumpViaVideoFrameRef.current) {
          const videoElement = videoRef.current;
          if (!videoElement) return;
          const rvfc = videoElement as HTMLVideoElement & { requestVideoFrameCallback: (callback: (now: number, metadata: unknown) => void) => number };
          pumpHandleRef.current = rvfc.requestVideoFrameCallback((nextNow) => {
            try {
              dispatchFrame(nextNow);
            } catch (cause) {
              console.error('Cimbar frame dispatch failed', cause);
            }
            scheduleNext();
          });
        } else {
          pumpHandleRef.current = requestAnimationFrame((nextNow) => {
            try {
              dispatchFrame(nextNow);
            } catch (cause) {
              console.error('Cimbar frame dispatch failed', cause);
            }
            scheduleNext();
          });
        }
      };
      scheduleNext();
    };
    tick(performance.now());
  };

  const handleDecodedFrame = (mode: number, bytes: Uint8Array): void => {
    if (stoppedRef.current) return;
    const sink = sinkRef.current;
    if (!sink || bytes.length === 0) return;
    if (selectedModeRef.current === 0 && lockedModeRef.current === 0) {
      lockedModeRef.current = mode; // official setMode(): lock confirmed mode in auto
      setLockedMode(mode);
      sink.configure(mode);
    }
    packetCountRef.current += 1;
    setDecodedPackets(packetCountRef.current);
    let outcome;
    try {
      outcome = sink.feed(bytes, mode);
    } catch (cause) {
      setError(`解码失败：${cause instanceof Error ? cause.message : String(cause)}`);
      return;
    }
    if (outcome.progress) setProgress([...outcome.progress]);
    if (outcome.completed && outcome.id !== null) {
      let recovered: RecoveredResult;
      try {
        const file = sink.recover(outcome.id);
        recovered = { filename: file.filename, data: file.data };
      } catch (cause) {
        setError(`文件重组失败：${cause instanceof Error ? cause.message : String(cause)}`);
        return;
      }
      setResult(recovered);
      setStatus('接收完成 ✓');
      setProgress([]);
      stop();
    }
  };

  const start = async (): Promise<void> => {
    setError('');
    setResult(null);
    setProgress([]);
    setDecodedPackets(0);
    setFramesScanned(0);
    setPacketsPerSec(0);
    setExtractOk(0);
    setExtractFail(0);
    setLockedMode(0);
    setXhairState('idle');
    packetCountRef.current = 0;
    counterRef.current = 0;
    recentExtractRef.current = -999;
    recentDecodeRef.current = -999;
    stoppedRef.current = true;
    runningRef.current = false;

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('当前浏览器不支持摄像头。请使用 HTTPS/localhost，或改用 RaptorQR GIF 接收。');
      return;
    }
    const runtime = await checkCimbarRuntime();
    if (!runtime.available) {
      setError(`Cimbar 运行时缺少：${runtime.missing.join(', ')}`);
      return;
    }

    try {
      const sink = await CimbarSink.create();
      sinkRef.current = sink;

      // 对齐二维码接收的相机策略：方形 ideal 分辨率、不强制裁切/放大画面；
      // 保留连续对焦/曝光（ImageCapture 扩展约束，不影响取景，仅避免近距离拍屏失焦）
      const videoConstraints = {
        width: { ideal: 1280 },
        height: { ideal: 1280 },
        facingMode: 'environment',
        exposureMode: 'continuous',
        focusMode: 'continuous',
        frameRate: { ideal: 15 },
      } as unknown as MediaTrackConstraints;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error('摄像头预览初始化失败。');
      video.srcObject = stream;
      await video.play();

      setInitializing(true);
      setStatus('正在初始化 Cimbar 解码器…');

      const workers = Array.from({ length: WORKER_COUNT }, () => new Worker(cimbarFileUrl(CIMBAR_FILES.recvWorker)));
      workersRef.current = workers;
      let readyCount = 0;
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          reject(new Error('Cimbar 解码器初始化超时，请刷新页面后重试。'));
        }, WORKER_READY_TIMEOUT_MS);
        workers.forEach((worker, index) => {
          worker.onmessage = (event: MessageEvent) => {
            const message = event.data || {};
            if (message.type === 'startWasm') {
              if (message.ready === 'ready!' || message.ready === true) {
                readyCount += 1;
                if (readyCount === workers.length) {
                  window.clearTimeout(timeout);
                  resolve();
                }
              } else {
                window.clearTimeout(timeout);
                reject(new Error('Cimbar 解码 Worker 初始化失败。'));
              }
              return;
            }
            inFlightRef.current = Math.max(0, inFlightRef.current - 1);
            const bytes = message.buff;
            const mode = message.mode;
            if (message.nodata) {
              recentExtractRef.current = counterRef.current; // 提取成功但无新字节（官方 _recentExtract）
              setExtractOk((count) => count + 1);
            } else if (message.failed_extract) {
              setExtractFail((count) => count + 1); // 画面中未找到码区
            }
            if (bytes && mode && typeof mode === 'number') {
              recentExtractRef.current = counterRef.current;
              recentDecodeRef.current = counterRef.current; // 官方 _recentDecode（绿色角框）
              handleDecodedFrame(mode, new Uint8Array(bytes));
            }
          };
          worker.onerror = (event) => {
            window.clearTimeout(timeout);
            reject(new Error(event.message || 'Cimbar 解码 Worker 出错。'));
          };
        });
      });

      stoppedRef.current = false;
      runningRef.current = true;
      startedAtRef.current = performance.now();
      setRunning(true);
      setInitializing(false);
      setStatus(selectedModeRef.current === 0 ? '正在扫描：自动识别模式中，请保持画面稳定' : `正在扫描：${modeLabel(selectedModeRef.current)} 模式`);
      startPump();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`启动失败：${message}`);
      stop();
    }
  };

  const download = () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([result.data], { type: 'application/octet-stream' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = result.filename || 'cimbar-recovered.bin';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const stateColor = xhairState === 'active' ? '#00FF00' : xhairState === 'scanning' ? '#FFFF00' : '#58a6ff';
  const hasDeterminateProgress = progress.length > 0;
  const overallPercent = hasDeterminateProgress
    ? Math.max(...progress.map((value) => Math.max(0, Math.min(100, value * 100))))
    : 0;

  return (
    <div>
      <style>{`@keyframes transferhub-scan { 0% { left: -35%; } 60% { left: 100%; } 100% { left: 100%; } }`}</style>

      <section style={S.section}>
        <div style={S.label}>Cimbar 摄像头接收</div>
        <p style={{ color: '#c9d1d9', fontSize: 14, lineHeight: 1.5, margin: '0 0 12px' }}>
          将摄像头对准发送端的 Cimbar 画面。应用会以相机原始分辨率持续解码，并自动重组文件。
        </p>
        <div style={S.row}>
          <label style={{ flex: '1 1 220px', maxWidth: 320 }}>
            <span style={S.label}>解码模式</span>
            <select
              value={selectedMode}
              disabled={running || initializing}
              style={S.select}
              onChange={(event) => selectMode(Number((event.target as HTMLSelectElement).value) as CimbarModeValue)}
            >
              {MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        </div>
        <div style={{ ...S.row, marginTop: 14 }}>
          {!running && !initializing
            ? <button type="button" style={{ background: '#238636', color: '#fff', border: 'none', borderRadius: 6, padding: '10px 24px', fontSize: 15, fontWeight: 600, cursor: 'pointer' }} onClick={start}>开始接收</button>
            : <button type="button" style={{ background: '#da3633', color: '#fff', border: 'none', borderRadius: 6, padding: '10px 24px', fontSize: 15, fontWeight: 600, cursor: 'pointer' }} onClick={stop}>停止扫描</button>}
        </div>
        <div role="status" aria-live="polite" style={S.status}>{status}</div>
        {error && <div role="alert" style={{ ...S.warning, marginTop: 10 }}>⚠ {error}</div>}

        {(running || hasDeterminateProgress || decodedPackets > 0) && (
          <div aria-label="Cimbar 接收进度">
            {hasDeterminateProgress ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 12 }}>
                  <span style={{ color: '#8b949e', fontSize: 12 }}>重组进度</span>
                  <span style={S.percentText}>{overallPercent.toFixed(0)}%</span>
                </div>
                <div style={S.progressTrack}>
                  <div style={S.progressFill(overallPercent)} />
                </div>
                {progress.map((value, index) => (
                  <div key={index} style={{ ...S.progressTrack, marginTop: 6 }}>
                    <div style={S.progressFill(value * 100)} />
                  </div>
                ))}
                <div style={S.progressHint}>数据到达中，正在重组文件…</div>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 12 }}>
                  <span style={{ color: '#8b949e', fontSize: 12 }}>正在扫描</span>
                  {decodedPackets > 0
                    ? <span style={S.percentText}>已锁定信号（{modeLabel(effectiveMode())}）</span>
                    : <span style={{ color: '#d29922', fontSize: 12 }}>等待有效画面…</span>}
                </div>
                <div style={S.progressTrack}>
                  <div style={S.indeterminateThumb} />
                </div>
                <div style={S.progressHint}>
                  {decodedPackets > 0
                    ? `正在持续接收数据（数据包 ${decodedPackets}）…`
                    : '对准发送端画面并保持静止；解码到首个数据包后进度将开始增长。'}
                </div>
              </>
            )}

            <div style={S.statsBar} aria-label="Cimbar 接收统计">
              <span>扫描帧 <span style={S.statValue}>{framesScanned}</span></span>
              <span>数据包 <span style={S.statValue}>{decodedPackets}</span></span>
              {running && <span>速率 <span style={S.statValue}>{packetsPerSec}/s</span></span>}
              <span>提取成功 <span style={S.statValue}>{extractOk}</span></span>
              <span>提取失败 <span style={S.statValue}>{extractFail}</span></span>
              <span>模式 <span style={S.statValue}>{selectedMode !== 0 ? modeLabel(selectedMode) : lockedMode !== 0 ? `已锁定 ${modeLabel(lockedMode)}` : '自动轮询'}</span></span>
              <span>已运行 <span style={S.statValue}>{formatDuration(elapsedSec)}</span></span>
              {hasDeterminateProgress && (
                <span>进度 <span style={S.statValue}>{overallPercent.toFixed(0)}%</span></span>
              )}
            </div>
          </div>
        )}
      </section>

      <section style={S.section}>
        <div style={S.label}>摄像头画面</div>
        <div
          style={{ position: 'relative', display: 'inline-block', maxWidth: 480, width: '100%', marginTop: 8 }}
          aria-label="Cimbar 摄像头预览"
        >
          <video ref={videoRef} muted playsInline style={{ width: '100%', borderRadius: 6, background: '#000', display: 'block' }} />
          {/* 扫描框 + 四角正方形角标：几何与二维码接收一致；颜色为官方三态（蓝/黄/绿） */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              border: `2px dashed ${stateColor}`,
              borderRadius: 8,
              pointerEvents: 'none',
            }}
          />
          {([
            ['top: 0', 'left: 0', 'borderTop', 'borderLeft'],
            ['top: 0', 'right: 0', 'borderTop', 'borderRight'],
            ['bottom: 0', 'left: 0', 'borderBottom', 'borderLeft'],
            ['bottom: 0', 'right: 0', 'borderBottom', 'borderRight'],
          ] as Array<[string, string, string, string]>).map(([posA, posB, edgeA, edgeB]) => (
            <div
              key={`${posA}-${posB}`}
              style={{
                position: 'absolute',
                [posA.split(':')[0]]: posA.split(':')[1].trim(),
                [posB.split(':')[0]]: posB.split(':')[1].trim(),
                width: 16,
                height: 16,
                [edgeA]: `3px solid ${stateColor}`,
                [edgeB]: `3px solid ${stateColor}`,
                pointerEvents: 'none',
              } as CSSProps}
            />
          ))}
        </div>
        <canvas ref={canvasRef} hidden />
      </section>

      {result && (
        <section style={S.section}>
          <div style={S.label}>恢复结果</div>
          <div style={S.result}>
            <strong>{result.filename}</strong>
            <span style={{ color: '#8b949e', marginLeft: 10 }}>{formatBytes(result.data.byteLength)}</span>
          </div>
          <button type="button" style={{ ...S.button, marginTop: 12 }} onClick={download}>下载恢复文件</button>
        </section>
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m${String(rest).padStart(2, '0')}s` : `${rest}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
