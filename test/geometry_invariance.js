// CimQR 严格 source-quad -> destination-quad 几何不变性测试。
//
// 约定：
//   1. sourceQuad 的点序为 TL, TR, BR, BL，坐标落在渲染帧像素坐标系；
//   2. destinationQuad 使用同一点序，是 sourceQuad 经旋转/非对称透视后的四边形；
//   3. 每个输出像素都走 destination -> source 的单应逆映射，四边形外为白色；
//   4. 不调用 worker，直接调用现有 CimQR.render / CimQR.decode API；
//   5. typical 只要求逐字节通过，boundary 允许正确失败，但禁止错误接受。

'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CODEC_PATH = path.join(ROOT, 'cimqr_codec.js');
const SEED = 0x5eed1234;
const PACKET_LENGTH = 320; // V10/Cim 40 的容量范围内，避免把测试变成吞吐测试。
const SIZE_INDEX = 7;      // Cim 40：finder 仍为 8px，几何测试明显快于默认 112 网格。

function makeRng(seed) {
  let state = seed >>> 0;
  return function randomByte() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  };
}

function makePacket(length, seed) {
  const next = makeRng(seed);
  const packet = new Uint8Array(length);
  for (let i = 0; i < packet.length; i++) packet[i] = next();
  return packet;
}

function sourceQuad(width, height) {
  return [
    [0, 0],
    [width - 1, 0],
    [width - 1, height - 1],
    [0, height - 1],
  ];
}

function rotateQuad(quad, degrees) {
  const angle = degrees * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cx = (quad[0][0] + quad[2][0]) / 2;
  const cy = (quad[0][1] + quad[2][1]) / 2;
  return quad.map(([x, y]) => [
    cos * (x - cx) - sin * (y - cy),
    sin * (x - cx) + cos * (y - cy),
  ]);
}

function quadBounds(quad) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of quad) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

function cross(a, b, p) {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

function isStrictlyConvex(quad) {
  const signs = [];
  for (let i = 0; i < quad.length; i++) {
    const c = cross(quad[i], quad[(i + 1) % quad.length], quad[(i + 2) % quad.length]);
    if (Math.abs(c) < 1e-7) return false;
    signs.push(c > 0);
  }
  return signs.every(s => s === signs[0]);
}

function pointInConvexQuad(point, quad) {
  let positive = false;
  let negative = false;
  for (let i = 0; i < quad.length; i++) {
    const c = cross(quad[i], quad[(i + 1) % quad.length], point);
    if (c > 1e-7) positive = true;
    if (c < -1e-7) negative = true;
    if (positive && negative) return false;
  }
  return true;
}

// Solve H such that destination ~ H(source), with H[8] normalized to 1.
function solveHomography(from, to) {
  const matrix = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }

  // Augmented 8x9 Gaussian elimination with partial pivoting.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) {
      if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row;
    }
    if (Math.abs(matrix[pivot][col]) < 1e-12) throw new Error('singular quadrilateral homography');
    if (pivot !== col) [matrix[pivot], matrix[col]] = [matrix[col], matrix[pivot]];

    const scale = matrix[col][col];
    for (let k = col; k <= 8; k++) matrix[col][k] /= scale;
    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const factor = matrix[row][col];
      if (Math.abs(factor) < 1e-15) continue;
      for (let k = col; k <= 8; k++) matrix[row][k] -= factor * matrix[col][k];
    }
  }

  return matrix.slice(0, 8).map(row => row[8]).concat(1);
}

function invertHomography(h) {
  const a = h[0], b = h[1], c = h[2];
  const d = h[3], e = h[4], f = h[5];
  const g = h[6], k = h[7], l = h[8];
  const A = e * l - f * k;
  const B = c * k - b * l;
  const C = b * f - c * e;
  const D = f * g - d * l;
  const E = a * l - c * g;
  const F = c * d - a * f;
  const G = d * k - e * g;
  const H = b * g - a * k;
  const I = a * e - b * d;
  const det = a * A + b * D + c * G;
  if (Math.abs(det) < 1e-12) throw new Error('singular inverse homography');
  return [A / det, B / det, C / det, D / det, E / det, F / det, G / det, H / det, I / det];
}

function mapHomography(h, x, y) {
  const den = h[6] * x + h[7] * y + h[8];
  if (Math.abs(den) < 1e-12) return null;
  return [
    (h[0] * x + h[1] * y + h[2]) / den,
    (h[3] * x + h[4] * y + h[5]) / den,
  ];
}

