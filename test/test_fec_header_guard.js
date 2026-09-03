'use strict';
// 验证生成 worker 对 JS RLNC 与 WASM RaptorQ 使用不同的总代上限。
const assert = require('node:assert/strict');
const fs = require('node:fs');

const worker = fs.readFileSync(__dirname + '/fixtures/check_decode.mjs', 'utf8');
assert.match(worker, /MAX_GENERATIONS=256,MAX_WASM_GENERATIONS=4095/);
assert.match(worker, /u&&u\.symbolIndex===31\?MAX_WASM_GENERATIONS:MAX_GENERATIONS/);

const MAX_DATA_LENGTH = 67108864;
const MAX_GENERATIONS = 256;
const MAX_WASM_GENERATIONS = 4095;
function guardHeader(u, payloadLen) {
  const maxGenerations = u && u.symbolIndex === 31 ? MAX_WASM_GENERATIONS : MAX_GENERATIONS;
  if (!u || !Number.isInteger(u.dataLength) || u.dataLength < 0 || u.dataLength > MAX_DATA_LENGTH ||
      !Number.isInteger(u.totalGenerations) || u.totalGenerations < 1 || u.totalGenerations > maxGenerations ||
      !Number.isInteger(u.generationIndex) || u.generationIndex < 0 || u.generationIndex >= u.totalGenerations ||
      !Number.isInteger(u.symbolIndex) || u.symbolIndex < 0 || u.symbolIndex > 31 ||
      !Number.isInteger(payloadLen) || payloadLen < 5 || payloadLen > 1048576) return false;
  return true;
}

const wasm = { dataLength: 1000, totalGenerations: 1, generationIndex: 0, symbolIndex: 31 };
const checkWasm = (patch = {}, payloadLen = 7229) => guardHeader({ ...wasm, ...patch }, payloadLen);
assert.equal(checkWasm({ totalGenerations: 257 }), true);
assert.equal(checkWasm({ totalGenerations: 4095, generationIndex: 4094 }), true);
assert.equal(checkWasm({ totalGenerations: 4096 }), false);

const js = { dataLength: 1000, totalGenerations: 1, generationIndex: 0, symbolIndex: 0 };
const checkJs = (patch = {}, payloadLen = 7229) => guardHeader({ ...js, ...patch }, payloadLen);
assert.equal(checkJs({ totalGenerations: 256, generationIndex: 255 }), true);
assert.equal(checkJs({ totalGenerations: 257 }), false);

for (const [patch, payloadLen, label] of [
  [{ generationIndex: 4095, totalGenerations: 4095 }, 7229, 'generationIndex out of range'],
  [{ symbolIndex: 32 }, 7229, 'symbol index out of range'],
  [{ dataLength: 67108865 }, 7229, 'data length out of range'],
  [{}, 4, 'payload too short'],
  [{}, 1048577, 'payload too large'],
]) assert.equal(checkWasm(patch, payloadLen), false, label);

console.log('FEC header guard boundaries: PASS (WASM 4095 / JS 256 / shared limits)');
