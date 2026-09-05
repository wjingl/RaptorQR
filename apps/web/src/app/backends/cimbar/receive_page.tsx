import { useEffect, useRef, useState } from 'preact/hooks';
import { cimbarFileUrl, CIMBAR_FILES, checkCimbarRuntime } from './runtime';

type CSSProps = Record<string, string | number>;

const S = {
  section: { background: '#161b22', border: '1px solid #30363d', borderRadius: 12, padding: 18, marginBottom: 16 } as CSSProps,
  label: { display: 'block', color: '#8b949e', fontSize: 12, fontWeight: 700, letterSpacing: 0.7, textTransform: 'uppercase', marginBottom: 8 } as CSSProps,
  row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } as CSSProps,
  select: { width: '100%', background: '#0d1117', color: '#c9d1d9', border: '1px solid #30363d', borderRadius: 7, padding: '9px 10px', fontSize: 14 } as CSSProps,
  button: { background: '#238636', color: '#fff', border: 0, borderRadius: 6, padding: '10px 24px', fontSize: 15, fontWeight: 600, cursor: 'pointer' } as CSSProps,
  btnStop: { background: '#da3633', color: '#fff', border: 0, borderRadius: 6, padding: '10px 24px', fontSize: 15, fontWeight: 600, cursor: 'pointer' } as CSSProps,
  status: { color: '#8b949e', fontSize: 13, marginTop: 10 } as CSSProps,
  warn: { background: '#3d2600', border: '1px solid #bb8009', borderRadius: 6, padding: '10px 14px', color: '#d29922', fontSize: 13, marginTop: 8 } as CSSProps,
  statsBar: { display: 'flex', gap: 16, alignItems: 'center', fontSize: 12, color: '#8b949e', marginTop: 6, flexWrap: 'wrap' } as CSSProps,
  statValue: { color: '#c9d1d9', fontWeight: 600, fontFamily: 'monospace', fontSize: 13 } as CSSProps,
} as const;

const MODE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'Auto', label: '自动轮询（推荐）' },
  { value: 'B', label: 'B' },
  { value: 'Bu', label: 'Bu' },
  { value: 'Bm', label: 'Bm' },
  { value: '4C', label: '4C' },
];

interface RecvLike {
  init_ww: (n: number) => void;
  init_video: (v: HTMLVideoElement) => void;
  setMode: (m: string | number) => void;
  on_decode: (wid: number, data: Record<string, unknown>) => void;
}

/**
 * Cimbar 接收：UI 为本项目样式，内部引擎为官方 recv.js 原封不动运行——
 * 官方代码自身负责相机初始化（含连续对焦/曝光约束）、rVFC 帧捕获、原生
 * NV12/I420 格式、4 worker 流水线、模式自动轮询、角框状态机、进度条与
 * zstd 文件恢复下载。本页只提供官方代码所需的挂载 DOM 与主题化样式。
 */
