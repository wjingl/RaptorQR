import { useEffect, useRef, useState } from 'preact/hooks';
import { FileDropzone } from '@/app/components/file_dropzone';
import { CimbarSender, type CimbarMode } from './sender';

type CSSProps = Record<string, string | number>;

const S = {
  section: { background: '#161b22', border: '1px solid #30363d', borderRadius: 12, padding: 18, marginBottom: 16 } as CSSProps,
  label: { display: 'block', color: '#8b949e', fontSize: 12, fontWeight: 700, letterSpacing: 0.7, textTransform: 'uppercase', marginBottom: 8 } as CSSProps,
  row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } as CSSProps,
  select: { width: '100%', background: '#0d1117', color: '#c9d1d9', border: '1px solid #30363d', borderRadius: 7, padding: '9px 10px', fontSize: 14 } as CSSProps,
  button: { background: '#238636', color: '#fff', border: 0, borderRadius: 7, padding: '10px 16px', fontWeight: 700, cursor: 'pointer' } as CSSProps,
  secondary: { background: '#21262d', color: '#f0f6fc', border: '1px solid #30363d', borderRadius: 7, padding: '10px 14px', cursor: 'pointer' } as CSSProps,
  canvas: { width: 'min(100%, 640px)', aspectRatio: '1', background: '#0d1117', display: 'block', margin: '14px auto 0', borderRadius: 8 } as CSSProps,
  status: { color: '#8b949e', fontSize: 13, marginTop: 10 } as CSSProps,
  warning: { color: '#d29922', background: '#2d1b00', border: '1px solid #9e6a03', padding: '10px 12px', borderRadius: 8, fontSize: 12, lineHeight: 1.5 } as CSSProps,
} as const;

const MODES: Array<{ value: CimbarMode; label: string }> = [
  { value: 'B', label: 'B · 兼容' },
  { value: 'Bm', label: 'Bm · 平衡' },
  { value: 'Bu', label: 'Bu · 高密度' },
  { value: '4C', label: '4C · 彩色' },
];

export function CimbarSendPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const senderRef = useRef<CimbarSender | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<CimbarMode>('B');
  const [fps, setFps] = useState(5);
  const [running, setRunning] = useState(false);
  const [canvasKey, setCanvasKey] = useState(0);
  const [status, setStatus] = useState('选择文件后开始发送。');
  const [error, setError] = useState('');

  useEffect(() => () => senderRef.current?.dispose(), []);

  const start = async () => {
    if (!file) {
      setError('请先选择要发送的文件。');
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setError('文件过大：单次传输上限 50 MB。');
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    setError('');
    setRunning(true);
    setStatus('正在初始化 Cimbar WASM…');
    try {
      const sender = new CimbarSender(canvas, {
        onReady: () => setStatus('Cimbar 已就绪，正在发送。'),
        onAspectRatio: (ratio) => { canvas.style.aspectRatio = String(ratio); },
        onActive: () => setStatus('正在发送 · 可用另一台设备扫描画面'),
        onError: (message) => { setError(message); setRunning(false); },
      });
      senderRef.current = sender;
      await sender.start();
      sender.setMode(mode);
      sender.setFps(fps);
      await sender.encode(file);
      setStatus(`正在发送 ${file.name}`);
    } catch (cause) {
      senderRef.current?.dispose();
      senderRef.current = null;
      setRunning(false);
      setCanvasKey((key) => key + 1);
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus('发送未启动。');
    }
  };

  const stop = () => {
    senderRef.current?.stop();
    senderRef.current = null;
    setRunning(false);
    setStatus('已停止。再次点击“开始发送”可重新发送当前文件。');
    setCanvasKey((key) => key + 1);
  };

  const changeMode = (value: CimbarMode) => {
    setMode(value);
    if (senderRef.current) senderRef.current.setMode(value);
  };

  const changeFps = (value: number) => {
    setFps(value);
    if (senderRef.current) senderRef.current.setFps(value);
  };

  return (
    <div>
      <section style={S.section}>
        <div style={S.label}>Cimbar 文件</div>
        <FileDropzone file={file} onFile={setFile} disabled={running} title="拖放文件到这里" hint="支持文件传输；当前发布包上限由浏览器内存决定" />
      </section>

      <section style={S.section}>
        <div style={S.row}>
          <label style={{ flex: '1 1 220px' }}>
            <span style={S.label}>传输模式</span>
            <select value={mode} style={S.select} disabled={running} onChange={(event) => changeMode((event.target as HTMLSelectElement).value as CimbarMode)}>
              {MODES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label style={{ flex: '1 1 220px' }}>
            <span style={S.label}>播放速度 · {fps} fps</span>
            <input type="range" min="2" max="30" step="1" value={fps} onChange={(event) => changeFps(Number((event.target as HTMLInputElement).value))} style={{ width: '100%', accentColor: '#58a6ff' }} />
          </label>
        </div>
        <div style={{ ...S.row, marginTop: 14 }}>
          {!running
            ? <button type="button" style={S.button} onClick={start}>开始发送</button>
            : <button type="button" style={S.secondary} onClick={stop}>停止</button>}
        </div>
        <div role="status" aria-live="polite" style={S.status}>{status}</div>
        {error && <div role="alert" style={{ ...S.warning, marginTop: 10 }}>⚠ {error}</div>}
      </section>

      <section style={S.section}>
        <div style={S.label}>播放画面</div>
        <canvas key={canvasKey} ref={canvasRef} width={640} height={640} aria-label="Cimbar 实时传输画面" style={S.canvas} />
        <div style={S.warning}>
          Cimbar 会显示快速变化的彩色图案。对闪烁敏感时请调低速度或停止播放；不要长时间直视画面。
        </div>
      </section>
    </div>
  );
}
