// Turn a labeled contact-sheet render into a drop-in creature skin using
// OpenAI's image edits API (gpt-image-1). For each grid cell: crop it out
// (pure-JS PNG decode/encode — no external tools), ask the model to isolate
// the creature on a *real* transparent background (gpt-image-1 supports native
// alpha output — no chroma-key step needed), then write the frames plus a
// skin.json manifest.
//
// Usage:
//   OPENAI_API_KEY=sk-... node scripts/skin-from-contact-sheet.mjs <sheet.png> [outDir] [options]
//
// Options:
//   --rows N --cols N     grid shape (default 4x4)
//   --quality low|medium|high   gpt-image-1 quality (default medium; ~$0.01/$0.04/$0.17 per frame)
//   --model NAME          default gpt-image-1 (try gpt-image-1-mini if unverified org)
//   --label-px N          label-bar height to trim from each cell bottom (default 12% of cell)
//   --anchor NAME         style-anchor cell (by frame name): sent with every request as a
//                         material/style reference so all frames come out matching
//   --only a,b,c          only (re)generate these frame names; others left untouched
//   --install             also copy the finished skin into the app's userData skins dir
//   --dry-run             slice cells only; skip API calls (inspect crops first)
//
// Cell → frame-name mapping is the NAMES grid below (row-major). Edit it to
// match the sheet you were delivered. Names ending in a letter suffix (talk-1b)
// are extra frames of the same state; states are grouped by prefix before the
// first '-'.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// Row-major frame names for the 4x4 sheet delivered 2026-07-12 (it labeled
// talk-1 and concerned-1 twice; the b-suffixed entries keep both takes).
const NAMES = [
  'idle-1', 'idle-2', 'idle-3', 'talk-1',
  'talk-1b', 'talk-2', 'talk-3', 'curious-1',
  'curious-2', 'concerned-1', 'concerned-1b', 'concerned-2',
  'sleep-1', 'sleep-2', 'greet-1', 'greet-2',
];

const STATE_FPS = { idle: 3, talk: 8, curious: 3, concerned: 3, sleep: 1, greet: 4 };

const PROMPT =
  'Extract the single creature from this image. Completely remove the checkered ' +
  'background, the floor or pedestal, and any text or labels. Output only the ' +
  'creature, centered, on a fully transparent background, filling about 80% of ' +
  'the square canvas. Preserve the creature’s exact design, colors, materials, ' +
  'pose and viewing angle — do not redesign, restyle or add anything.';

const ANCHORED_PROMPT =
  'The first image contains a creature frame to extract; the second image is a ' +
  'material and style reference showing the same creature. Extract the single ' +
  'creature from the FIRST image, keeping its pose and viewing angle exactly. ' +
  'Completely remove the checkered background, the floor or pedestal, and any ' +
  'text or labels. Render the creature with EXACTLY the same surface material, ' +
  'texture detail, color palette, lighting softness and green-glow intensity as ' +
  'the reference image, so that all frames look like the same physical object. ' +
  'Output only the creature, centered, on a fully transparent background, ' +
  'filling about 80% of the square canvas. Do not redesign, restyle or add anything.';

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const key = argv[i].slice(2);
    if (key === 'install' || key === 'dry-run') flags[key] = true;
    else flags[key] = argv[++i];
  } else positional.push(argv[i]);
}
const sheetPath = positional[0];
const outDir = positional[1] ?? 'output/skins/rocky';
const rows = Number(flags.rows ?? 4);
const cols = Number(flags.cols ?? 4);
const quality = flags.quality ?? 'medium';
const model = flags.model ?? 'gpt-image-1';

if (!sheetPath || !fs.existsSync(sheetPath)) {
  console.error('usage: node scripts/skin-from-contact-sheet.mjs <sheet.png> [outDir] [--dry-run] [--install]');
  process.exit(1);
}
if (!flags['dry-run'] && !process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set (or use --dry-run to only slice cells).');
  process.exit(1);
}

// ── minimal PNG codec (8-bit RGB/RGBA, non-interlaced) ──────────────────────
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
function pngChunk(type, data) {
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
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
/** Decode an 8-bit non-interlaced RGB/RGBA PNG to {w, h, data: RGBA}. */
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let w = 0, h = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || data[12] !== 0) {
        throw new Error(`unsupported PNG (bitDepth=${bitDepth} colorType=${colorType} interlace=${data[12]}) — re-export as plain 8-bit RGB/RGBA`);
      }
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(w * h * bpp);
  // undo per-scanline filters (0=None 1=Sub 2=Up 3=Average 4=Paeth)
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = v & 0xff;
    }
  }
  if (bpp === 4) return { w, h, data: px };
  const rgba = Buffer.alloc(w * h * 4, 255);
  for (let i = 0; i < w * h; i++) px.copy(rgba, i * 4, i * 3, i * 3 + 3);
  return { w, h, data: rgba };
}
function cropPNG(img, x0, y0, cw, ch) {
  const out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    img.data.copy(out, y * cw * 4, ((y0 + y) * img.w + x0) * 4, ((y0 + y) * img.w + x0 + cw) * 4);
  }
  return encodePNG(cw, ch, out);
}

