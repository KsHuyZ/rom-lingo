// Write the Vietnamese glyphs into a ROM. Port of Vietrom font_sheet.apply_font.
import type { CharMap } from "./charmap";
import { writeGlyph, writeWidth, type FontSpec } from "./font";
import { buildGlyphs } from "./font-gen";

/**
 * Generate every font's Vietnamese glyphs from the UNTOUCHED ROM (`original`), then
 * write them all into `target` (a copy). `cm` is the original charmap.
 */
export function applyFont(target: Uint8Array, original: Uint8Array, fonts: FontSpec[], cm: CharMap, slots: Map<string, number>): void {
  const generated = fonts.map((spec) => [spec, buildGlyphs(original, spec, slots, cm)] as const);
  for (const [spec, glyphs] of generated) {
    for (const [byte, [glyph, width]] of glyphs) {
      writeGlyph(target, spec, byte, glyph);
      writeWidth(target, spec, byte, width);
    }
  }
}

/**
 * 256-byte width table for measuring translated text: the normal font's original widths
 * overlaid with the generated Vietnamese widths. `original` must be the unpatched ROM.
 */
export function measureWidths(original: Uint8Array, fonts: FontSpec[], cm: CharMap, slots: Map<string, number>): Uint8Array {
  if (!fonts.length) throw new Error("profile has no fonts to measure with");
  const spec = fonts[0];
  const widths = original.slice(spec.widths, spec.widths + 256);
  for (const [byte, [, w]] of buildGlyphs(original, spec, slots, cm)) widths[byte] = w;
  return widths;
}
