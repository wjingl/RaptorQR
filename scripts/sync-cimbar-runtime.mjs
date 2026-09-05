// Syncs the *unmodified* official Cimbar WASM runtime (sz3/libcimbar release
// archive) into apps/web/public/cimbar/.
//
// Policy: we ship the official runtime artifacts byte-for-byte, under their
// official release filenames. No official file is patched or renamed. All
// integration (driving the official send/recv workers over their stock
// protocols, the main-thread decoder sink) lives in our own sources.
import { mkdir, readdir, rm, cp } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'apps', 'web', 'public', 'cimbar');
const version = process.env.CIMBAR_RUNTIME_VERSION || 'v0.6.8';
const archive = join(root, '.cache', `cimbar-${version}.tar.gz`);

// The pinned official release files the app drives (runtime.ts CIMBAR_FILES).
const PINNED = {
  glue: 'cimbar_js.2026-08-21T2336.js',
  wasm: 'cimbar_js.2026-08-21T2336.wasm',
  send: 'send.2026-08-21T2336.js',
  sendWorker: 'send-worker.2026-08-21T2336.js',
  recvWorker: 'recv-worker.2026-08-21T2336.js',
  recv: 'recv.2026-08-21T2336.js',
  zstd: 'zstd.2026-08-21T2336.js',
};

await mkdir(target, { recursive: true });
const extracted = await downloadAndExtract();
const files = await readdir(extracted);

for (const name of Object.values(PINNED)) {
  if (!files.includes(name)) {
    throw new Error(
      `Cimbar ${version} archive does not contain ${name}; bump scripts/sync-cimbar-runtime.mjs PINNED and ` +
      'apps/web/src/app/backends/cimbar/runtime.ts to the new official names.',
    );
  }
  await cp(join(extracted, name), join(target, name));
}

// Remove stale runtime files that no longer belong to this build so the app can
// never accidentally load an old/patch-era artifact.
const stale = ['cimbar_js.js', 'cimbar_js.wasm', 'send.js', 'recv.js', 'send-worker.js', 'recv-worker.js', 'zstd.js', 'cimbar-recv-worker.js'];
for (const name of stale) {
  await rm(join(target, name), { force: true });
}

const versionLines = [];
for (const name of Object.values(PINNED)) {
  versionLines.push(`${name} ${await sha256(join(target, name))}`);
}
await writeFile(
  join(target, 'VERSION'),
  `official sz3/libcimbar runtime ${version} (pristine, unmodified)\n` +
    `archive: ${basename(archive)}\n` +
    versionLines.join('\n') + '\n',
  'utf8',
);
console.log(`Cimbar runtime ${version} synced (pristine) to ${target}`);

async function downloadAndExtract() {
  const cacheDir = dirname(archive);
  await mkdir(cacheDir, { recursive: true });
  const url = `https://github.com/sz3/libcimbar/releases/download/${version}/cimbar.wasm.tar.gz`;
  try {
    await stat(archive);
    execFileSync('tar', ['-tzf', basename(archive)], { cwd: cacheDir, stdio: 'ignore' });
  } catch {
    await rm(archive, { force: true });
    await download(url, archive);
  }
  const out = join(cacheDir, `cimbar-${version}`);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  execFileSync('tar', ['-xzf', basename(archive), '-C', basename(out)], {
    cwd: cacheDir,
    stdio: 'ignore',
  });
  return out;
}

async function sha256(path) {
  const { createHash } = await import('node:crypto');
  const { readFile } = await import('node:fs/promises');
  return createHash('sha256').update(await readFile(path)).digest('hex').slice(0, 16);
}

function download(url, destination) {
  return new Promise((resolvePromise, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(response.headers.location, destination).then(resolvePromise, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Cimbar download failed: HTTP ${response.statusCode}`));
        return;
      }
      pipeline(response, createWriteStream(destination)).then(resolvePromise, reject);
    });
    request.on('error', reject);
  });
}
