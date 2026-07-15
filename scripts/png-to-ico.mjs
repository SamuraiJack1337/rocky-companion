// Zero-dependency PNG → .ico packer.
//
// Windows (Vista+) reads .ico files whose entries are whole PNGs, so an .ico is
// just a small directory header followed by the raw PNG bytes for each size —
// no BMP re-encoding, no native tools (we have neither ImageMagick nor icotool
// in CI). Used by scripts/generate-icon.mjs and by the one-off that produced the
// committed build/icon.ico.

/**
 * Pack PNG buffers into a single .ico Buffer.
 * @param {Array<{ size: number, png: Buffer }>} images sizes ≤ 256, unique.
 * @returns {Buffer}
 */
export function pngsToIco(images) {
  const entries = [...images].sort((a, b) => a.size - b.size);
  const HEADER = 6;
  const DIR_ENTRY = 16;
  const dirSize = HEADER + DIR_ENTRY * entries.length;

  const header = Buffer.alloc(HEADER);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const dir = [];
  const blobs = [];
  let offset = dirSize;
  for (const { size, png } of entries) {
    const entry = Buffer.alloc(DIR_ENTRY);
    // 256 is stored as 0 in the single width/height bytes.
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // palette count
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8); // bytes in resource
    entry.writeUInt32LE(offset, 12); // offset from file start
    dir.push(entry);
    blobs.push(png);
    offset += png.length;
  }

  return Buffer.concat([header, ...dir, ...blobs]);
}
