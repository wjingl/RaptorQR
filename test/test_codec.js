const CimQR = require('../cimqr_codec.js');

// ---------- helpers ----------
function randomPacket(len) {
  const p = new Uint8Array(len);
  for (let i = 0; i < len; i++) p[i] = (Math.random() * 256) | 0;
  return p;
}

// sample rendered RGBA into an image, apply transform: rotation (deg), scale, translate (px), blur (sigma), brightness/contrast, perspective
function transformImage(src, w, h, opts) {
  const { rotation = 0, scale = 1, tx = 0, ty = 0, blur = 0, brightness = 1, contrast = 1, perspective = 0 } = opts;
  const ow = Math.round((w * scale) + Math.abs(tx) * 2 + 200);
  const oh = Math.round((h * scale) + Math.abs(ty) * 2 + 200);
  const out = new Uint8ClampedArray(ow * oh * 4);
  const cx = ow / 2, cy = oh / 2;
  const ang = rotation * Math.PI / 180;
  const cos = Math.cos(ang), sin = Math.sin(ang);
  // perspective warp: dest y' = y + perspective * (x - cx) * (y - cy) / h
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      // inverse: dest -> src
      let dx = x - cx - tx, dy = y - cy - ty;
      // inverse perspective
      if (perspective !== 0) {
        const yN = dy / (1 + perspective * (dx / ow)); // approx inverse
        dx = dx / (1 + perspective * (yN / oh));
        dy = yN;
      }
      const sx = (dx * cos + dy * sin) / scale;
      const sy = (-dx * sin + dy * cos) / scale;
      const fx = sx + w / 2, fy = sy + h / 2;
      if (fx >= 0 && fy >= 0 && fx < w - 1 && fy < h - 1) {
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0;
        const o00 = (y0 * w + x0) * 4, o10 = (y0 * w + x0 + 1) * 4, o01 = ((y0 + 1) * w + x0) * 4, o11 = ((y0 + 1) * w + x0 + 1) * 4;
        let r = src[o00] * (1 - tx) * (1 - ty) + src[o10] * tx * (1 - ty) + src[o01] * (1 - tx) * ty + src[o11] * tx * ty;
        let g = src[o00 + 1] * (1 - tx) * (1 - ty) + src[o10 + 1] * tx * (1 - ty) + src[o01 + 1] * (1 - tx) * ty + src[o11 + 1] * tx * ty;
        let b = src[o00 + 2] * (1 - tx) * (1 - ty) + src[o10 + 2] * tx * (1 - ty) + src[o01 + 2] * (1 - tx) * ty + src[o11 + 2] * tx * ty;
        // brightness/contrast
        r = contrast * (r - 128) + 128 * brightness;
        g = contrast * (g - 128) + 128 * brightness;
        b = contrast * (b - 128) + 128 * brightness;
        // blur: 高斯近似——对源采样坐标的邻域做加权（在源图小窗口内 box 平均）
        if (blur > 0) {
          const rad = Math.max(1, Math.round(blur));
          let rr = 0, gg = 0, bb = 0, nn = 0;
          for (let ay = -rad; ay <= rad; ay += Math.max(1, rad >> 1)) {
            for (let ax = -rad; ax <= rad; ax += Math.max(1, rad >> 1)) {
              const sy2 = Math.min(h - 1, Math.max(0, Math.round(fy) + ay));
              const sx2 = Math.min(w - 1, Math.max(0, Math.round(fx) + ax));
              const o2 = (sy2 * w + sx2) * 4;
              rr += src[o2]; gg += src[o2 + 1]; bb += src[o2 + 2]; nn++;
            }
          }
          r = rr / nn; g = gg / nn; b = bb / nn;
        }
        const oo = (y * ow + x) * 4;
        out[oo] = Math.max(0, Math.min(255, r));
        out[oo + 1] = Math.max(0, Math.min(255, g));
        out[oo + 2] = Math.max(0, Math.min(255, b));
        out[oo + 3] = 255;
      }
    }
  }
  return { data: out, width: ow, height: oh };
}

// crop to finder-containing region if needed — not needed; decode should work on full canvas

