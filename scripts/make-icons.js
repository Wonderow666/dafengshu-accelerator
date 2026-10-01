'use strict';

/** 生成应用图标（纯 Node 手写 PNG，避免引入图像库依赖） */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** 画一个圆角方块 + 中间的「枫叶」抽象形状 */
function drawIcon(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const center = size / 2;
  const radius = size * 0.42;
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const offset = rowStart + 1 + x * 4;
      const dx = x - center + 0.5;
      const dy = y - center + 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      if (dist < radius) {
        // 圆内：绿色渐变背景
        const t = (y / size) * 0.7 + 0.3;
        r = Math.round(24 + 20 * (1 - t));
        g = Math.round(120 + 70 * t);
        b = Math.round(70 + 40 * (1 - t));
        a = 255;
        // 中间的白色枫叶近似：菱形 + 竖直叶柄
        const leaf =
          Math.abs(dx) / (size * 0.26) + Math.abs(dy) / (size * 0.22) <= 1 ||
          (Math.abs(dx) < size * 0.035 && dy > 0 && dy < size * 0.3);
        if (leaf) {
          r = 245;
          g = 250;
          b = 245;
        }
      } else if (dist < radius + 1.2) {
        // 边缘抗锯齿
        const alpha = Math.max(0, Math.min(1, radius + 1 - dist));
        r = 30;
        g = 140;
        b = 90;
        a = Math.round(255 * alpha);
      }
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function main() {
  const outDir = path.join(__dirname, '..', 'resources', 'icons');
  fs.mkdirSync(outDir, { recursive: true });
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  for (const size of sizes) {
    const file = path.join(outDir, `icon-${size}.png`);
    fs.writeFileSync(file, drawIcon(size));
  }
  fs.writeFileSync(path.join(outDir, 'icon.png'), drawIcon(256));
  console.log(`已生成图标: ${outDir}`);
}

if (require.main === module) main();

module.exports = { drawIcon };
