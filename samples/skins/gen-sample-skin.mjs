// Generates a sample "frames" skin for Rocky Companion: an original placeholder
// blob creature rendered per-mood as transparent PNGs, plus skin.json.
// Pure Node — PNGs are encoded by hand (zlib deflate + hand-rolled CRC32).
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2];
if (!OUT) { console.error('usage: node gen-skin.mjs <out-dir>'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

// ── minimal PNG encoder ─────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── tiny software canvas ────────────────────────────────────────────────────
const SIZE = 512;
function makeCanvas() { return { w: SIZE, h: SIZE, data: Buffer.alloc(SIZE * SIZE * 4) }; }
function blendPx(c, x, y, [r, g, b], a) {
  if (a <= 0 || x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 4;
  const da = c.data[i + 3] / 255;
  const oa = a + da * (1 - a);
  if (oa <= 0) return;
  c.data[i] = Math.round((r * a + c.data[i] * da * (1 - a)) / oa);
  c.data[i + 1] = Math.round((g * a + c.data[i + 1] * da * (1 - a)) / oa);
  c.data[i + 2] = Math.round((b * a + c.data[i + 2] * da * (1 - a)) / oa);
  c.data[i + 3] = Math.round(oa * 255);
}
/** Anti-aliased filled ellipse, optional rotation (radians), alpha 0..1. */
function ellipse(c, cx, cy, rx, ry, color, alpha = 1, rot = 0) {
  const R = Math.max(rx, ry) + 2;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y++) {
    for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++) {
      const dx0 = x - cx, dy0 = y - cy;
      const dx = dx0 * cos + dy0 * sin;
      const dy = -dx0 * sin + dy0 * cos;
      const d = Math.hypot(dx / rx, dy / ry); // 1.0 at the edge
      const aa = Math.min(1, Math.max(0, (1 - d) * Math.min(rx, ry)));
      if (aa > 0) blendPx(c, x, y, color, aa * alpha);
    }
  }
}
/** Anti-aliased capsule (thick line segment). */
function capsule(c, x1, y1, x2, y2, r, color, alpha = 1) {
  const minX = Math.floor(Math.min(x1, x2) - r - 2), maxX = Math.ceil(Math.max(x1, x2) + r + 2);
  const minY = Math.floor(Math.min(y1, y2) - r - 2), maxY = Math.ceil(Math.max(y1, y2) + r + 2);
  const vx = x2 - x1, vy = y2 - y1;
  const len2 = vx * vx + vy * vy || 1;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const t = Math.min(1, Math.max(0, ((x - x1) * vx + (y - y1) * vy) / len2));
      const d = Math.hypot(x - (x1 + vx * t), y - (y1 + vy * t));
      const aa = Math.min(1, Math.max(0, r - d + 0.5));
      if (aa > 0) blendPx(c, x, y, color, aa * alpha);
    }
  }
}
/** Downward/upward arc drawn as short capsule segments. */
function arc(c, cx, cy, rx, ry, a0, a1, r, color) {
  const steps = 14;
  let px = cx + Math.cos(a0) * rx, py = cy + Math.sin(a0) * ry;
  for (let i = 1; i <= steps; i++) {
    const a = a0 + (a1 - a0) * (i / steps);
    const nx = cx + Math.cos(a) * rx, ny = cy + Math.sin(a) * ry;
    capsule(c, px, py, nx, ny, r, color);
    px = nx; py = ny;
  }
}

// ── palette (original placeholder creature — warm amber blob) ───────────────
const BODY = [232, 176, 75];
const BODY_DARK = [201, 143, 53];
const BELLY = [246, 217, 160];
const INK = [59, 47, 27];
const MOUTH_IN = [92, 62, 30];
const WHITE = [255, 255, 255];
const SHADOW = [30, 25, 15];

/**
 * Draw one creature frame.
 * o: bob (px up), squash (0..1), eyes 'open'|'wide'|'blink'|'closed',
 *    brows 'none'|'up'|'worried', mouth 'smile'|'small'|'o-small'|'o-big'|'frown',
 *    wave (0=arms down, 1|2 = raised right arm pose A/B)
 */