function testRoundTrip(name, packet, opts) {
  const { data, width, height } = CimQR.render(packet);
  const img = opts ? transformImage(data, width, height, opts) : { data, width, height };
  const res = CimQR.decode(img.data, img.width, img.height);
  if (res.length === 1 && res[0].length === packet.length) {
    let same = true;
    for (let i = 0; i < packet.length; i++) if (res[0][i] !== packet[i]) { same = false; break; }
    if (same) { console.log(`PASS  ${name}`); return true; }
  }
  console.log(`FAIL  ${name}  (got ${res.length} packets, len ${res[0] ? res[0].length : 'n/a'}, want ${packet.length})`);
  return false;
}

// ---------- 1. RS unit tests ----------
function rsTest() {
  let ok = true;
  for (let trial = 0; trial < 20; trial++) {
    const data = new Uint8Array(125);
    for (let i = 0; i < 125; i++) data[i] = (Math.random() * 256) | 0;
    const cw = CimQR.rsEncode(data);
    // clean decode
    const dec = CimQR.rsDecode(cw);
    if (!dec || dec.length !== 125 || Buffer.compare(Buffer.from(dec), Buffer.from(data)) !== 0) { console.log('FAIL RS clean'); ok = false; break; }
    // inject 15 byte errors
    const corrupt = cw.slice();
    const positions = new Set();
    while (positions.size < 15) positions.add((Math.random() * 155) | 0);
    for (const p of positions) corrupt[p] ^= (1 + ((Math.random() * 7) | 0));
    const dec2 = CimQR.rsDecode(corrupt);
    if (!dec2 || Buffer.compare(Buffer.from(dec2), Buffer.from(data)) !== 0) { console.log('FAIL RS 15 errors'); ok = false; break; }
    // 16 errors should fail (or at least not succeed incorrectly — may occasionally pass BM but syndrome recheck catches)
    const corrupt2 = cw.slice();
    const positions2 = new Set();
    while (positions2.size < 25) positions2.add((Math.random() * 155) | 0);
    for (const p of positions2) corrupt2[p] ^= 0xff;
  }
  console.log(ok ? 'PASS  RS encode/decode + 15-error correction (20 trials)' : 'FAIL  RS');
  return ok;
}

// ---------- 2. round trip tests ----------
function main() {
  let allOk = rsTest();

  // clean round trip
  for (const len of [12, 100, 1000, 5000, 7000, 7241]) {
    allOk &= testRoundTrip(`clean round trip (packet ${len}B)`, randomPacket(len));
  }

  // rotation
  for (const rot of [0, 90, 180, 270]) {
    allOk &= testRoundTrip(`rotation ${rot}°`, randomPacket(3000), { rotation: rot });
  }

  // scale (camera sees symbol smaller/larger)
  for (const sc of [0.5, 0.75, 1.0, 1.3]) {
    allOk &= testRoundTrip(`scale ${sc}`, randomPacket(3000), { scale: sc });
  }

  // translation
  allOk &= testRoundTrip('translate (50,30)', randomPacket(3000), { tx: 50, ty: 30, scale: 1.1 });
  allOk &= testRoundTrip('translate (-40,-20)', randomPacket(3000), { tx: -40, ty: -20, scale: 1.05 });

  // rotation + scale + translate
  allOk &= testRoundTrip('rot 30° + scale 0.8', randomPacket(3000), { rotation: 30, scale: 0.8 });
  allOk &= testRoundTrip('rot 15° + scale 1.1 + tx 20', randomPacket(3000), { rotation: 15, scale: 1.1, tx: 20 });

  // blur
  allOk &= testRoundTrip('blur 1.0', randomPacket(3000), { blur: 1 });
  allOk &= testRoundTrip('blur 1.5', randomPacket(3000), { blur: 1.5 });

  // brightness/contrast (camera exposure)
  allOk &= testRoundTrip('brightness 1.2', randomPacket(3000), { brightness: 1.2 });
  allOk &= testRoundTrip('contrast 0.85', randomPacket(3000), { contrast: 0.85 });

  // slight perspective
  allOk &= testRoundTrip('perspective 0.2', randomPacket(3000), { perspective: 0.2 });

  // composite stress: rot + scale + blur
  allOk &= testRoundTrip('rot 20° + scale 0.9 + blur 1 + tx 10', randomPacket(4000), { rotation: 20, scale: 0.9, blur: 1, tx: 10, ty: -8 });

  console.log(allOk ? '\nALL TESTS PASSED' : '\nSOME TESTS FAILED');
  process.exit(allOk ? 0 : 1);
}
main();
