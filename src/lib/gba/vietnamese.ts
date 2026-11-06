// Vietnamese character set, its decomposition, and charmap slot allocation.
// Port of Vietrom/vietrom/text/vietnamese.py. Slot allocation must stay
// byte-for-byte identical so ROMs built by either tool agree.
import type { CharMap } from "./charmap";

const CIRC = "̂";
const BREVE = "̆";
const HORN = "̛";
const TONES = ["̀", "́", "̉", "̃", "̣"]; // grave acute hook tilde dot
const MARKS: Record<string, string[]> = {
  a: ["", BREVE, CIRC],
  e: ["", CIRC],
  i: [""],
  o: ["", CIRC, HORN],
  u: ["", HORN],
  y: [""],
};
const NAMES: Record<string, string> = {
  [CIRC]: "circumflex",
  [BREVE]: "breve",
  [HORN]: "horn",
  "̀": "grave",
  "́": "acute",
  "̉": "hook",
  "̃": "tilde",
  "̣": "dot",
};
const TONE_NAMES = new Set(["grave", "acute", "hook", "tilde", "dot"]);

function build(): string {
  const low: string[] = [];
  for (const [base, marks] of Object.entries(MARKS)) {
    for (const m of marks) {
      for (const t of m ? ["", ...TONES] : TONES) low.push((base + m + t).normalize("NFC"));
    }
  }
  low.push("đ");
  return low.join("") + low.join("").toUpperCase();
}

/** All Vietnamese letters with marks (lowercase block, then uppercase), 134 chars. */
export const VIETNAMESE: string = build();

export type Decomposed = { letter: string; mark: string | null; tone: string | null };

/** Base letter (keeps the case of `ch`), vowel mark and tone. */
export function decompose(ch: string): Decomposed {
  if (ch === "đ" || ch === "Đ") return { letter: ch === "đ" ? "d" : "D", mark: "stroke", tone: null };
  const d = ch.normalize("NFD");
  let mark: string | null = null;
  let tone: string | null = null;
  for (const c of [...d].slice(1)) {
    const name = NAMES[c];
    if (TONE_NAMES.has(name)) tone = name;
    else mark = name;
  }
  return { letter: [...d][0], mark, tone };
}

export class SlotError extends Error {
  constructor(
    public readonly needed: number,
    public readonly available: number,
  ) {
    super(`Cần ${needed} ô ký tự cho tiếng Việt, chỉ có ${available}`);
  }
}

/**
 * Bytes for the Vietnamese characters `cm` cannot encode as one byte.
 * Free bytes first, then the bytes of `reclaim` characters (ascending);
 * lowercase before uppercase.
 *
 * `reserved` lists bytes the app's charmap does not decode but the game uses
 * (e.g. 0x84 superscript "e", POKéBLOCK glyphs), so they are never handed out.
 */
export function allocateSlots(cm: CharMap, reclaim: string, reserved: Iterable<number> = []): Map<string, number> {
  const taken = new Set(reserved);
  const missing = [...VIETNAMESE].filter((c) => !cm.encode.has(c));
  // stable sort: lowercase (false) before uppercase (true)
  const lowerFirst = [...missing].sort((a, b) => Number(isUpper(a)) - Number(isUpper(b)));

  const pool: number[] = [];
  for (let b = 0; b < 0xf7; b++) if (cm.decode[b] === undefined && !taken.has(b)) pool.push(b);
  const have = new Set(pool);
  const extra = new Set<number>();
  for (const c of reclaim) {
    const b = cm.encode.get(c);
    if (b !== undefined && b < 0xf7 && !have.has(b)) extra.add(b);
  }
  pool.push(...[...extra].sort((a, b) => a - b));

  if (lowerFirst.length > pool.length) throw new SlotError(lowerFirst.length, pool.length);
  return new Map(lowerFirst.map((c, i) => [c, pool[i]]));
}

const isUpper = (c: string) => c !== c.toLowerCase();
