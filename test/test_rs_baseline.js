const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const CimQR = require('../cimqr_codec.js');

function same(a, b) { return a && a.length === b.length && a.every((v, i) => v === b[i]); }
function makeData(seed) { const d = new Uint8Array(125); for (let i = 0; i < d.length; i++) d[i] = (seed * 29 + i * 73 + i * i) & 255; return d; }
function positions(seed, count) { const out = [], used = new Set(); for (let k = 0; out.length < count && k < 155 * 2; k++) { const p = (seed * 17 + k * 37 + k * k) % 155; if (!used.has(p)) { used.add(p); out.push(p); } } if (out.length !== count) throw new Error('position generator failed'); return out; }

let clean = 0, corrected = 0, rejected = 0, rsMs = 0;
for (let t = 0; t < 40; t++) {
  const data = makeData(t + 1), cw = CimQR.rsEncode(data);
  let t0 = performance.now();
  assert(same(CimQR.rsDecode(cw), data));
  rsMs += performance.now() - t0; clean++;
  for (const count of [1, 4, 8, 12, 15]) {
    const corrupt = cw.slice();
    for (const p of positions(t * 7 + count, count)) corrupt[p] ^= (0x31 + p + t) & 255;
    assert(same(CimQR.rsDecode(corrupt), data));
    corrected++;
  }
  const tooMany = cw.slice();
  for (const p of positions(t + 101, 16)) tooMany[p] ^= 0xA7;
  assert.equal(CimQR.rsDecode(tooMany), null);
  rejected++;
}
console.log(JSON.stringify({ clean, corrected, rejected, rsMs: +rsMs.toFixed(2), status: 'errors-only production RS verified', erasures: 'not enabled: experimental implementation rejected by baseline' }, null, 2));
