// Game "cover" pulled out of the ROM itself: the front sprite of the game's mascot Pokémon.
// Gen 3 keeps front sprites in a table of { LZ77 data ptr, size 0x800, species } and palettes in a
// table of { LZ77 palette ptr, species }; both are located by shape, so no per-version offsets.
const ROM_BASE = 0x08000000;

export type Thumb = { width: number; height: number; rgba: Uint8ClampedArray };

/** Internal species numbers (national dex + 25 past Celebi) of each family's box legendary. */
const MASCOT: Record<string, number> = {
  BPR: 6, // FireRed: Charizard
  BPG: 3, // LeafGreen: Venusaur
  AXV: 408, // Ruby: Groudon
  AXP: 407, // Sapphire: Kyogre
  BPE: 409, // Emerald: Rayquaza
};

const u16 = (r: Uint8Array, o: number) => r[o] | (r[o + 1] << 8);
const u32 = (r: Uint8Array, o: number) => (r[o] | (r[o + 1] << 8) | (r[o + 2] << 16) | (r[o + 3] << 24)) >>> 0;

/** GBA BIOS LZ77 (type 0x10). Null on malformed data. */
export function lz77(rom: Uint8Array, at: number): Uint8Array | null {
  if (at < 0 || at + 4 > rom.length || rom[at] !== 0x10) return null;
  const size = rom[at + 1] | (rom[at + 2] << 8) | (rom[at + 3] << 16);
  if (!size || size > 0x10000) return null;
  const out = new Uint8Array(size);
  let i = at + 4;
  let o = 0;
  while (o < size) {
    if (i >= rom.length) return null;
    const flags = rom[i++];
    for (let b = 7; b >= 0 && o < size; b--) {
      if (flags & (1 << b)) {
        if (i + 1 >= rom.length) return null;
        const b0 = rom[i++];
        const b1 = rom[i++];
        const len = (b0 >> 4) + 3;
        const from = o - (((b0 & 0xf) << 8) | b1) - 1;
        if (from < 0) return null;
        for (let k = 0; k < len && o < size; k++) out[o++] = out[from + k];
      } else {
        if (i >= rom.length) return null;
        out[o++] = rom[i++];
      }
    }
  }
  return out;
}

const isRomPtr = (p: number, len: number) => p >= ROM_BASE && p < ROM_BASE + len;

/**
 * Find a table of 8-byte entries indexed by species: `ok(offset, species)` says whether the entry at
 * `offset` belongs to that species. Needs a long run so random data does not match.
 */
function findTable(rom: Uint8Array, ok: (o: number, species: number) => boolean, minRun = 400): number {
  for (let o = 0; o + 8 * minRun < rom.length; o += 4) {
    // species 1 comes right after the empty entry 0, so anchor on the run 1..minRun
    if (!ok(o + 8, 1)) continue;
    let n = 1;
    while (n < minRun && ok(o + 8 * (n + 1), n + 1)) n++;
    if (n >= minRun) return o; // start of entry 0
  }
  return -1;
}

/** 4bpp tile-ordered 64×64 sprite + 16-colour BGR555 palette → RGBA (colour 0 transparent). */
function render(tiles: Uint8Array, pal: Uint8Array): Thumb | null {
  if (tiles.length < 0x800 || pal.length < 32) return null;
  const W = 64;
  const rgba = new Uint8ClampedArray(W * W * 4);
  for (let ty = 0; ty < 8; ty++)
    for (let tx = 0; tx < 8; tx++)
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const byte = tiles[(ty * 8 + tx) * 32 + y * 4 + (x >> 1)];
          const idx = x & 1 ? byte >> 4 : byte & 0xf;
          const px = ((ty * 8 + y) * W + tx * 8 + x) * 4;
          if (!idx) continue;
          const c = u16(pal, idx * 2);
          rgba[px] = ((c & 31) * 255) / 31;
          rgba[px + 1] = (((c >> 5) & 31) * 255) / 31;
          rgba[px + 2] = (((c >> 10) & 31) * 255) / 31;
          rgba[px + 3] = 255;
        }
  return { width: W, height: W, rgba };
}

/** Mascot sprite for a Gen 3 Pokémon ROM, or null when the game is unknown / the tables are not found. */
export function extractThumb(rom: Uint8Array, gameCode: string): Thumb | null {
  const species = MASCOT[gameCode.slice(0, 3)];
  if (!species) return null;
  const front = findTable(
    rom,
    (o, s) => isRomPtr(u32(rom, o), rom.length) && u16(rom, o + 4) === 0x800 && u16(rom, o + 6) === s,
  );
  const pal = findTable(
    rom,
    (o, s) => isRomPtr(u32(rom, o), rom.length) && u16(rom, o + 4) === s && u16(rom, o + 6) === 0,
  );
  if (front < 0 || pal < 0) return null;
  const tiles = lz77(rom, u32(rom, front + 8 * species) - ROM_BASE);
  const colours = lz77(rom, u32(rom, pal + 8 * species) - ROM_BASE);
  return tiles && colours ? render(tiles, colours) : null;
}
