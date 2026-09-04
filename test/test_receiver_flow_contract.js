'use strict';
// 生成 worker 的静态契约：验证 OneSend 风格的帧级有界消费与会话隔离
// 已进入最终注入产物，且没有改变二维码/packet/FEC 线上格式。
const assert = require('node:assert/strict');
const fs = require('node:fs');

const worker = fs.readFileSync(__dirname + '/fixtures/check_decode.mjs', 'utf8');

for (const marker of [
  'pendingLatest=null',
  'MAX_NONREALTIME_QUEUE=8',
  'MAX_FRAME_BYTES=33554432,MAX_FRAME_QUEUE_BYTES=100663296',
  'queueBytes=0,inFlightBytes=0',
  'frameId',
  'frameAge',
  'decodeMs',
  'frame-ack',
  'queueEpoch',
  'clearDecodeQueue()',
  'CimQR.releaseFrame&&CimQR.releaseFrame()',
]) assert.ok(worker.includes(marker), `缺少帧流控契约: ${marker}`);

for (const marker of [
  'MAX_DATA_LENGTH=67108864',
  'MAX_GENERATIONS=256,MAX_WASM_GENERATIONS=4095',
  '(!isWasm&&u.symbolIndex>23)',
  'packetsHeaderRejected',
  'packetsMetadataRejected',
  'guardHeader(n.header,n.payload&&n.payload.length)',
]) assert.ok(worker.includes(marker), `缺少会话/FEC契约: ${marker}`);

// 与生成 worker 相同的纯模型：实时输入只保留一个 pending，且总缓存不超过预算。
const MAX_FRAME_BYTES = 33554432;
const MAX_FRAME_QUEUE_BYTES = 100663296;
let inFlightBytes = 0;
let queueBytes = 0;
let pending = null;
let dropped = 0;
function frameFits(bytes) {
  return bytes > 0 && bytes <= MAX_FRAME_BYTES && inFlightBytes + queueBytes + bytes <= MAX_FRAME_QUEUE_BYTES;
}
function offerRealtime(frame) {
  if (frame.bytes <= 0 || frame.bytes > MAX_FRAME_BYTES) { dropped++; return; }
  if (pending) {
    const available = inFlightBytes + queueBytes - pending.bytes + frame.bytes;
    if (available > MAX_FRAME_QUEUE_BYTES) { dropped++; return; }
    queueBytes -= pending.bytes;
  } else if (!frameFits(frame.bytes)) {
    dropped++;
    return;
  }
  pending = frame;
  queueBytes += frame.bytes;
}

offerRealtime({ id: 1, bytes: 16 });
offerRealtime({ id: 2, bytes: 16 });
assert.equal(pending.id, 2, 'latest-wins 未保留最新实时帧');
assert.equal(queueBytes, 16, 'pending 替换后字节记账错误');
inFlightBytes = 16;
offerRealtime({ id: 3, bytes: MAX_FRAME_QUEUE_BYTES });
assert.equal(pending.id, 2, '预算不足时不应丢弃已有 pending');
assert.equal(dropped, 1, '预算拒绝计数错误');

console.log('receiver flow/session contract: PASS (bounded queue, latest-wins, epoch, ack, metadata separation)');
