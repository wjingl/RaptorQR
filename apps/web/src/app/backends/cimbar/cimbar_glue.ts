// Own integration glue. Loads the *unmodified* official Cimbar runtime
// (cimbar_js.<ts>.js) on the main thread (exactly like the official recv.html
// does) and exposes the official C API through a small typed sink that mirrors
// the official Sink/Recv.reassemble_file behaviour. No official file is edited;
// all orchestration lives here, in our code.
import { CIMBAR_FILES, cimbarFileUrl } from './runtime';

export type CimbarModeValue = 0 | 66 | 67 | 68 | 4;

interface ModuleLike {
  onRuntimeInitialized?: () => void;
  HEAPU8?: Uint8Array;
  _malloc?: (size: number) => number;
  _free?: (ptr: number) => void;
  _cimbard_configure_decode?: (mode: number) => void;
  _cimbard_get_bufsize?: () => number;
  _cimbard_fountain_decode?: (ptr: number, len: number) => number | bigint;
  _cimbard_get_report?: (ptr: number, maxlen: number) => number;
  _cimbard_get_filesize?: (id: number) => number;
  _cimbard_get_filename?: (id: number, ptr: number, maxlen: number) => number;
  _cimbard_decompress_read?: (id: number, ptr: number, size: number) => number;
  _cimbard_get_decompress_bufsize?: () => number;
}

export interface RecoveredFile {
  filename: string;
  data: ArrayBuffer;
}

export interface FeedOutcome {
  mode: number;
  progress: number[] | null;
  completed: boolean;
  id: number | null;
}

const REPORT_BUFFER = 4096;
const FILENAME_BUFFER = 1024;
const CHUNK_SIZE = 256 * 1024;

let modulePromise: Promise<ModuleLike> | null = null;
let moduleObject: ModuleLike | null = null;

function w(): { Module?: ModuleLike } & Record<string, unknown> {
  return window as unknown as { Module?: ModuleLike } & Record<string, unknown>;
}

function loadMainModule(): Promise<ModuleLike> {
  if (modulePromise) return modulePromise;
  const existing = w().Module;
  if (existing && typeof existing._cimbard_fountain_decode === 'function') {
    moduleObject = existing;
    modulePromise = Promise.resolve(existing);
    return modulePromise;
  }
  modulePromise = new Promise<ModuleLike>((resolve, reject) => {
    w().Module = {
      onRuntimeInitialized: () => {
        moduleObject = w().Module ?? null;
        if (moduleObject) resolve(moduleObject);
        else reject(new Error('Cimbar 运行时未初始化。'));
      },
    } as ModuleLike;
    const script = document.createElement('script');
    script.src = cimbarFileUrl(CIMBAR_FILES.glue);
    script.onerror = () => {
      modulePromise = null;
      reject(new Error('Cimbar 运行时加载失败。'));
    };
    document.head.appendChild(script);
  });
  return modulePromise;
}

function heapOf(mod: ModuleLike): Uint8Array {
  const heap = mod.HEAPU8;
  if (!heap) throw new Error('Cimbar 运行时尚未就绪。');
  return heap;
}

function rewrap(mod: ModuleLike, view: Uint8Array): Uint8Array {
  if (view.buffer === mod.HEAPU8!.buffer) return view;
  const fresh = heapOf(mod);
  return new Uint8Array(fresh.buffer, view.byteOffset, view.byteLength);
}

function need<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`Cimbar API 不可用：${name}`);
  return value;
}