function bilinearSample(src, width, height, x, y) {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return null;
  const x0 = Math.min(width - 2, Math.max(0, Math.floor(x)));
  const y0 = Math.min(height - 2, Math.max(0, Math.floor(y)));
  const fx = x - x0;
  const fy = y - y0;
  const out = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const p00 = src[(y0 * width + x0) * 4 + ch];
    const p10 = src[(y0 * width + x0 + 1) * 4 + ch];
    const p01 = src[((y0 + 1) * width + x0) * 4 + ch];
    const p11 = src[((y0 + 1) * width + x0 + 1) * 4 + ch];
    out[ch] = p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy;
  }
  return out;
}

// Build an asymmetric convex destination quad. The percentage is a displacement
// budget relative to the source side, not a symmetric trapezoid reduction.
function makeDestinationQuad(width, height, rotation, perspectivePct) {
  const src = sourceQuad(width, height);
  const rotated = rotateQuad(src, rotation);
  const bounds = quadBounds(rotated);
  const side = Math.min(width, height);
  const displacement = side * perspectivePct / 100;
  const offsets = [
    [0.18 * displacement, 0.08 * displacement],
    [-0.62 * displacement, 0.27 * displacement],
    [-0.04 * displacement, -0.73 * displacement],
    [0.51 * displacement, -0.12 * displacement],
  ];
  const raw = rotated.map(([x, y], i) => [
    x - bounds.minX + offsets[i][0],
    y - bounds.minY + offsets[i][1],
  ]);
  const rawBounds = quadBounds(raw);
  const padding = Math.max(24, Math.ceil(side * 0.16));
  const destination = raw.map(([x, y]) => [
    x - rawBounds.minX + padding,
    y - rawBounds.minY + padding,
  ]);
  if (!isStrictlyConvex(destination)) throw new Error('generated destination quad is not convex');
  const finalBounds = quadBounds(destination);
  return {
    quad: destination,
    width: Math.ceil(finalBounds.maxX + padding + 1),
    height: Math.ceil(finalBounds.maxY + padding + 1),
  };
}

// Inverse-map every destination pixel through the exact inverse of the
// source->destination homography. No affine/parallelogram approximation is used.
function warpSourceQuadToDestination(srcImage, destination) {
  const { data: src, width: sw, height: sh } = srcImage;
  const destQuad = destination.quad;
  const dw = destination.width;
  const dh = destination.height;
  const source = sourceQuad(sw, sh);
  const sourceToDestination = solveHomography(source, destQuad);
  const destinationToSource = invertHomography(sourceToDestination);
  const out = new Uint8ClampedArray(dw * dh * 4);

  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const o = (y * dw + x) * 4;
      out[o] = 255;
      out[o + 1] = 255;
      out[o + 2] = 255;
      out[o + 3] = 255;
      const point = [x + 0.5, y + 0.5];
      if (!pointInConvexQuad(point, destQuad)) continue;
      const sourcePoint = mapHomography(destinationToSource, point[0], point[1]);
      if (!sourcePoint) continue;
      const rgb = bilinearSample(src, sw, sh, sourcePoint[0] - 0.5, sourcePoint[1] - 0.5);
      if (!rgb) continue;
      out[o] = rgb[0];
      out[o + 1] = rgb[1];
      out[o + 2] = rgb[2];
    }
  }
  return { data: out, width: dw, height: dh };
}

function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function loadFreshCodec() {
  // decodeFrame keeps a tracking homography between calls. Fresh-loading the
  // unchanged module makes each scene a one-frame, independent API test.
  delete require.cache[require.resolve(CODEC_PATH)];
  return require(CODEC_PATH);
}

function formatDegrees(degrees) {
  return degrees > 0 ? `+${degrees}` : String(degrees);
}

