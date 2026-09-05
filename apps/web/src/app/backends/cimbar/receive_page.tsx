import { useEffect, useState } from 'preact/hooks';
import { cimbarReceiverUrl, checkCimbarRuntime } from './runtime';

type CSSProps = Record<string, string | number>;

const S = {
  section: { background: '#161b22', border: '1px solid #30363d', borderRadius: 12, padding: 18, marginBottom: 16 } as CSSProps,
  label: { display: 'block', color: '#8b949e', fontSize: 12, fontWeight: 700, letterSpacing: 0.7, textTransform: 'uppercase', marginBottom: 8 } as CSSProps,
  row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } as CSSProps,
  button: { background: '#238636', color: '#fff', border: 0, borderRadius: 6, padding: '10px 24px', fontSize: 15, fontWeight: 600, cursor: 'pointer' } as CSSProps,
  secondary: { background: '#21262d', color: '#c9d1d9', border: '1px solid #30363d', borderRadius: 6, padding: '10px 16px', fontSize: 14, cursor: 'pointer' } as CSSProps,
  status: { color: '#8b949e', fontSize: 13, marginTop: 10 } as CSSProps,
  warning: { color: '#d29922', background: '#2d1b00', border: '1px solid #9e6a03', padding: '10px 12px', borderRadius: 8, fontSize: 12, lineHeight: 1.5 } as CSSProps,
  frame: {
    width: '100%',
    height: 'min(78vh, 900px)',
    border: '1px solid #30363d',
    borderRadius: 8,
    background: '#000',
    display: 'block',
    marginTop: 10,
  } as CSSProps,
} as const;

/**
 * Cimbar 接收：直接内嵌官方接收页（recv.html，字节原样），相机捕获、模式
 * 自动轮询、角框提示、进度条与文件恢复全部由官方实现驱动——与官方接收器行为一致。
 */
export function CimbarReceivePage() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [embedded, setEmbedded] = useState(true);

  useEffect(() => {
    let cancelled = false;
    checkCimbarRuntime().then((status) => {
      if (cancelled) return;
      if (!status.available) setError(`Cimbar 运行时缺少：${status.missing.join(', ')}`);
    });
    return () => { cancelled = true; };
  }, []);

  const src = cimbarReceiverUrl();

  return (
    <div>
      <section style={S.section}>
        <div style={S.label}>Cimbar 摄像头接收</div>
        <p style={{ color: '#c9d1d9', fontSize: 14, lineHeight: 1.5, margin: '0 0 12px' }}>
          内嵌官方 Cimbar 接收器：允许摄像头后对准发送画面即可，模式自动轮询、角框提示、进度与文件下载均为官方实现。
        </p>
        <div style={S.row}>
          <button type="button" style={S.button} onClick={() => window.open(src, '_blank', 'noopener')}>
            在新标签页打开官方接收器
          </button>
          {embedded && (
            <button type="button" style={S.secondary} onClick={() => setEmbedded(false)}>
              切换为仅页面模式
            </button>
          )}
        </div>
        <div role="status" aria-live="polite" style={S.status}>
          {ready ? '官方接收器已加载。' : error ? '' : '正在加载官方接收器…'}
        </div>
        {error && <div role="alert" style={{ ...S.warning, marginTop: 10 }}>⚠ {error}</div>}
      </section>

      {embedded && !error && (
        <section style={S.section}>
          <div style={S.label}>官方接收器</div>
          <iframe
            src={src}
            title="官方 Cimbar 接收器"
            allow="camera; fullscreen"
            style={S.frame}
            onLoad={() => setReady(true)}
          />
          <div style={{ ...S.warning, marginTop: 10 }}>
            摄像头要求 HTTPS 或 localhost：跨设备访问时请用 https://（部署目录执行 ./deploy/gen-cert.sh 可一键开启），
            或使用离线接收包/Android 接收端（本机打开即 localhost）。右上角菜单可切换 B/Bm/Bu/4C 模式与全屏。
          </div>
        </section>
      )}
    </div>
  );
}
