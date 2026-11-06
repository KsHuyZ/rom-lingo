// Read/write Gen 3 font glyphs (2bpp tiles) and width tables.
// Port of Vietrom/vietrom/font.py.

/** 16 rows; 16 columns (2x2 layout) or 8 columns (1x2). Pixels 0..3. */
export type Glyph = number[][];

export type FontSpec = {
  name: string;
  glyphs: number; // ROM offset of glyph tiles
  widths: number; // ROM offset of the width table (1 byte per char code)
  layout: "2x2" | "1x2";
};

const TILE_BYTES = 0x10;
// (tile_x, tile_y) in glyph order
const LAYOUTS = {
  "2x2": [[0, 0], [1, 0], [0, 1], [1, 1]],
  "1x2": [[0, 0], [0, 1]],
} as const;

const glyphOff = (spec: FontSpec, code: number) => spec.glyphs + code * TILE_BYTES * LAYOUTS[spec.layout].length;

export function readGlyph(rom: Uint8Array, spec: FontSpec, code: number): Glyph {
  const cols = spec.layout === "2x2" ? 16 : 8;
  const glyph: Glyph = Array.from({ length: 16 }, () => new Array(cols).fill(0));
  const off = glyphOff(spec, code);
  LAYOUTS[spec.layout].forEach(([tx, ty], i) => {
    for (let row = 0; row < 8; row++) {
      const p = off + i * TILE_BYTES + row * 2;
      const hw = rom[p] | (rom[p + 1] << 8);
      for (let x = 0; x < 8; x++) glyph[ty * 8 + row][tx * 8 + x] = (hw >> (14 - 2 * x)) & 3;
    }
  });
  return glyph;
}

export function writeGlyph(rom: Uint8Array, spec: FontSpec, code: number, glyph: Glyph): void {
  const cols = spec.layout === "2x2" ? 16 : 8;
  if (glyph.length !== 16 || glyph.some((r) => r.length !== cols)) throw new Error(`glyph must be 16 rows x ${cols} columns`);
  if (glyph.some((r) => r.some((p) => p < 0 || p > 3))) throw new Error("pixel values must be 0..3");
  const off = glyphOff(spec, code);
  LAYOUTS[spec.layout].forEach(([tx, ty], i) => {
    for (let row = 0; row < 8; row++) {
      let hw = 0;
      for (let x = 0; x < 8; x++) hw |= glyph[ty * 8 + row][tx * 8 + x] << (14 - 2 * x);
      const p = off + i * TILE_BYTES + row * 2;
      rom[p] = hw & 0xff;
      rom[p + 1] = hw >> 8;
    }
  });
}

export const readWidth = (rom: Uint8Array, spec: FontSpec, code: number) => rom[spec.widths + code];

export function writeWidth(rom: Uint8Array, spec: FontSpec, code: number, w: number): void {
  if (!Number.isInteger(w) || w < 0 || w > 255) throw new Error("width must fit a byte");
  rom[spec.widths + code] = w;
}
