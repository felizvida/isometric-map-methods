// Minimal GeoTIFF reader for single-band float rasters (what an ArcGIS ImageServer sends for exportImage format=tiff).
// Handles classic and BigTIFF, little and big endian, strips or tiles, no compression / LZW / Deflate, predictors 1-3,
// 32- or 64-bit floats (and 8/16/32-bit integers), plus the GeoTIFF placement tags. LERC and JPEG are not supported.
import zlib from 'node:zlib';

const TAG = { W: 256, H: 257, BPS: 258, COMP: 259, STRIP_OFF: 273, SPP: 277, RPS: 278, STRIP_BC: 279, PLANAR: 284, PRED: 317,
  TW: 322, TL: 323, TILE_OFF: 324, TILE_BC: 325, FMT: 339, SCALE: 33550, TIE: 33922, GKEYS: 34735, NODATA: 42113 };

export function readTiff(buf) {
  const le = buf[0] === 0x49 && buf[1] === 0x49;
  if (!le && !(buf[0] === 0x4d && buf[1] === 0x4d)) throw new Error('not a TIFF file');
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const u64 = (o) => Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));
  const magic = u16(2), big = magic === 43;
  if (magic !== 42 && !big) throw new Error('not a TIFF file (magic ' + magic + ')');
  const ifd = big ? u64(8) : u32(4);
  const n = big ? u64(ifd) : u16(ifd), esz = big ? 20 : 12, base = ifd + (big ? 8 : 2);
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };
  const tags = {};
  for (let i = 0; i < n; i++) {
    const e = base + i * esz, tag = u16(e), type = u16(e + 2), count = big ? u64(e + 4) : u32(e + 4);
    const bytes = (SIZE[type] || 1) * count, inline = bytes <= (big ? 8 : 4);
    const at = inline ? e + (big ? 12 : 8) : big ? u64(e + 12) : u32(e + 8);
    const vals = [];
    if (type === 2) { tags[tag] = buf.toString('latin1', at, at + count).replace(/\0+$/, ''); continue; }
    for (let k = 0; k < count; k++) {
      const o = at + k * (SIZE[type] || 1);
      vals.push(type === 3 ? u16(o) : type === 4 || type === 13 ? u32(o) : type === 16 || type === 18 ? u64(o)
        : type === 12 ? (le ? buf.readDoubleLE(o) : buf.readDoubleBE(o)) : type === 11 ? (le ? buf.readFloatLE(o) : buf.readFloatBE(o))
        : type === 5 ? u32(o) / u32(o + 4) : buf[o]);
    }
    tags[tag] = vals;
  }
  const g = (t, d) => (tags[t] ? tags[t][0] : d);
  const W = g(TAG.W), H = g(TAG.H), bps = g(TAG.BPS, 1), comp = g(TAG.COMP, 1), pred = g(TAG.PRED, 1), fmt = g(TAG.FMT, 1);
  if (g(TAG.SPP, 1) !== 1) throw new Error('only single-band images are supported');
  if (![1, 5, 8, 32946].includes(comp)) throw new Error('unsupported TIFF compression ' + comp + (comp === 34887 ? ' (LERC): ask for compression=None' : ''));
  const bpp = bps / 8;
  const tiled = !!tags[TAG.TW];
  const bw = tiled ? g(TAG.TW) : W, bh = tiled ? g(TAG.TL) : g(TAG.RPS, H);
  const offs = tiled ? tags[TAG.TILE_OFF] : tags[TAG.STRIP_OFF], cnts = tiled ? tags[TAG.TILE_BC] : tags[TAG.STRIP_BC];
  const across = tiled ? Math.ceil(W / bw) : 1;
  const out = new Float32Array(W * H);
  const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let k = 0; k < offs.length; k++) {
    let raw = buf.subarray(offs[k], offs[k] + cnts[k]);
    const rows = tiled ? bh : Math.min(bh, H - k * bh), need = bw * rows * bpp;
    if (comp === 5) raw = lzw(raw, need);
    else if (comp === 8 || comp === 32946) raw = zlib.inflateSync(raw);
    raw = Buffer.from(raw.subarray(0, need));
    let blockLE = le;
    if (pred === 2) undoHorizontal(raw, bw, rows, bpp, le);
    else if (pred === 3) { undoFloatPredictor(raw, bw, rows, bpp); blockLE = false; } // the float predictor leaves big-endian samples
    const v = dv(raw);
    const read = fmt === 3 ? (bpp === 4 ? (o) => v.getFloat32(o, blockLE) : (o) => v.getFloat64(o, blockLE))
      : fmt === 2 ? (bpp === 2 ? (o) => v.getInt16(o, blockLE) : bpp === 4 ? (o) => v.getInt32(o, blockLE) : (o) => v.getInt8(o))
      : bpp === 2 ? (o) => v.getUint16(o, blockLE) : bpp === 4 ? (o) => v.getUint32(o, blockLE) : (o) => v.getUint8(o);
    const x0 = tiled ? (k % across) * bw : 0, y0 = tiled ? Math.floor(k / across) * bh : k * bh;
    for (let r = 0; r < rows; r++) {
      const y = y0 + r; if (y >= H) break;
      for (let c = 0; c < bw; c++) { const x = x0 + c; if (x >= W) break; out[y * W + x] = read((r * bw + c) * bpp); }
    }
  }
  // GeoTIFF placement: pixel (i, j) has its corner at x = tie.x + (i - tie.i) * sx, y = tie.y - (j - tie.j) * sy
  const sc = tags[TAG.SCALE], tp = tags[TAG.TIE];
  const geo = sc && tp ? { sx: sc[0], sy: sc[1], i: tp[0], j: tp[1], x: tp[3], y: tp[4] } : null;
  const nodata = typeof tags[TAG.NODATA] === 'string' ? parseFloat(tags[TAG.NODATA]) : null;
  const pixelIsPoint = (() => { const k = tags[TAG.GKEYS]; if (!k) return false; for (let i = 4; i + 3 < k.length; i += 4) if (k[i] === 1025) return k[i + 3] === 2; return false; })();
  return { width: W, height: H, data: out, geo, nodata, pixelIsPoint, compression: comp, predictor: pred, tiled };
}

