const CimQR = require('../cimqr_codec.js');
// render a packet, then probe internals
const packet = new Uint8Array(3000);
for (let i = 0; i < packet.length; i++) packet[i] = (i * 31) & 255;
const { data, width, height } = CimQR.render(packet);
console.log('rendered', width, 'x', height);

// 1) finder detection
const det = CimQR._detect(data, width, height);
console.log('candidates:', det.cands.length);
console.log('selected triple:', det.sel ? `TL(${det.sel.tl.x.toFixed(1)},${det.sel.tl.y.toFixed(1)}) TR(${det.sel.tr.x.toFixed(1)},${det.sel.tr.y.toFixed(1)}) BL(${det.sel.bl.x.toFixed(1)},${det.sel.bl.y.toFixed(1)}) mod=${det.sel.module.toFixed(1)}` : 'NONE');
console.log('expected: TL(28,28) TR(988,28) BL(28,988) module=8');

// 2) decode
const res = CimQR.decode(data, width, height);
console.log('decode packets:', res.length, res[0] ? res[0].length : '');