// ── slice the sheet into cells ──────────────────────────────────────────────
const sheet = decodePNG(fs.readFileSync(sheetPath));
const cellW = Math.floor(sheet.w / cols);
const cellH = Math.floor(sheet.h / rows);
const labelPx = Number(flags['label-px'] ?? Math.round(cellH * 0.12));
const keepH = cellH - labelPx;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-cells-'));
const cells = [];
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const idx = r * cols + c;
    const name = NAMES[idx];
    if (!name) continue;
    const cellFile = path.join(workDir, `${name}.png`);
    // keep the top of the cell; the label bar sits in the bottom `labelPx`
    fs.writeFileSync(cellFile, cropPNG(sheet, c * cellW, r * cellH, cellW, keepH));
    cells.push({ name, file: cellFile });
  }
}
console.log(`sliced ${cells.length} cells (${cellW}x${keepH} each, ${labelPx}px label trimmed) -> ${workDir}`);
if (flags['dry-run']) {
  console.log('dry run: inspect the cells above, then rerun without --dry-run.');
  process.exit(0);
}

// ── isolate each cell via gpt-image-1 edits (native transparent output) ─────
async function editFrame(cell, anchorFile, attempt = 1) {
  const form = new FormData();
  form.append('model', model);
  form.append('image[]', new Blob([fs.readFileSync(cell.file)], { type: 'image/png' }), `${cell.name}.png`);
  if (anchorFile) {
    form.append('image[]', new Blob([fs.readFileSync(anchorFile)], { type: 'image/png' }), 'style-reference.png');
  }
  form.append('prompt', anchorFile ? ANCHORED_PROMPT : PROMPT);
  form.append('size', '1024x1024');
  form.append('background', 'transparent');
  form.append('output_format', 'png');
  form.append('quality', quality);
  form.append('n', '1');

  let res;
  try {
    res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
  } catch (err) {
    if (attempt >= 5) throw err;
    const wait = attempt * 20;
    console.warn(`  ${cell.name}: network error (${err.cause?.code ?? err.message}), retrying in ${wait}s...`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return editFrame(cell, anchorFile, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const wait = attempt * 15;
      console.warn(`  ${cell.name}: HTTP ${res.status}, retrying in ${wait}s...`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return editFrame(cell, anchorFile, attempt + 1);
    }
    if (res.status === 403 && body.includes('verif')) {
      throw new Error(`gpt-image-1 needs a verified OpenAI organization (platform.openai.com > Settings > Organization). Or retry with --model gpt-image-1-mini.\n${body}`);
    }
    throw new Error(`${cell.name}: HTTP ${res.status} ${body}`);
  }
  const json = await res.json();
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error(`${cell.name}: no image in response`);
  return Buffer.from(b64, 'base64');
}

fs.mkdirSync(outDir, { recursive: true });
const anchorFile = flags.anchor ? cells.find((c) => c.name === flags.anchor)?.file : null;
if (flags.anchor && !anchorFile) {
  console.error(`--anchor ${flags.anchor} does not match any frame name`);
  process.exit(1);
}
const only = flags.only ? new Set(flags.only.split(',')) : null;
for (const cell of cells) {
  if (only && !only.has(cell.name)) continue;
  process.stdout.write(`isolating ${cell.name}${anchorFile ? ' (anchored)' : ''}... `);
  const png = await editFrame(cell, anchorFile);
  fs.writeFileSync(path.join(outDir, `${cell.name}.png`), png);
  console.log(`ok (${Math.round(png.length / 1024)} KB)`);
}

// ── manifest: group frames into states by name prefix ────────────────────────
const states = {};
for (const { name } of cells) {
  const state = name.split('-')[0];
  (states[state] ??= { files: [] }).files.push(`${name}.png`);
  if (STATE_FPS[state]) states[state].fps = STATE_FPS[state];
}
for (const spec of Object.values(states)) spec.files.sort();

const manifest = { displayName: 'Rocky — Official', type: 'frames', fps: 6, states };
fs.writeFileSync(path.join(outDir, 'skin.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${outDir}/skin.json (${Object.keys(states).join(', ')})`);

if (flags.install) {
  const dest = path.join(os.homedir(), 'Library/Application Support/rocky-companion/skins', path.basename(outDir));
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(outDir)) fs.copyFileSync(path.join(outDir, f), path.join(dest, f));
  console.log(`installed -> ${dest} (pick it in Settings after relaunching the app)`);
}
