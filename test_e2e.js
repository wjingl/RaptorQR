// 端到端彩色回路：构造真实 RaptorQ 包裹包（8B 头 + 负载 + CRC32C）→ 渲染 → 解码 → 校验
const CimQR = require('./cimqr_codec.js');

// CRC32C（来自 encode worker 的 cn，多项式 0x82F63B78）
const crcTable = new Uint32Array(256);
(function () {
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    crcTable[n] = c >>> 0;
  }
})();
function crc32c(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// 打包：header(8) + payload + crc(4)
function wrapPacket(genIdx, totalGen, symIdx, isText, isLast, compressed, dataLength, payload) {
  const flags = (genIdx & 4095) | ((totalGen & 4095) << 12) | ((symIdx & 31) << 24) | (isText ? 1 << 29 : 0) | (isLast ? 1 << 30 : 0) | (compressed ? 1 << 31 : 0);
  const hdr = new Uint8Array(8);
  hdr[0] = 0x51;
  hdr[1] = flags & 255; hdr[2] = (flags >>> 8) & 255; hdr[3] = (flags >>> 16) & 255; hdr[4] = (flags >>> 24) & 255;
  hdr[5] = dataLength & 255; hdr[6] = (dataLength >>> 8) & 255; hdr[7] = (dataLength >>> 16) & 255;
  const body = new Uint8Array(8 + payload.length);
  body.set(hdr, 0); body.set(payload, 8);
  const crc = crc32c(body);
  const pkt = new Uint8Array(8 + payload.length + 4);
  pkt.set(body, 0);
  pkt[8 + payload.length] = crc & 255; pkt[8 + payload.length + 1] = (crc >>> 8) & 255; pkt[8 + payload.length + 2] = (crc >>> 16) & 255; pkt[8 + payload.length + 3] = (crc >>> 24) & 255;
  return pkt;
}
// 解析（复制 decode worker 的 Di 逻辑：头 + CRC 校验）
function parsePacket(bytes) {
  if (bytes.length < 12) throw new Error('too short');
  const flags = bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24);
  const dataLength = bytes[5] | (bytes[6] << 8) | (bytes[7] << 16);
  const payload = bytes.slice(8, bytes.length - 4);
  const storedCrc = bytes[bytes.length - 4] | (bytes[bytes.length - 3] << 8) | (bytes[bytes.length - 2] << 16) | (bytes[bytes.length - 1] << 24);
  const calc = crc32c(bytes.slice(0, bytes.length - 4));
  if (storedCrc !== calc) throw new Error('CRC mismatch: ' + storedCrc.toString(16) + ' vs ' + calc.toString(16));
  return {
    generationIndex: flags & 4095,
    totalGenerations: (flags >>> 12) & 4095,
    symbolIndex: (flags >>> 24) & 31,
    isText: !!((flags >>> 29) & 1),
    isLastGeneration: !!((flags >>> 30) & 1),
    compressed: !!((flags >>> 31) & 1),
    dataLength,
    payload,
  };
}

// 测试多种负载长度
const payloads = [
  { len: 201, name: '201B (V20-L)' },
  { len: 7229, name: '7229B (color max)' },
  { len: 100, name: '100B' },
  { len: 3000, name: '3000B' },
  { len: 7000, name: '7000B' },
];
let allOk = true;
for (const { len, name } of payloads) {
  const payload = new Uint8Array(len);
  for (let i = 0; i < len; i++) payload[i] = (i * 131 + 7) & 255;
  const pkt = wrapPacket(0, 1, 0, false, true, false, 12345, payload);
  if (pkt.length > 7241) { console.log('SKIP', name, '-> packet', pkt.length, '> 7241 (exceeds color symbol)'); continue; }
  const { data, width, height } = CimQR.render(pkt);
  const recovered = CimQR.decode(data, width, height);
  let ok = false;
  if (recovered.length === 1 && recovered[0].length === pkt.length) {
    ok = recovered[0].every((v, i) => v === pkt[i]);
  }
  // 解析校验（CRC）
  let parseOk = false;
  try { parsePacket(recovered[0]); parseOk = true; } catch (e) {}
  console.log(name, '-> packet', pkt.length, 'B:', ok ? 'ROUND-TRIP OK' : 'FAIL', parseOk ? '| CRC OK' : '| CRC FAIL');
  if (!ok || !parseOk) allOk = false;
}
console.log(allOk ? '\nALL END-TO-END PASSED' : '\nSOME FAILED');
process.exit(allOk ? 0 : 1);
