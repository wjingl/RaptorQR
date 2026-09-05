import { useEffect, useState } from 'preact/hooks';
import { ProtocolPicker } from '@/app/components/protocol_picker';
import type { TransferProtocol } from '@/app/backends/types';
import { SenderPage } from '@/app/routes/sender';
import { CimbarSendPage } from '@/app/backends/cimbar/send_page';

const STORAGE_KEY = 'raptorqr:last-send-protocol';

type CSSProps = Record<string, string | number>;

const S = {
  unavailable: {
    background: '#2d1b00',
    border: '1px solid #9e6a03',
    borderRadius: 12,
    padding: 20,
    color: '#d29922',
    lineHeight: 1.55,
  } as CSSProps,
  code: {
    display: 'block',
    marginTop: 12,
    padding: 12,
    borderRadius: 8,
    background: '#161b22',
    color: '#c9d1d9',
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    fontSize: 12,
    overflowX: 'auto',
  } as CSSProps,
} as const;

function readProtocol(): TransferProtocol {
  if (typeof window === 'undefined') return 'raptorqr';
  return window.localStorage.getItem(STORAGE_KEY) === 'cimbar' ? 'cimbar' : 'raptorqr';
}

export function SendPage() {
  const [protocol, setProtocol] = useState<TransferProtocol>(readProtocol);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, protocol);
  }, [protocol]);

  return (
    <>
      <ProtocolPicker value={protocol} onChange={setProtocol} direction="send" />
      {protocol === 'raptorqr' ? <SenderPage /> : <CimbarSendPage />}
    </>
  );
}

export function CimbarUnavailable({ direction }: { direction: 'send' | 'receive' }) {
  const verb = direction === 'send' ? '发送' : '接收';
  return (
    <section style={S.unavailable} role="status" aria-live="polite">
      <strong>Cimbar 运行时尚未随当前构建发布。</strong>
      <p style={{ margin: '8px 0 0' }}>
        {verb}功能的旧版 WASM 入口已被隔离，待提供 libcimbar 的
        <code>cimbar_js.js</code> 与对应 WASM 产物后即可接入，不会影响 RaptorQR 的使用。
      </p>
      <code style={S.code}>
        libcimbar/web/cimbar_js.js{`\n`}libcimbar/web/cimbar_js.wasm
      </code>
    </section>
  );
}
