export const CIMBAR_RUNTIME_VERSION = 'v0.6.8';
export const CIMBAR_RUNTIME_BASE = './cimbar/';

// Official Cimbar runtime (sz3/libcimbar v0.6.8 release, pristine files).
// The receive experience embeds the official recv.html page unchanged.
export const CIMBAR_FILES = {
  glue: 'cimbar_js.2026-08-21T2336.js',
  wasm: 'cimbar_js.2026-08-21T2336.wasm',
  send: 'send.2026-08-21T2336.js',
  sendWorker: 'send-worker.2026-08-21T2336.js',
  recvWorker: 'recv-worker.2026-08-21T2336.js',
  recv: 'recv.2026-08-21T2336.js',
  zstd: 'zstd.2026-08-21T2336.js',
  recvHtml: 'recv.html',
  pwaRecv: 'pwa-recv.2026-08-21T2336.json',
} as const;

export interface CimbarRuntimeStatus {
  available: boolean;
  missing: string[];
}

export function cimbarFileUrl(name: string): string {
  return `${CIMBAR_RUNTIME_BASE}${name}`;
}

export function cimbarReceiverUrl(): string {
  return cimbarFileUrl(CIMBAR_FILES.recvHtml);
}

export async function checkCimbarRuntime(): Promise<CimbarRuntimeStatus> {
  const required = Object.values(CIMBAR_FILES);
  const missing: string[] = [];
  await Promise.all(required.map(async (asset) => {
    try {
      const response = await fetch(cimbarFileUrl(asset), { method: 'HEAD', cache: 'no-store' });
      if (!response.ok) missing.push(asset);
    } catch {
      missing.push(asset);
    }
  }));
  return { available: missing.length === 0, missing };
}
