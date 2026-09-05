import type { TransferProtocol } from '@/app/backends/types';
import { PROTOCOLS } from '@/app/backends/types';

type CSSProps = Record<string, string | number>;

const S = {
  section: {
    background: '#161b22',
    border: '1px solid #30363d',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  } as CSSProps,
  label: {
    display: 'block',
    color: '#8b949e',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0.7,
    textTransform: 'uppercase',
    marginBottom: 10,
  } as CSSProps,
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: 10,
  } as CSSProps,
  option: (active: boolean, available: boolean): CSSProps => ({
    position: 'relative',
    textAlign: 'left',
    border: `1px solid ${active ? '#58a6ff' : '#30363d'}`,
    borderRadius: 10,
    background: active ? '#17263d' : '#0d1117',
    color: available ? '#f0f6fc' : '#8b949e',
    padding: '13px 14px',
    cursor: available ? 'pointer' : 'not-allowed',
    opacity: available ? 1 : 0.72,
  }),
  title: { display: 'block', fontWeight: 700, fontSize: 15, marginBottom: 4 } as CSSProps,
  subtitle: { display: 'block', fontSize: 12, color: '#8b949e', lineHeight: 1.45 } as CSSProps,
  badge: {
    position: 'absolute',
    top: 10,
    right: 10,
    color: '#d29922',
    fontSize: 11,
    fontWeight: 700,
  } as CSSProps,
} as const;

interface ProtocolPickerProps {
  value: TransferProtocol;
  onChange: (value: TransferProtocol) => void;
  direction: 'send' | 'receive';
}

export function ProtocolPicker({ value, onChange, direction }: ProtocolPickerProps) {
  return (
    <section style={S.section} aria-labelledby={`${direction}-protocol-label`}>
      <div id={`${direction}-protocol-label`} style={S.label}>传输格式</div>
      <div style={S.grid} role="radiogroup" aria-label="传输格式">
        {PROTOCOLS.map((protocol) => (
          <button
            key={protocol.id}
            type="button"
            role="radio"
            aria-checked={value === protocol.id}
            disabled={!protocol.available}
            style={S.option(value === protocol.id, protocol.available)}
            onClick={() => onChange(protocol.id)}
          >
            <span style={S.title}>{protocol.name}</span>
            <span style={S.subtitle}>{protocol.description}</span>
            {!protocol.available && <span style={S.badge}>未安装</span>}
          </button>
        ))}
      </div>
      {value === 'cimbar' && (
        <div role="status" style={{ color: '#d29922', fontSize: 12, marginTop: 10 }}>
          {PROTOCOLS[1].availabilityNote}
        </div>
      )}
    </section>
  );
}
