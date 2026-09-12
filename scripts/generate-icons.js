/**
 * Generates the PWA icons for Image Likes.
 *
 * Pure Node.js (uses the built-in zlib for PNG compression) — no external
 * dependencies. Run with:  node scripts/generate-icons.js
 *
 * Output (written to public/icons/):
 *   icon-192.png, icon-512.png          — standard icons
 *   icon-maskable-192.png, icon-maskable-512.png — Android maskable (extra safe padding)
 *   apple-touch-icon.png                — iOS home-screen icon (180x180)
 *
 * Design: a white heart on a diagonal gradient (#0095f6 -> #7a5cff), matching
 * the app's avatar gradient.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- Minimal PNG encoder ----------
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * Encode an RGBA image as a PNG.
 * @param {number} width
 * @param {number} height
 * @param {(x:number,y:number)=>[number,number,number,number]} pixelFn
 */
function encodePNG(width, height, pixelFn) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      raw[o++] = r & 0xff;
      raw[o++] = g & 0xff;
      raw[o++] = b & 0xff;
      raw[o++] = a & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- Icon design ----------
const C1 = [0x00, 0x95, 0xf6]; // #0095f6 (top-left)
const C2 = [0x7a, 0x5c, 0xff]; // #7a5cff (bottom-right)

function gradientColor(x, y, size) {
  const t = (x + y) / (2 * size); // 0 (top-left) -> 1 (bottom-right)
  return [
    Math.round(C1[0] + (C2[0] - C1[0]) * t),
    Math.round(C1[1] + (C2[1] - C1[1]) * t),
    Math.round(C1[2] + (C2[2] - C1[2]) * t)
  ];
}

/**
 * True (1) if the normalized point (nx, ny) is inside the classic heart region
 * (x^2 + y^2 - 1)^3 <= x^2 y^3.
 */
function inHeart(nx, ny) {
  const a = nx * nx + ny * ny - 1;
  return a * a * a - nx * nx * ny * ny * ny <= 0;
}

/**
 * Build an icon of the given size.
 * @param {number} size
 * @param {object} opts
 * @param {boolean} opts.maskable  use extra padding so the heart sits in the safe zone
 */
function makeIcon(size, { maskable = false } = {}) {
  const safeFraction = maskable ? 0.35 : 0.25; // fraction of size reserved as padding
  const heartRadius = (size / 2) * (1 - 2 * safeFraction);
  const cx = size / 2;
  const cy = size / 2 + 0.1 * heartRadius; // nudge down so the heart is optically centered
  const SS = 3; // supersampling factor for smooth edges

  return encodePNG(size, size, (x, y) => {
    const [r, g, b] = gradientColor(x, y, size);
    let coverage = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        const nx = (px - cx) / heartRadius;
        const ny = (cy - py) / heartRadius; // flip y (screen y grows downward)
        if (inHeart(nx, ny)) coverage++;
      }
    }
    const t = coverage / (SS * SS);
    return [
      Math.round(255 * t + r * (1 - t)),
      Math.round(255 * t + g * (1 - t)),
      Math.round(255 * t + b * (1 - t)),
      255
    ];
  });
}

// ---------- Write files ----------
const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const files = {
  'icon-192.png': makeIcon(192),
  'icon-512.png': makeIcon(512),
  'icon-maskable-192.png': makeIcon(192, { maskable: true }),
  'icon-maskable-512.png': makeIcon(512, { maskable: true }),
  'apple-touch-icon.png': makeIcon(180)
};

for (const [name, buf] of Object.entries(files)) {
  fs.writeFileSync(path.join(outDir, name), buf);
  console.log(`wrote public/icons/${name} (${buf.length} bytes)`);
}
console.log('Done.');