function buildScenes() {
  const scenes = [];
  const typicalRotations = [0, 5, -5, 10, -10, 15, -15, 20, -20];
  const boundaryRotations = [30, -30, 45, -45, 90, -90];
  for (const rotation of typicalRotations) {
    scenes.push({
      scene: `rotation ${formatDegrees(rotation)}deg`,
      group: 'typical',
      policy: 'must_pass',
      rotation,
      perspectivePct: 0,
    });
  }
  for (const rotation of boundaryRotations) {
    scenes.push({
      scene: `rotation ${formatDegrees(rotation)}deg`,
      group: 'boundary',
      policy: 'must_not_false_accept',
      rotation,
      perspectivePct: 0,
    });
  }

  for (const perspectivePct of [2, 5, 8, 12]) {
    scenes.push({
      scene: `asymmetric convex perspective ${perspectivePct}%`,
      group: perspectivePct === 2 ? 'typical' : 'boundary',
      policy: perspectivePct === 2 ? 'must_pass' : 'must_not_false_accept',
      rotation: 0,
      perspectivePct,
    });
  }

  // Keep the Cartesian product deliberately bounded: these are representative
  // rotation x perspective probes, while all requested individual angles and
  // perspective strengths are covered above.
  const combinations = [
    [5, 2, 'typical'], [-5, 2, 'typical'], [15, 2, 'typical'], [-15, 2, 'typical'],
    [10, 5, 'boundary'], [-10, 5, 'boundary'], [20, 8, 'boundary'], [-20, 8, 'boundary'],
    [30, 12, 'boundary'], [-30, 12, 'boundary'], [45, 8, 'boundary'], [-45, 8, 'boundary'],
    [90, 5, 'boundary'], [-90, 5, 'boundary'],
  ];
  for (const [rotation, perspectivePct, group] of combinations) {
    scenes.push({
      scene: `rotation ${formatDegrees(rotation)}deg x asymmetric convex perspective ${perspectivePct}%`,
      group,
      policy: group === 'typical' ? 'must_pass' : 'must_not_false_accept',
      rotation,
      perspectivePct,
    });
  }
  return scenes;
}

function runScene(base, packet, spec) {
  const destination = makeDestinationQuad(base.width, base.height, spec.rotation, spec.perspectivePct);
  const warped = warpSourceQuadToDestination(base, destination);
  const codec = loadFreshCodec();
  let packets = [];
  let error = null;
  try {
    packets = codec.decode(warped.data, warped.width, warped.height) || [];
  } catch (err) {
    error = String(err && err.stack ? err.stack : err);
  }
  const info = typeof codec.info === 'function' ? codec.info() : {};
  const byteRecovered = packets.length === 1 && equalBytes(packets[0], packet);
  const accepted = packets.length > 0;
  const falseAccept = accepted && !byteRecovered;
  const row = {
    scene: spec.scene,
    group: spec.group,
    policy: spec.policy,
    rotationDeg: spec.rotation,
    perspectivePct: spec.perspectivePct,
    sourceQuad: sourceQuad(base.width, base.height),
    destinationQuad: destination.quad,
    stage: error ? 'exception' : (byteRecovered ? 'single-code-ok' : (info.stage || 'unknown')),
    info,
    accepted,
    byteRecovered,
    falseAccept,
  };
  if (error) row.error = error;
  return row;
}

function main() {
  const packet = makePacket(PACKET_LENGTH, SEED);
  const renderCodec = loadFreshCodec();
  const base = renderCodec.render(packet, 1, SIZE_INDEX);
  const results = buildScenes().map(spec => runScene(base, packet, spec));
  const typical = results.filter(row => row.group === 'typical');
  const boundary = results.filter(row => row.group === 'boundary');
  const typicalFailures = typical.filter(row => !row.byteRecovered);
  const boundaryFalseAccepts = boundary.filter(row => row.falseAccept);
  const output = {
    tool: 'geometry-invariance',
    seed: SEED,
    packetLength: packet.length,
    renderSizeIndex: SIZE_INDEX,
    results,
    summary: {
      total: results.length,
      typical: {
        total: typical.length,
        passed: typical.filter(row => row.byteRecovered).length,
        mustPassFailures: typicalFailures.length,
      },
      boundary: {
        total: boundary.length,
        byteRecovered: boundary.filter(row => row.byteRecovered).length,
        falseAccepts: boundaryFalseAccepts.length,
      },
    },
  };
  process.stdout.write(JSON.stringify(output) + '\n');
  process.exitCode = typicalFailures.length || boundaryFalseAccepts.length ? 2 : 0;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({
      tool: 'geometry-invariance',
      seed: SEED,
      stage: 'test-harness-error',
      info: {},
      byteRecovered: false,
      error: String(err && err.stack ? err.stack : err),
    }) + '\n');
    process.exitCode = 1;
  }
}

module.exports = {
  makePacket,
  solveHomography,
  invertHomography,
  makeDestinationQuad,
  warpSourceQuadToDestination,
  buildScenes,
};