function readReport(mod: ModuleLike, scratch: Uint8Array): number[] | null {
  const getReport = need(mod._cimbard_get_report, '_cimbard_get_report');
  const reportView = rewrap(mod, scratch);
  const length = getReport(reportView.byteOffset, reportView.length);
  if (length <= 0) return null;
  const text = new TextDecoder().decode(new Uint8Array(mod.HEAPU8!.buffer, reportView.byteOffset, length));
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Own main-thread sink for the official decoder state machine, mirroring the
 * official Sink in recv.js: feed extracted fountain bytes, surface the official
 * progress report, and recover+decompress the file through the official C API.
 */
export class CimbarSink {
  private mod: ModuleLike;
  private configuredMode = 0;
  private fountain: Uint8Array | null = null;
  private reportScratch: Uint8Array | null = null;
  private chunkBuffer: Uint8Array | null = null;

  private constructor(mod: ModuleLike) {
    this.mod = mod;
  }

  static async create(): Promise<CimbarSink> {
    const mod = await loadMainModule();
    return new CimbarSink(mod);
  }

  get mode(): number {
    return this.configuredMode;
  }

  configure(mode: number): void {
    if (mode > 0 && mode !== this.configuredMode) {
      need(this.mod._cimbard_configure_decode, '_cimbard_configure_decode')(mode);
      this.configuredMode = mode;
      this.fountain = null;
    }
  }

  feed(bytes: Uint8Array, mode: number): FeedOutcome {
    this.configure(mode);
    const mod = this.mod;
    const fountainDecode = need(mod._cimbard_fountain_decode, '_cimbard_fountain_decode');
    if (bytes.length === 0) return { mode: this.configuredMode, progress: null, completed: false, id: null };

    if (!this.fountain) {
      const bufSize = need(mod._cimbard_get_bufsize, '_cimbard_get_bufsize')();
      const ptr = need(mod._malloc, '_malloc')(Math.max(1, bufSize));
      this.fountain = new Uint8Array(mod.HEAPU8!.buffer, ptr, bufSize);
    }
    this.fountain = rewrap(mod, this.fountain);
    if (bytes.length > this.fountain.length) {
      throw new Error('Cimbar 帧数据超过缓冲上限。');
    }
    this.fountain.set(bytes);

    const result = fountainDecode(this.fountain.byteOffset, bytes.length);
    const reportView = this.reportScratch ?? (this.reportScratch = new Uint8Array(mod.HEAPU8!.buffer, need(mod._malloc, '_malloc')(REPORT_BUFFER), REPORT_BUFFER));
    const progress = readReport(mod, reportView);

    const completed = typeof result === 'bigint' ? result > 0n : result > 0;
    const id = completed
      ? (typeof result === 'bigint' ? Number(result & 0xffffffffn) : Number(result & 0xffffffff))
      : null;
    return { mode: this.configuredMode, progress, completed, id };
  }

  recover(id: number): RecoveredFile {
    const mod = this.mod;
    const getFilename = need(mod._cimbard_get_filename, '_cimbard_get_filename');
    const namePtr = need(mod._malloc, '_malloc')(FILENAME_BUFFER);
    try {
      const nameView = new Uint8Array(mod.HEAPU8!.buffer, namePtr, FILENAME_BUFFER);
      const nameLength = getFilename(id, namePtr, nameView.length);
      const filename = nameLength > 0
        ? new TextDecoder().decode(new Uint8Array(mod.HEAPU8!.buffer, namePtr, nameLength))
        : 'cimbar-recovered.bin';

      const decompress = need(mod._cimbard_decompress_read, '_cimbard_decompress_read');
      const chunkSize = Math.max(1, need(mod._cimbard_get_decompress_bufsize, '_cimbard_get_decompress_bufsize')());
      if (!this.chunkBuffer || this.chunkBuffer.length < chunkSize) {
        const ptr = need(mod._malloc, '_malloc')(chunkSize);
        this.chunkBuffer = new Uint8Array(mod.HEAPU8!.buffer, ptr, chunkSize);
      }
      this.chunkBuffer = rewrap(mod, this.chunkBuffer);

      const chunks: Uint8Array[] = [];
      let total = 0;
      for (let guard = 0; guard < 1_000_000; guard++) {
        const length = decompress(id, this.chunkBuffer.byteOffset, this.chunkBuffer.length);
        if (length <= 0) break;
        const chunk = new Uint8Array(mod.HEAPU8!.buffer, this.chunkBuffer.byteOffset, length).slice();
        chunks.push(chunk);
        total += chunk.length;
      }
      const data = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      return { filename: filename || 'cimbar-recovered.bin', data: data.buffer as ArrayBuffer };
    } finally {
      need(mod._free, '_free')(namePtr);
    }
  }

  dispose(): void {
    const mod = this.mod;
    if (this.fountain) {
      try { need(mod._free, '_free')(this.fountain.byteOffset); } catch { /* noop */ }
      this.fountain = null;
    }
    if (this.reportScratch) {
      try { need(mod._free, '_free')(this.reportScratch.byteOffset); } catch { /* noop */ }
      this.reportScratch = null;
    }
    if (this.chunkBuffer) {
      try { need(mod._free, '_free')(this.chunkBuffer.byteOffset); } catch { /* noop */ }
      this.chunkBuffer = null;
    }
  }
}