function drawCreature(o) {
  const c = makeCanvas();
  const cx = 256;
  const bob = o.bob ?? 0;
  const sq = o.squash ?? 0;
  const cy = 300 - bob + sq * 10;
  const rx = 148 * (1 + sq * 0.06);
  const ry = 132 * (1 - sq * 0.08);

  // ground shadow (fixed — creature bobs above it)
  ellipse(c, cx, 448, 120, 20, SHADOW, 0.18);

  // ear nubs
  ellipse(c, cx - 78, cy - ry + 14, 26, 34, BODY_DARK, 1, -0.35);
  ellipse(c, cx + 78, cy - ry + 14, 26, 34, BODY_DARK, 1, 0.35);

  // arms
  if (o.wave) {
    ellipse(c, cx - rx + 6, cy + 26, 26, 46, BODY_DARK, 1, 0.35); // left down
    const lift = o.wave === 1 ? 0 : 14;
    capsule(c, cx + rx - 24, cy - 20, cx + rx + 34, cy - 96 - lift, 22, BODY_DARK); // right raised
    ellipse(c, cx + rx + 36, cy - 100 - lift, 24, 24, BODY_DARK); // paw
  } else {
    ellipse(c, cx - rx + 6, cy + 26, 26, 46, BODY_DARK, 1, 0.35);
    ellipse(c, cx + rx - 6, cy + 26, 26, 46, BODY_DARK, 1, -0.35);
  }

  // feet
  ellipse(c, cx - 66, cy + ry - 4, 40, 20, BODY_DARK);
  ellipse(c, cx + 66, cy + ry - 4, 40, 20, BODY_DARK);

  // body + belly
  ellipse(c, cx, cy, rx, ry, BODY);
  ellipse(c, cx, cy + 44, 92, 76, BELLY);

  const eyeY = cy - 52;
  const eyeDX = 54;
  // eyes
  if (o.eyes === 'open' || o.eyes === 'wide') {
    const r = o.eyes === 'wide' ? 26 : 20;
    for (const s of [-1, 1]) {
      ellipse(c, cx + s * eyeDX, eyeY, r, r, INK);
      ellipse(c, cx + s * eyeDX - 6, eyeY - 7, r * 0.3, r * 0.3, WHITE);
    }
  } else if (o.eyes === 'blink') {
    for (const s of [-1, 1]) capsule(c, cx + s * eyeDX - 16, eyeY, cx + s * eyeDX + 16, eyeY, 4, INK);
  } else { // closed — restful downward arcs
    for (const s of [-1, 1]) arc(c, cx + s * eyeDX, eyeY - 6, 17, 14, 0.25 * Math.PI, 0.75 * Math.PI, 4, INK);
  }

  // brows
  if (o.brows === 'up') {
    for (const s of [-1, 1]) capsule(c, cx + s * (eyeDX + 14), eyeY - 44, cx + s * (eyeDX - 14), eyeY - 50, 5, INK);
  } else if (o.brows === 'worried') {
    for (const s of [-1, 1]) capsule(c, cx + s * (eyeDX + 16), eyeY - 48, cx + s * (eyeDX - 12), eyeY - 36, 5, INK);
  }

  // mouth
  const mouthY = cy + 8;
  if (o.mouth === 'smile') {
    arc(c, cx, mouthY - 8, 26, 18, 0.2 * Math.PI, 0.8 * Math.PI, 5, INK);
  } else if (o.mouth === 'small') {
    capsule(c, cx - 10, mouthY, cx + 10, mouthY, 4, INK);
  } else if (o.mouth === 'frown') {
    arc(c, cx, mouthY + 16, 24, 14, 1.25 * Math.PI, 1.75 * Math.PI, 5, INK);
  } else if (o.mouth === 'o-small') {
    ellipse(c, cx, mouthY, 13, 15, INK);
    ellipse(c, cx, mouthY, 8, 10, MOUTH_IN);
  } else if (o.mouth === 'o-big') {
    ellipse(c, cx, mouthY + 4, 20, 26, INK);
    ellipse(c, cx, mouthY + 4, 14, 19, MOUTH_IN);
  }

  // sleep: floating z's
  if (o.zzz) {
    const zColor = INK;
    const zs = [ [cx + 120, cy - ry - 8, 12], [cx + 148, cy - ry - 44, 8] ];
    for (const [zx, zy, zr] of zs) {
      capsule(c, zx - zr, zy - zr, zx + zr, zy - zr, 3.5, zColor);
      capsule(c, zx + zr, zy - zr, zx - zr, zy + zr, 3.5, zColor);
      capsule(c, zx - zr, zy + zr, zx + zr, zy + zr, 3.5, zColor);
    }
  }
  return c;
}

// ── frames per state ────────────────────────────────────────────────────────
const base = { eyes: 'open', brows: 'none', mouth: 'smile' };
const FRAMES = {
  'idle-1': { ...base },
  'idle-2': { ...base, bob: 6 },
  'idle-3': { ...base, eyes: 'blink' },
  'talk-1': { ...base, mouth: 'o-small' },
  'talk-2': { ...base, mouth: 'o-big', bob: 3 },
  'talk-3': { ...base, mouth: 'small' },
  'curious-1': { eyes: 'wide', brows: 'up', mouth: 'o-small' },
  'curious-2': { eyes: 'wide', brows: 'up', mouth: 'o-small', bob: 7 },
  'concerned-1': { eyes: 'open', brows: 'worried', mouth: 'frown' },
  'concerned-2': { eyes: 'open', brows: 'worried', mouth: 'frown', squash: 0.5 },
  'sleep-1': { eyes: 'closed', mouth: 'small', squash: 0.6, zzz: true },
  'sleep-2': { eyes: 'closed', mouth: 'small', squash: 1, zzz: true },
  'greet-1': { ...base, wave: 1 },
  'greet-2': { ...base, wave: 2, bob: 4 },
};

for (const [name, opts] of Object.entries(FRAMES)) {
  const c = drawCreature(opts);
  fs.writeFileSync(path.join(OUT, `${name}.png`), encodePNG(c.w, c.h, c.data));
  console.log(`wrote ${name}.png`);
}

const manifest = {
  displayName: 'Sample Creature (placeholder)',
  type: 'frames',
  fps: 6,
  states: {
    idle: { files: ['idle-1.png', 'idle-2.png', 'idle-3.png'], fps: 3 },
    talk: { files: ['talk-1.png', 'talk-2.png', 'talk-3.png'], fps: 8 },
    curious: { files: ['curious-1.png', 'curious-2.png'], fps: 3 },
    concerned: { files: ['concerned-1.png', 'concerned-2.png'], fps: 3 },
    sleep: { files: ['sleep-1.png', 'sleep-2.png'], fps: 1 },
    greet: { files: ['greet-1.png', 'greet-2.png'], fps: 4 },
  },
};
fs.writeFileSync(path.join(OUT, 'skin.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('wrote skin.json');
