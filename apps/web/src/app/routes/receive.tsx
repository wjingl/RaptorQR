import { useEffect, useState } from 'preact/hooks';
import { ProtocolPicker } from '@/app/components/protocol_picker';
import type { TransferProtocol } from '@/app/backends/types';
import { ReceiverPage } from '@/app/routes/receiver';
import { CimbarReceivePage } from '@/app/backends/cimbar/receive_page';

const STORAGE_KEY = 'raptorqr:last-receive-protocol';

function readProtocol(): TransferProtocol {
  if (typeof window === 'undefined') return 'raptorqr';
  return window.localStorage.getItem(STORAGE_KEY) === 'cimbar' ? 'cimbar' : 'raptorqr';
}

export function ReceivePage() {
  const [protocol, setProtocol] = useState<TransferProtocol>(readProtocol);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, protocol);
  }, [protocol]);

  return (
    <>
      <ProtocolPicker value={protocol} onChange={setProtocol} direction="receive" />
      {protocol === 'raptorqr' ? <ReceiverPage /> : <CimbarReceivePage />}
    </>
  );
}