// TIFF LZW (MSB-first codes, 9-12 bits, early change)
function lzw(src, expected) {
  const out = new Uint8Array(expected); let op = 0;
  const pre = new Int32Array(4096), suf = new Uint8Array(4096), len = new Int32Array(4096), first = new Uint8Array(4096);
  for (let i = 0; i < 256; i++) { pre[i] = -1; suf[i] = i; len[i] = 1; first[i] = i; }
  let next = 258, bits = 9, prev = -1, bitPos = 0;
  const tmp = new Uint8Array(4096);
  const emit = (code) => { let c = code, l = len[code]; for (let i = l - 1; i >= 0; i--) { tmp[i] = suf[c]; c = pre[c]; } for (let i = 0; i < l && op < expected; i++) out[op++] = tmp[i]; };
  while (op < expected) {
    const byte = bitPos >> 3; if (byte >= src.length) break;
    const word = ((src[byte] << 16) | ((src[byte + 1] || 0) << 8) | (src[byte + 2] || 0)) >>> 0;
    const code = (word >>> (24 - (bitPos & 7) - bits)) & ((1 << bits) - 1); bitPos += bits;
    if (code === 257) break;
    if (code === 256) { next = 258; bits = 9; prev = -1; continue; }
    if (prev < 0) { emit(code); prev = code; continue; }
    if (code < next) { emit(code); pre[next] = prev; suf[next] = first[code]; }
    else { pre[next] = prev; suf[next] = first[prev]; } // the KwKwK case: the new code is the one being defined
    len[next] = len[prev] + 1; first[next] = first[prev];
    if (code === next) emit(code);
    next++; prev = code;
    if (next + 1 >= (1 << bits) && bits < 12) bits++;
  }
  return out;
}
function undoHorizontal(b, w, rows, bpp, le) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let r = 0; r < rows; r++) for (let c = 1; c < w; c++) {
    const o = (r * w + c) * bpp, p = o - bpp;
    if (bpp === 1) b[o] = (b[o] + b[p]) & 255;
    else if (bpp === 2) v.setUint16(o, (v.getUint16(o, le) + v.getUint16(p, le)) & 0xffff, le);
    else v.setUint32(o, (v.getUint32(o, le) + v.getUint32(p, le)) >>> 0, le);
  }
}
// floating point predictor (Adobe TIFF Technical Note 3): bytes differenced along the row, stored most significant byte plane first
function undoFloatPredictor(b, w, rows, bpp) {
  const rowB = w * bpp, tmp = new Uint8Array(rowB);
  for (let r = 0; r < rows; r++) {
    const o = r * rowB;
    for (let i = 1; i < rowB; i++) b[o + i] = (b[o + i] + b[o + i - 1]) & 255;
    for (let c = 0; c < w; c++) for (let k = 0; k < bpp; k++) tmp[c * bpp + k] = b[o + k * w + c];
    b.set(tmp, o);
  }
}
