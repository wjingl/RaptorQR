// 真机拍屏帧导入测试入口。
// 将手机导出的 PNG/JPEG 帧放入 test/fixtures/phone_capture/，并提供 manifest.json：
// {"source":"real-phone-fixture","expectedText":"...","frames":["0001.png",...],"device":"...","camera":"rear","resolution":"1920x1080","distance":"40cm","symbolOccupancy":0.7,"angle":"2deg","lighting":"office","glare":"mild"}
// 本脚本只消费真机帧，不生成或修改帧；缺少 manifest 时明确报告未配置。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(__dirname, 'fixtures', 'phone_capture');
const MANIFEST = path.join(DIR, 'manifest.json');
if (!fs.existsSync(MANIFEST)) {
  console.log(JSON.stringify({ source: 'real-phone-fixture', configured: false, status: 'NO_FIXTURE', hint: '请放入 PNG/JPEG 帧和 manifest.json；合成相机测试不等于真机验收' }));
  process.exit(0);
}
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
if (manifest.source !== 'real-phone-fixture') throw new Error('manifest.source 必须为 real-phone-fixture');
if (!Array.isArray(manifest.frames) || !manifest.frames.length) throw new Error('manifest.frames 不能为空');
const missing = manifest.frames.filter(f => !fs.existsSync(path.join(DIR, f)));
if (missing.length) throw new Error('缺少真机帧: ' + missing.join(', '));
// 解码 PNG/JPEG 交给现有浏览器/worker 测试工具；这里先输出可审计 manifest，
// 实际 decode 由用户在带 Edge/WASM 的环境执行，避免引入第二套图像解码器。
console.log(JSON.stringify({ source: manifest.source, configured: true, device: manifest.device || null, camera: manifest.camera || null, resolution: manifest.resolution || null, distance: manifest.distance || null, symbolOccupancy: manifest.symbolOccupancy || null, angle: manifest.angle || null, lighting: manifest.lighting || null, glare: manifest.glare || null, frames: manifest.frames.length, expectedTextLength: typeof manifest.expectedText === 'string' ? manifest.expectedText.length : null, status: 'READY_FOR_WORKER_E2E' }));
console.log('真机帧已就绪：请使用 test/ui_camera_e2e.js 的 worker/UI 入口接入这些帧；本脚本不会把合成帧标记为真机。');
