// Per-game data for Vietnamese font patching. Offsets come from Vietrom's
// profiles/data/firered_us_10.yaml (found with tools/locate_tables.py).
import { buildCharMap, type CharMap } from "./charmap";
import type { FontSpec } from "./font";
import type { BoxSpec } from "./wrap";
import { allocateSlots } from "./vietnamese";

export type ViProfile = {
  key: string;
  gameCode: string;
  /** sha1 of the clean ROM this profile was measured on */
  sha1: string[];
  fonts: FontSpec[];
  /** charmap characters whose slots are reclaimed for Vietnamese glyphs */
  reclaim: string;
  /** bytes the game uses that our charmap does not decode; never hand them out */
  reserved: number[];
  /** dialogue message box */
  box: BoxSpec;
  /** ROM ranges holding script text, printed in the scrolling message box (may gain \\l) */
  scrollRegions: [number, number][];
  /** widest pixel width of names substituted at run time */
  tagWidths: Record<string, number>;
};

export const FIRERED_US_10: ViProfile = {
  key: "firered_us_10",
  gameCode: "BPRE",
  sha1: ["41cb23d8dccc8ebd7c649cd8fbb58eeace6e2fdc"],
  fonts: [
    { name: "normal", glyphs: 0x1f3100, widths: 0x1fb100, layout: "2x2" },
    { name: "font2", glyphs: 0x1ff300, widths: 0x207300, layout: "2x2" },
    { name: "font3", glyphs: 0x20f618, widths: 0x217618, layout: "2x2" },
    { name: "font4", glyphs: 0x21f930, widths: 0x227930, layout: "2x2" },
    { name: "small", glyphs: 0x1eaf00, widths: 0x1eef00, layout: "1x2" },
  ],
  reclaim: "ÇËÎÏŒÛÑßçëîïœûñºª¿¡ÄÖÜäöü",
  // 0x2C/0xA0 superscript er/re, 0x34 LV, 0x53/0x54 PK/MN, 0x55-0x59 POKéBLOCK, 0x84 superscript e
  reserved: [0x2c, 0xa0, 0x34, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x84],
  box: { width: 208, lines: 2, scroll: true },
  // Vietrom text_regions holding script/intro text (the other regions are C rodata: menus)
  scrollRegions: [
    [0x172000, 0x1a8000],
    [0x1ad000, 0x1c7000],
  ],
  // Vietrom firered_us_10.yaml tag_widths (px)
  tagWidths: { PLAYER: 42, RIVAL: 42, STR_VAR_1: 72, STR_VAR_2: 72, STR_VAR_3: 72, DYNAMIC: 72, KEYPAD_ICON: 24, EXTRA_SYMBOL: 12 },
};

export const VI_PROFILES: ViProfile[] = [FIRERED_US_10];

export function viSlots(cm: CharMap, p: ViProfile): Map<string, number> {
  return allocateSlots(cm, p.reclaim, p.reserved);
}

/** Charmap for translated text: original + Vietnamese slots (reclaimed chars dropped). */
export function viTargetCharMap(p: ViProfile, slots: Map<string, number>): CharMap {
  const overrides = new Map<number, string>();
  for (const [ch, b] of slots) overrides.set(b, ch);
  const cm = buildCharMap(overrides);
  // like Vietrom `with_extra(drop=reclaim)`: every reclaimed char leaves the charmap, even
  // those whose slot was not needed, so the translation cannot use a glyph we may have changed
  for (const c of p.reclaim) {
    const b = cm.encode.get(c);
    if (b === undefined) continue;
    cm.encode.delete(c);
    if (cm.decode[b] === c) cm.decode[b] = undefined;
  }
  return cm;
}
