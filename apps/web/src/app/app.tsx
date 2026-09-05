/**
 * Unified transfer shell for the RaptorQR and Cimbar backends.
 */
import { useState, useEffect } from 'preact/hooks';
import { SendPage } from '@/app/routes/send';
import { ReceivePage } from '@/app/routes/receive';

type Tab = 'send' | 'receive';

type CSSProps = Record<string, string | number>;

function getTabFromHash(): Tab {
  const hash = window.location.hash.replace(/^#/, '');
  if (hash === 'receiver' || hash === 'receive') return 'receive';
  return 'send';
}

const styles = {
  container: {
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    background: '#0d1117',
    color: '#c9d1d9',
    minHeight: '100vh',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
  } as CSSProps,
  header: {
    background: '#161b22',
    borderBottom: '1px solid #30363d',
    padding: '14px clamp(16px, 4vw, 40px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 20,
    flexWrap: 'wrap',
  } as CSSProps,
  brand: { display: 'flex', alignItems: 'baseline', gap: 10 } as CSSProps,
  logo: { fontSize: 20, fontWeight: 750, color: '#f0f6fc', letterSpacing: -0.5 } as CSSProps,
  tagline: { color: '#8b949e', fontSize: 12 } as CSSProps,
  tabBar: { display: 'flex', gap: 4, padding: 3, background: '#0d1117', borderRadius: 9 } as CSSProps,
  tab: (active: boolean): CSSProps => ({
    padding: '9px 18px',
    borderRadius: 7,
    border: '1px solid transparent',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 650,
    background: active ? '#1f6feb' : 'transparent',
    color: active ? '#fff' : '#8b949e',
    transition: 'background 120ms ease, color 120ms ease',
  }),
  main: {
    flex: 1,
    padding: '24px clamp(16px, 4vw, 40px) 40px',
    maxWidth: 1040,
    width: '100%',
    margin: '0 auto',
    boxSizing: 'border-box',
  } as CSSProps,
  live: { color: '#8b949e', fontSize: 12, marginTop: 2 } as CSSProps,
} as const;

export function App() {
  const [tab, setTab] = useState<Tab>(getTabFromHash);

  useEffect(() => {
    const onHashChange = () => setTab(getTabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = (nextTab: Tab) => {
    const hash = nextTab === 'send' ? 'send' : 'receive';
    window.location.hash = hash;
    setTab(nextTab);
  };

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div style={styles.brand}>
          <div>
            <div style={styles.logo}>◈ Transfer Hub</div>
            <div style={styles.live}>RaptorQR · Cimbar</div>
          </div>
          <span style={styles.tagline}>同一界面，选择合适的传输格式</span>
        </div>
        <nav style={styles.tabBar} aria-label="传输方向" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'send'}
            aria-current={tab === 'send' ? 'page' : undefined}
            style={styles.tab(tab === 'send')}
            onClick={() => navigate('send')}
          >
            ↑ 发送
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'receive'}
            aria-current={tab === 'receive' ? 'page' : undefined}
            style={styles.tab(tab === 'receive')}
            onClick={() => navigate('receive')}
          >
            ↓ 接收
          </button>
        </nav>
      </header>
      <main style={styles.main}>
        {tab === 'send' ? <SendPage /> : <ReceivePage />}
      </main>
    </div>
  );
}
