/**
 * Returns the Serika app/tray icon as a nativeImage.
 * If build/icon.png exists, it is loaded and resized; otherwise a generated purple "S" icon is used.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { nativeImage } = require('electron');

// CRC32 for PNG chunks
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // color type RGBA
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  // Raw image data with filter byte 0 per row
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    raw[pos++] = 0;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      raw[pos++] = rgba[idx];
      raw[pos++] = rgba[idx + 1];
      raw[pos++] = rgba[idx + 2];
      raw[pos++] = rgba[idx + 3];
    }
  }

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Simple 5x7 bitmap for the letter "S"
const S_GLYPH = [
  '01110',
  '10001',
  '10000',
  '01110',
  '00001',
  '10001',
  '01110',
];

function buildIcon(size = 32) {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
  if (fs.existsSync(iconPath)) {
    try {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) {
        return img.resize({ width: size, height: size, quality: 'best' });
      }
    } catch {
      // fall through to generated icon
    }
  }

  const rgba = new Uint8Array(size * size * 4);

  // Purple background (#8b5cf6) with rounded corners
  const r = 139, g = 92, b = 246;
  const radius = Math.floor(size * 0.22);

  function inRounded(x, y) {
    const minX = radius, maxX = size - 1 - radius;
    const minY = radius, maxY = size - 1 - radius;
    let cx = x, cy = y;
    if (x < minX) cx = minX; else if (x > maxX) cx = maxX;
    if (y < minY) cy = minY; else if (y > maxY) cy = maxY;
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      if (inRounded(x, y)) {
        rgba[idx] = r;
        rgba[idx + 1] = g;
        rgba[idx + 2] = b;
        rgba[idx + 3] = 255;
      } else {
        rgba[idx + 3] = 0;
      }
    }
  }

  // Draw white "S" centered
  const glyphW = 5, glyphH = 7;
  const scale = Math.max(1, Math.floor(size / 12));
  const drawW = glyphW * scale;
  const drawH = glyphH * scale;
  const offX = Math.floor((size - drawW) / 2);
  const offY = Math.floor((size - drawH) / 2);

  for (let gy = 0; gy < glyphH; gy++) {
    for (let gx = 0; gx < glyphW; gx++) {
      if (S_GLYPH[gy][gx] !== '1') continue;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const px = offX + gx * scale + sx;
          const py = offY + gy * scale + sy;
          if (px < 0 || py < 0 || px >= size || py >= size) continue;
          const idx = (py * size + px) * 4;
          rgba[idx] = 255;
          rgba[idx + 1] = 255;
          rgba[idx + 2] = 255;
          rgba[idx + 3] = 255;
        }
      }
    }
  }

  return nativeImage.createFromBuffer(encodePNG(size, size, rgba));
}

module.exports = { buildIcon };
