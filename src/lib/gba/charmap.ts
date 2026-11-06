// Pokémon Gen 3 (Western: US/EU) character map.
// Source of truth: pret/pokeemerald & pret/pokefirered `charmap.txt`.
// Bytes not listed here are shown as `{XX}` and round-trip unchanged.

export type CharMap = {
  decode: (string | undefined)[]; // byte -> char
  encode: Map<string, number>; // char -> byte
};

const BASE: [number, string][] = [];
const run = (start: number, chars: string) =>
  [...chars].forEach((c, i) => BASE.push([start + i, c]));

run(0x00, " ");
run(0x01, "ÀÁÂÇÈÉÊËÌ");
run(0x0b, "ÎÏÒÓÔŒÙÚÛÑßàá");
run(0x19, "çèéêëì");
run(0x20, "îïòóôœùúûñºª");
run(0x2d, "&+");
run(0x35, "=;");
run(0x51, "¿¡");
run(0x5a, "Í%()");
run(0x68, "â");
run(0x6f, "í");
run(0x79, "↑↓←→");
run(0x85, "<>");
run(0xa1, "0123456789!?.-・…“”‘’♂♀¥,×/");
run(0xbb, "ABCDEFGHIJKLMNOPQRSTUVWXYZ");
run(0xd5, "abcdefghijklmnopqrstuvwxyz");
run(0xef, "▶:ÄÖÜäöü");

/** Multi-char glyphs, written as `{NAME}` tokens. */
export const NAMED_GLYPHS: Record<number, string> = {
  0x34: "LV",
  0x53: "PK",
  0x54: "MN",
  0x55: "PO",
  0x56: "KE",
};

export function buildCharMap(overrides?: Map<number, string>): CharMap {
  const decode: (string | undefined)[] = new Array(256);
  for (const [b, c] of BASE) decode[b] = c;
  if (overrides) for (const [b, c] of overrides) decode[b] = c;

  const encode = new Map<string, number>();
  decode.forEach((c, b) => {
    if (c !== undefined && !encode.has(c)) encode.set(c, b);
  });
  // ASCII apostrophe/quote convenience aliases
  if (!encode.has("'")) encode.set("'", 0xb4);
  if (!encode.has('"')) encode.set('"', 0xb2);
  return { decode, encode };
}

/**
 * Parse a Thingy-style .tbl file (`XX=c`, one per line).
 * Only single-byte entries are supported — that is all Gen 3 uses.
 */
export function parseTbl(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{2})=(.+)$/.exec(raw);
    if (m) out.set(parseInt(m[1], 16), m[2]);
  }
  return out;
}
