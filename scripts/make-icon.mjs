// Generate the app icon from scratch — a 256×256 PNG and a PNG-in-ICO — so packaging has a real
// asset without any binary tooling. The mark: the Alethic orange field with a white Minto pyramid
// (three stacked tiers), echoing the product's core surface. Run: `node scripts/make-icon.mjs`.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 1024, not 256: electron-builder's mac icon converter refuses anything under 512x512 when
// building the .icns (`Icon must be at least 512x512 pixels`).
const S = 1024;
const SCALE = S / 256;
const BG = [0xd9, 0x62, 0x2b]; // orange (design token T.orange)
const INK = [0xfb, 0xf9, 0xf4]; // paper white

// ── draw RGBA pixels ───────────────────────────────────────────────────────
const px = Buffer.alloc(S * S * 4);
const set = (x, y, [r, g, b], a = 255) => {
  const i = (y * S + x) * 4;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = a;
};

// background
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) set(x, y, BG);

// a three-tier pyramid centred in the icon (coordinates below are for a 256px canvas, scaled up)
const apexY = 54 * SCALE;
const baseY = 202 * SCALE;
const halfBaseAtBottom = 92 * SCALE;
const gap = 10 * SCALE; // horizontal band separating tiers
const tierTops = [apexY, 106 * SCALE, 156 * SCALE];
const tierBottoms = [96 * SCALE, 146 * SCALE, baseY];
const cx = S / 2;
for (let t = 0; t < 3; t++) {
  for (let y = tierTops[t]; y <= tierBottoms[t]; y++) {
    const frac = (y - apexY) / (baseY - apexY); // 0 at apex, 1 at base
    const half = frac * halfBaseAtBottom;
    for (let x = Math.round(cx - half); x <= Math.round(cx + half); x++) {
      if (x >= 0 && x < S && y >= 0 && y < S) set(x, y, INK);
    }
  }
  // re-carve the band gap under each tier by repainting background
  const gy = tierBottoms[t];
  for (let y = gy + 1; y <= gy + gap && y < baseY; y++) {
    const frac = (y - apexY) / (baseY - apexY);
    const half = frac * halfBaseAtBottom;
    for (let x = Math.round(cx - half); x <= Math.round(cx + half); x++) {
      if (x >= 0 && x < S && y >= 0 && y < S) set(x, y, BG);
    }
  }
}

// ── encode PNG ──────────────────────────────────────────────────────────────
const crcTable = (() => {
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
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type RGBA
// filter byte 0 per scanline
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

// ── wrap the PNG into a single-image ICO (modern Windows reads PNG-in-ICO) ───
const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0); // reserved
icoHeader.writeUInt16LE(1, 2); // type: icon
icoHeader.writeUInt16LE(1, 4); // count
const entry = Buffer.alloc(16);
entry[0] = 0; // width 256 encoded as 0
entry[1] = 0; // height 256 encoded as 0
entry[2] = 0; // palette
entry[3] = 0; // reserved
entry.writeUInt16LE(1, 4); // colour planes
entry.writeUInt16LE(32, 6); // bpp
entry.writeUInt32LE(png.length, 8); // image size
entry.writeUInt32LE(6 + 16, 12); // offset
const ico = Buffer.concat([icoHeader, entry, png]);

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'desktop', 'build');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'icon.png'), png);
writeFileSync(join(outDir, 'icon.ico'), ico);
console.log(`Wrote ${join(outDir, 'icon.png')} (${png.length} B) and icon.ico (${ico.length} B)`);
