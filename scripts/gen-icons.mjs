// Generates the PWA icons as real PNGs (no network, no image dependency).
// Usage: node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'pwa');
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      const i = rowStart + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
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
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CHARCOAL = [18, 18, 20];
const RED = [224, 69, 58];
const AMBER = [245, 179, 66];

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/** Abstract scream sigil: dark plate, red ring, amber pupil. */
function pixel(x, y, size) {
  const c = (size - 1) / 2;
  const d = Math.hypot(x - c, y - c) / size;
  const ring = Math.abs(d - 0.3) < 0.035;
  const pupil = d < 0.11;
  const glow = d > 0.2 && d < 0.42;
  if (ring) return [...RED, 255];
  if (pupil) return [...AMBER, 255];
  if (glow) return [...mix(CHARCOAL, RED, 0.14), 255];
  return [...CHARCOAL, 255];
}

for (const size of [180, 192, 512]) {
  const file = resolve(outDir, `icon-${size}.png`);
  writeFileSync(file, encodePng(size, pixel));
  console.log(`wrote ${file}`);
}