export function CimbarReceivePage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState('Auto');
  const [packets, setPackets] = useState(0);
  const [extractOk, setExtractOk] = useState(0);
  const [extractFail, setExtractFail] = useState(0);
  const packetsRef = useRef(0);

  // 加载官方引擎脚本（顺序与官方 recv.html 一致：recv.js/zstd.js 先，cimbar_js 主线程 glue 最后）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const runtime = await checkCimbarRuntime();
        if (cancelled) return;
        if (!runtime.available) {
          setError(`Cimbar 运行时缺少：${runtime.missing.join(', ')}`);
          return;
        }
        // 官方 recv.js 以硬编码相对路径创建 Worker，重映射到运行时目录
        const NativeWorker = window.Worker;
        const ShimedWorker = class extends NativeWorker {
          constructor(url: URL | string, options?: WorkerOptions) {
            const spec = String(url);
            super(spec.endsWith(CIMBAR_FILES.recvWorker) ? cimbarFileUrl(CIMBAR_FILES.recvWorker) : url, options);
          }
        };
        (window as unknown as { Worker: typeof Worker }).Worker = ShimedWorker as typeof Worker;

        const loadScript = (src: string) => new Promise<void>((resolve, reject) => {
          const el = document.createElement('script');
          el.src = src;
          el.onload = () => resolve();
          el.onerror = () => reject(new Error(`加载失败：${src}`));
          document.head.appendChild(el);
        });
        await loadScript(cimbarFileUrl(CIMBAR_FILES.recv));
        await loadScript(cimbarFileUrl(CIMBAR_FILES.zstd));
        await new Promise<void>((resolve, reject) => {
          (window as unknown as { Module: { onRuntimeInitialized?: () => void } }).Module = {
            onRuntimeInitialized: () => resolve(),
          };
          loadScript(cimbarFileUrl(CIMBAR_FILES.glue)).catch(reject);
          // 同步编译时 onRuntimeInitialized 可能不触发，轮询兜底
          const timer = window.setInterval(() => {
            const mod = (window as unknown as { Module?: Record<string, unknown> }).Module;
            if (mod && typeof mod._cimbard_get_bufsize === 'function') {
              window.clearInterval(timer);
              resolve();
            }
          }, 200);
          window.setTimeout(() => { window.clearInterval(timer); }, 20000);
        });
        if (!cancelled) setReady(true);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const start = () => {
    setError('');
    const recv = (window as unknown as { Recv?: RecvLike }).Recv;
    const video = videoRef.current;
    if (!recv || !video) { setError('官方接收引擎尚未就绪，请稍候重试。'); return; }
    if (!window.isSecureContext) {
      setError('无法使用摄像头：当前通过 HTTP 且非本机访问，浏览器禁止不安全页面调用摄像头。请改用 HTTPS、在本机用 localhost 访问，或使用离线接收包/Android 接收端。');
      return;
    }
    // 诊断计数：包装官方 on_decode（worker onmessage 在事件到达时才解引用，包装生效）
    const patched = recv as RecvLike & { __patched?: boolean };
    if (!patched.__patched) {
      const original = recv.on_decode.bind(recv);
      recv.on_decode = (wid: number, data: Record<string, unknown>) => {
        if (data.nodata) setExtractOk((c) => c + 1);
        else if (data.failed_extract) setExtractFail((c) => c + 1);
        if (data.buff) {
          packetsRef.current += 1;
          setPackets(packetsRef.current);
        }
        original(wid, data);
      };
      patched.__patched = true;
    }
    try {
      recv.init_ww(4); // 官方 worker 流水线
      recv.init_video(video); // 官方相机初始化与 rVFC 帧捕获
      if (mode !== 'Auto') recv.setMode(mode);
      setStarted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const changeMode = (value: string) => {
    setMode(value);
    if (started) {
      (window as unknown as { Recv?: Pick<RecvLike, 'setMode'> }).Recv?.setMode(value);
    }
  };

  return (
    <div>
      <section style={S.section}>
        <div style={S.label}>Cimbar 摄像头接收</div>
        <p style={{ color: '#c9d1d9', fontSize: 14, lineHeight: 1.5, margin: '0 0 12px' }}>
          允许摄像头后对准 Cimbar 发送画面。内部引擎为官方 recv.js 原版实现：连续对焦/曝光、
          原生分辨率捕获、4 worker 并行、模式自动轮询、角框状态提示与文件恢复下载均为官方逻辑。
        </p>
        <div style={S.row}>
          <label style={{ flex: '1 1 200px', maxWidth: 260 }}>
            <span style={S.label}>解码模式</span>
            <select value={mode} style={S.select} onChange={(event) => changeMode((event.target as HTMLSelectElement).value)}>
              {MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        </div>
        <div style={{ ...S.row, marginTop: 14 }}>
          {!started
            ? <button type="button" style={S.button} onClick={start} disabled={!ready}>{ready ? '开始接收' : '引擎加载中…'}</button>
            : <button type="button" style={S.btnStop} onClick={() => window.location.reload()}>停止并重置</button>}
        </div>
        <div role="status" aria-live="polite" style={S.status}>{error ? '' : ready ? (started ? '扫描中：角框黄色=提取中，绿色=已锁定解码' : '引擎就绪，点击开始接收。') : '正在加载官方引擎…'}</div>
        {error && <div role="alert" style={S.warn}>⚠ {error}</div>}
      </section>

      <section style={S.section}>
        <div style={S.label}>摄像头画面</div>
        {/* 官方引擎所需的挂载节点（id 与官方 recv.js 一一对应，样式主题化） */}
        <style>{`
          #crosshair1, #crosshair2 { position: absolute !important; width: 34px !important; height: 34px !important; z-index: 5; pointer-events: none; transition: border-color .2s; }
          #crosshair1 { top: 4% !important; right: 4% !important; left: auto !important; bottom: auto !important; border-top: 4px solid; border-right: 4px solid; border-left: none !important; border-bottom: none !important; }
          #crosshair2 { bottom: 4% !important; left: 4% !important; right: auto !important; top: auto !important; border-bottom: 4px solid; border-left: 4px solid; border-right: none !important; border-top: none !important; }
          .crosshairs { border-color: #58a6ff !important; }
          .crosshairs.scanning_xhairs { border-color: #FFFF00 !important; }
          .crosshairs.active_xhairs { border-color: #00FF00 !important; }
          #progress_bars .progress { height: 10px; width: 0%; background: #58a6ff; border-radius: 999px; margin-top: 5px; transition: width .15s ease; }
        `}</style>
        <div style={{ position: 'relative', display: 'inline-block', maxWidth: 480, width: '100%', marginTop: 8 }}>
          <video ref={videoRef} style={{ width: '100%', borderRadius: 6, background: '#000', display: 'block' }} playsInline muted />
          <div style={{ position: 'absolute', inset: 0, border: '2px dashed rgba(88, 166, 255, 0.55)', borderRadius: 8, pointerEvents: 'none' }} />
          <div id="crosshair1" className="crosshairs" />
          <div id="crosshair2" className="crosshairs" />
        </div>
        <div style={S.statsBar} aria-label="Cimbar 接收统计">
          <span>数据包 <span style={S.statValue}>{packets}</span></span>
          <span>提取成功 <span style={S.statValue}>{extractOk}</span></span>
          <span>提取失败 <span style={S.statValue}>{extractFail}</span></span>
          <span>模式 <span style={S.statValue}>{mode === 'Auto' ? `自动轮询${started && packets > 0 ? '（已锁定）' : ''}` : mode}</span></span>
        </div>
        {/* 官方进度条容器与状态节点：由官方代码直接读写 */}
        <div id="tdec" style={{ color: '#8b949e', fontSize: 12, marginTop: 8, fontFamily: 'monospace', wordBreak: 'break-all' }} />
        <div id="progress_bars" style={{ marginTop: 4, maxWidth: 480 }} />
        <div id="errorbox" style={{ color: '#8b949e', fontSize: 11, marginTop: 6, fontFamily: 'monospace', minHeight: 14 }} />
        <div style={{ display: 'none' }}>
          <div id="framesInFlight" />
          <div id="mode-val" />
          <div id="nav-container" />
          <div id="t0" /><div id="t1" /><div id="t2" /><div id="t3" />
        </div>
      </section>
    </div>
  );
}
