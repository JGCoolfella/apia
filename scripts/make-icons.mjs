#!/usr/bin/env node
// Generates the app icons (SVG + PNG) with no image-library dependency.
// PNGs are written by hand: raw RGBA -> zlib -> PNG chunks. Run with
//   npm run build:icons
// Only needs re-running if the icon design changes.

import { writeFile, mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../public');

const BLUE = [11, 111, 184];
const WHITE = [255, 255, 255];

// --- PNG writer -------------------------------------------------------------

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Icon geometry ----------------------------------------------------------

/**
 * A map pin on a blue field. `inset` shrinks the artwork so the maskable
 * variant survives Android's circular safe-zone crop.
 * Anti-aliased by 3x3 supersampling.
 */
function drawIcon(size, { maskable = false } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const S = 3;
  const inset = maskable ? 0.22 : 0.12;
  const r = size * (maskable ? 0 : 0.22); // corner radius; maskable is a full bleed square

  const cx = size / 2;
  const pinTop = size * inset;
  const pinBottom = size * (1 - inset);
  const headR = (pinBottom - pinTop) * 0.30;
  const headY = pinTop + headR;
  const holeR = headR * 0.42;

  const inRounded = (x, y) => {
    if (r === 0) return true;
    const qx = Math.max(r - x, x - (size - r), 0);
    const qy = Math.max(r - y, y - (size - r), 0);
    return qx * qx + qy * qy <= r * r;
  };

  // Pin outline: circular head plus a tapering tail down to the tip.
  const inPin = (x, y) => {
    const dx = x - cx, dy = y - headY;
    if (dx * dx + dy * dy <= headR * headR) return true;
    if (y < headY) return false;
    const t = (y - headY) / (pinBottom - headY);       // 0 at head centre, 1 at tip
    const halfWidth = headR * Math.pow(1 - t, 1.35);
    return y <= pinBottom && Math.abs(dx) <= halfWidth;
  };

  const inHole = (x, y) => {
    const dx = x - cx, dy = y - headY;
    return dx * dx + dy * dy <= holeR * holeR;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0, pinHits = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px_ = x + (sx + 0.5) / S;
          const py_ = y + (sy + 0.5) / S;
          if (!inRounded(px_, py_)) continue;
          bgHits++;
          if (inPin(px_, py_) && !inHole(px_, py_)) pinHits++;
        }
      }
      const total = S * S;
      const alpha = bgHits / total;
      const pinFrac = pinHits / total;
      const i = (y * size + x) * 4;
      if (alpha === 0) continue;
      const mix = pinFrac / Math.max(alpha, 1e-6);
      for (let ch = 0; ch < 3; ch++) {
        px[i + ch] = Math.round(BLUE[ch] * (1 - mix) + WHITE[ch] * mix);
      }
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePNG(size, size, px);
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Apia map">
  <rect width="512" height="512" rx="113" fill="#0b6fb8"/>
  <path fill="#ffffff" d="M256 62c-63.5 0-115 51.5-115 115 0 25.6 8.4 49.3 22.6 68.4L256 450l92.4-204.6C362.6 226.3 371 202.6 371 177c0-63.5-51.5-115-115-115z"/>
  <circle cx="256" cy="175" r="46" fill="#0b6fb8"/>
</svg>
`;

await mkdir(OUT, { recursive: true });
await writeFile(resolve(OUT, 'icon.svg'), SVG);
await writeFile(resolve(OUT, 'icon-192.png'), drawIcon(192));
await writeFile(resolve(OUT, 'icon-512.png'), drawIcon(512));
await writeFile(resolve(OUT, 'icon-maskable-512.png'), drawIcon(512, { maskable: true }));
process.stderr.write('Wrote icon.svg, icon-192.png, icon-512.png, icon-maskable-512.png\n');
