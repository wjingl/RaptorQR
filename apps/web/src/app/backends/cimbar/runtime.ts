// Official Cimbar runtime (sz3/libcimbar v0.6.8 release, pristine files).
// We only *ship and drive* the official artifacts unchanged; filenames are the
// official release names so the official glue/worker importScripts references
// resolve inside this directory without any modification of official files.
export const CIMBAR_RUNTIME_VERSION = 'v0.6.8';
export const CIMBAR_RUNTIME_BASE = './cimbar/';

export const CIMBAR_FILES = {
  glue: 'cimbar_js.2026-08-21T2336.js',
  wasm: 'cimbar_js.2026-08-21T2336.wasm',
  send: 'send.2026-08-21T2336.js',
  sendWorker: 'send-worker.2026-08-21T2336.js',
  recvWorker: 'recv-worker.2026-08-21T2336.js',
} as const;

export interface CimbarRuntimeStatus {
  available: boolean;
  missing: string[];
}

export function cimbarFileUrl(name: string): string {
  return `${CIMBAR_RUNTIME_BASE}${name}`;
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
