// Generates the PWA's PNG icons (a white storage box on teal) with no image dependencies.
// Usage: node scripts/make-icons.mjs
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const TEAL = [15, 118, 110, 255];
const WHITE = [255, 255, 255, 255];
const LID = [204, 251, 241, 255];

function roundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function pixel(x, y, s) {
  // Box sits within the central 60%, so it survives a maskable crop.
  const u = s / 64;
  if (roundedRect(x, y, 27 * u, 33 * u, 37 * u, 37 * u, 2 * u)) return TEAL;
  if (roundedRect(x, y, 16 * u, 20 * u, 48 * u, 28 * u, 3 * u)) return LID;
  if (roundedRect(x, y, 16 * u, 20 * u, 48 * u, 48 * u, 4 * u)) return WHITE;
  return TEAL;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const p = pixel(x + 0.5, y + 0.5, size);
      raw.set(p, y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = new URL('../apps/web/public/', import.meta.url);
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  writeFileSync(new URL(name, out), png(size));
  console.log(`wrote ${name}`);
}
