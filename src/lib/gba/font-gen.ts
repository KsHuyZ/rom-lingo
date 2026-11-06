// Generate accented Vietnamese glyphs by drawing diacritics onto the game's base letters.
// Port of Vietrom/vietrom/font_gen.py - keep the two in step; the golden test compares
// every pixel.
//
// Pixel values: 1 ink, 2 shadow, 3 background, 0 outside the cell (never touched).
//
// All geometry comes from the font itself (`geometryFromGlyphs`): letter tops and baseline
// from `a` / `A`, and the grave, acute, circumflex and tilde marks from the game's own
// à á â ... and ñ. Marks the game has no example of (breve, hook, dot, horn, the bar of đ)
// are drawn from small ink stencils and get the font's mark shadow style.
import type { CharMap } from "./charmap";
import { readGlyph, readWidth, type FontSpec, type Glyph } from "./font";
import { decompose } from "./vietnamese";

const INK = 1;
const SHADOW = 2;
const BG = 3;

// Game letters the marks are copied from. The plain vowel (or n for the tilde) is the
// fallback source for letters the game has no accented form of.
const SOURCES: Record<string, string> = { grave: "àèìòù", acute: "áéíóú", circumflex: "âêô", tilde: "ñ" };
const FALLBACK: Record<string, string> = { grave: "a", acute: "a", circumflex: "a", tilde: "n" };

// Shapes the game has no example of. Ink only; shadow is added in the font's own mark style.
const INVENTED: Record<string, string[]> = {
  breve: ["#.#", ".#."], // "v": the mirror of the circumflex
  hook: ["##.", "..#", ".#."], // 3-row "?" top, where there is room
  hook_short: ["##.", ".#."], // 2-row "7", above capitals and in stacks
  dot: ["#"],
  tilde_narrow: [".#.#", "#.#."], // for cells too narrow for the game's tilde (2x2 i)
};

type Px = [y: number, x: number, v: number];

class Mark {
  constructor(
    readonly pixels: Px[],
    readonly center: number, // ink centre of the letter body the mark belongs to
  ) {}
  get top() { return Math.min(...this.pixels.map((p) => p[0])); }
  get bottom() { return Math.max(...this.pixels.map((p) => p[0])); }
  get inkCols(): [number, number] {
    const xs = this.pixels.filter((p) => p[2] === INK).map((p) => p[1]);
    return [Math.min(...xs), Math.max(...xs)];
  }
}

export class FontGeometry {
  constructor(
    readonly upperTop: number,
    readonly lowerTop: number,
    readonly baseline: number,
    readonly dotRow: number,
    readonly shadowDown: boolean,
    private readonly marks: Map<string, Map<string, Mark>>, // "u|l:name" -> {letter -> Mark}; "" = fallback
  ) {}

  mark(upper: boolean, name: string, letter: string): Mark {
    const byLetter = this.marks.get(`${upper ? "u" : "l"}:${name}`)!;
    return byLetter.get(letter.toLowerCase()) ?? byLetter.get("")!;
  }

  invented(name: string): Mark {
    const rows = INVENTED[name];
    const ink = new Set<string>();
    rows.forEach((r, y) => [...r].forEach((c, x) => c === "#" && ink.add(`${y},${x}`)));
    const shadow = new Set<string>();
    for (const k of ink) {
      const [y, x] = k.split(",").map(Number);
      const cand: [number, number][] = [[y, x + 1]];
      if (this.shadowDown) cand.push([y + 1, x]);
      for (const [sy, sx] of cand) if (sy < rows.length && !ink.has(`${sy},${sx}`)) shadow.add(`${sy},${sx}`);
    }
    const toPx = (s: Set<string>, v: number): Px[] => [...s].map((k) => { const [y, x] = k.split(",").map(Number); return [y, x, v]; });
    const pix = [...toPx(ink, INK), ...toPx(shadow, SHADOW)];
    return new Mark(pix, (Math.max(...rows.map((r) => r.length)) - 1) / 2);
  }
}

const inkRows = (g: Glyph) => g.map((_, y) => y).filter((y) => g[y].includes(INK));

function inkCenter(g: Glyph, from: number): number {
  const xs: number[] = [];
  for (let y = from; y < 16; y++) g[y].forEach((p, x) => p === INK && xs.push(x));
  if (!xs.length) throw new Error("no ink in letter body");
  return (Math.min(...xs) + Math.max(...xs)) / 2;
}

/** Measure a font from its glyphs. `get(ch)` returns the glyph of ch, or null. */
export function geometryFromGlyphs(get: (ch: string) => Glyph | null): FontGeometry {
  const a = get("a")!;
  const bigA = get("A")!;
  const lowerTop = inkRows(a)[0];
  const upperTop = inkRows(bigA)[0];
  const baseline = Math.max(...a.map((_, y) => y).filter((y) => a[y].includes(INK) || a[y].includes(SHADOW)));
  const lastCellRow = Math.max(...a.map((_, y) => y).filter((y) => a[y].some((p) => p)));
  // A blank row between baseline and dot when the cell has room for it (like the game's ç);
  // otherwise the row just below the baseline.
  const dotRow = Math.min(baseline + 2, lastCellRow);

  const marks = new Map<string, Map<string, Mark>>();
  let shadowDown = true;
  for (const upper of [false, true]) {
    const top = upper ? upperTop : lowerTop;
    for (const [name, chars] of Object.entries(SOURCES)) {
      const found = new Map<string, Mark>();
      for (const c of chars) {
        const g = get(upper ? c.toUpperCase() : c);
        if (!g) continue;
        const pix: Px[] = [];
        for (let y = 0; y < top; y++) g[y].forEach((p, x) => (p === INK || p === SHADOW) && pix.push([y, x, p]));
        if (!pix.some((p) => p[2] === INK)) continue;
        const m = new Mark(pix, inkCenter(g, top));
        // background right below mark ink, inside the mark: no downward shadow.
        // The tilde is left out: the 2x2 ñ has none while its à á â do.
        if (name !== "tilde" && pix.some(([y, x, v]) => v === INK && y < m.bottom && g[y + 1][x] === BG)) shadowDown = false;
        found.set(decompose(c).letter, m);
      }
      if (!found.has(FALLBACK[name])) throw new Error(`font has no ${name} example (${FALLBACK[name]})`);
      found.set("", found.get(FALLBACK[name])!);
      marks.set(`${upper ? "u" : "l"}:${name}`, found);
    }
  }
  return new FontGeometry(upperTop, lowerTop, baseline, dotRow, shadowDown, marks);
}

export function fontGeometry(rom: Uint8Array, spec: FontSpec, cm: CharMap): FontGeometry {
  return geometryFromGlyphs((ch) => {
    const b = cm.encode.get(ch);
    return b === undefined ? null : readGlyph(rom, spec, b);
  });
}

const cellCols = (g: Glyph) => Math.max(0, ...g.flatMap((row) => row.map((p, x) => (p ? x + 1 : 0))));

/** Move every ink/shadow pixel by dy rows inside the cell. */
function shift(g: Glyph, dy: number): Glyph {
  const out: Glyph = g.map((row) => row.map((p) => (p ? BG : 0)));
  g.forEach((row, y) =>
    row.forEach((p, x) => {
      if (p === INK || p === SHADOW) {
        if (y + dy < 0 || y + dy >= 16 || out[y + dy][x] === 0) throw new Error("letter body does not fit the cell after shifting");
        out[y + dy][x] = p;
      }
    }),
  );
  return out;
}

const sameRow = (a: boolean[], b: boolean[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameVals = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Remove one body row so the letter starts a row lower and keeps its bottom rows.
 * Deletes the first interior row identical to the row below it; failing that, the lower
 * of the first two rows with the same ink. null if no such pair exists.
 */
function squash(g: Glyph, top: number): Glyph | null {
  const last = inkRows(g).at(-1)!;
  const mask = g.map((row) => row.map((p) => p !== 0));

  const drop = (r: number): Glyph | null => {
    for (let y = top; y <= r; y++) if (!sameRow(mask[y], mask[top])) return null;
    const out = g.map((row) => row.slice());
    for (let y = r; y > top; y--) out[y] = g[y - 1].slice();
    out[top] = g[top].map((p) => (p ? BG : 0));
    return out;
  };

  for (let r = top + 1; r < last; r++) {
    if (sameVals(g[r], g[r + 1])) {
      const res = drop(r);
      if (res) return res;
    }
  }
  for (let r = top + 1; r < last; r++) {
    if (sameRow(g[r].map((p) => p === INK), g[r + 1].map((p) => p === INK))) {
      const res = drop(r + 1);
      if (res) return res;
    }
  }
  return null;
}

class Canvas {
  g: Glyph;
  cols: number;
  touched: number[] = [];
  constructor(g: Glyph, readonly geo: FontGeometry) {
    this.g = g.map((r) => r.slice());
    this.cols = cellCols(g);
  }

  set(y: number, x: number, v: number, ok: number[] = [BG]): boolean {
    if (y >= 0 && y < 16 && x >= 0 && x < this.cols && ok.includes(this.g[y][x])) {
      this.g[y][x] = v;
      this.touched.push(x);
      return true;
    }
    return false;
  }

  /** Paint mark `m` with its top row at `top`, centred on `center` like in the game. */
  place(m: Mark, top: number, center: number): void {
    const [x0, x1] = m.inkCols;
    let dx = Math.floor(center - m.center + 0.5);
    dx = Math.max(-x0, Math.min(dx, this.cols - 1 - x1));
    const dy = top - m.top;
    for (const [y, x, v] of m.pixels) if (v === INK) this.set(y + dy, x + dx, INK);
    for (const [y, x, v] of m.pixels) if (v === SHADOW) this.set(y + dy, x + dx, SHADOW);
  }

  inkShadow(pix: [number, number][], rows: [number, number] | null, opts: { overShadow?: boolean; down?: boolean } = {}): void {
    const { overShadow = false, down = true } = opts;
    const ok = overShadow ? [BG, SHADOW] : [BG];
    const done = pix.filter(([y, x]) => this.set(y, x, INK, ok));
    for (const [y, x] of done) {
      const cand: [number, number][] = [[y, x + 1]];
      if (down) cand.push([y + 1, x]);
      for (const [sy, sx] of cand) if (rows === null || (sy >= rows[0] && sy < rows[1])) this.set(sy, sx, SHADOW);
    }
  }
}

/** Horn of ơ ư: a short stroke rising up-right from the letter's top right corner. */
function horn(c: Canvas, top: number): void {
  const s = Math.max(...c.g[top].map((p, x) => (p === INK || p === SHADOW ? x : -1)));
  const options: [number, number][][] = [
    [[top - 1, s], [top - 2, s + 1]], // diagonal
    [[top - 1, s], [top - 2, s]], // no room on the right: upright tick
  ];
  for (const pix of options) {
    if (pix.every(([y, x]) => y >= 0 && x < c.cols && c.g[y][x] === BG)) {
      c.inkShadow(pix, [top - 2, top], { down: c.geo.shadowDown });
      return;
    }
  }
  throw new Error("no room for the horn");
}

function stroke(c: Canvas, upper: boolean): void {
  const g = c.g;
  const rows = inkRows(g);
  let y: number;
  let xs: number[];
  if (upper) {
    // Đ: bar from the left stem, half way down the body
    y = Math.floor((rows[0] + rows.at(-1)!) / 2);
    const stem = g[y].indexOf(INK);
    let nxt = c.cols;
    for (let x = stem + 1; x < c.cols; x++) if (g[y][x] === INK) { nxt = x; break; }
    xs = [stem + 1, stem + 2].filter((x) => x < nxt - 1);
  } else {
    // đ: bar left of the ascender, near its top
    const top = rows[0];
    const stem = Math.max(...g[top].map((p, x) => (p === INK ? x : -1)));
    let stemOnly = 0;
    for (const r of rows) {
      const inks = g[r].map((p, x) => (p === INK ? x : -1)).filter((x) => x >= 0);
      if (!(inks.length === 1 && inks[0] === stem)) break;
      stemOnly++;
    }
    y = stemOnly >= 3 ? top + 1 : top;
    xs = [stem - 2, stem - 1];
  }
  c.inkShadow(xs.map((x) => [y, x]), null, { overShadow: true });
}

/**
 * Glyph and width for Vietnamese letter `ch`, drawn on `base` (the plain letter), using
 * the geometry measured from the same font.
 */
export function compose(base: Glyph, width: number, ch: string, geo: FontGeometry): [Glyph, number] {
  const { letter, mark: vmark, tone } = decompose(ch);
  const upper = ch !== ch.toLowerCase();
  let top = upper ? geo.upperTop : geo.lowerTop;
  const topMark = vmark === "circumflex" || vmark === "breve" ? vmark : null;
  const topTone = tone && ["grave", "acute", "hook", "tilde"].includes(tone) ? tone : null;
  const stacked = !!(topMark && topTone);

  let g = base.map((r) => r.slice());
  if ("iI".includes(letter) && topTone) {
    // the tone replaces the dot of i
    g = g.map((row, y) => row.map((p) => (y < top && (p === INK || p === SHADOW) ? BG : p)));
  }
  const center = inkCenter(g, top);
  const cols = cellCols(g);

  const pick = (name: string): [Mark, boolean] => {
    if (name === "breve" || name === "hook" || name === "hook_short") return [geo.invented(name), false];
    const m = geo.mark(upper, name, letter);
    // Horn capitals cannot raise the tone (no rows above), so keep 2 columns free for it.
    const room = vmark === "horn" && upper ? cols - 2 : cols;
    if (name === "tilde" && m.inkCols[1] - m.inkCols[0] >= room) return [geo.invented("tilde_narrow"), false];
    return [m, true];
  };
  const h = (m: Mark) => m.bottom - m.top + 1;
  // Rows of a lone mark: the game's own rows, or (invented shapes) bottom-aligned with the
  // game's mark of the same kind on this letter.
  const singleY = (m: Mark, fromGame: boolean, ref: Mark) => (fromGame ? m.top : ref.bottom - h(m) + 1);

  const refMark = geo.mark(upper, "circumflex", letter);
  const refTone = geo.mark(upper, "grave", letter);
  const hook = upper || stacked ? "hook_short" : "hook";
  let markM: Mark | undefined, toneM: Mark | undefined;
  let markY = 0, toneY = 0;
  if (topMark) {
    const [m, fromGame] = pick(topMark);
    markM = m;
    markY = singleY(m, fromGame, refMark);
  }
  if (topTone) {
    const [m, fromGame] = pick(topTone === "hook" ? hook : topTone);
    toneM = m;
    toneY = singleY(m, fromGame, refTone);
  }

  if (stacked && upper) {
    // tone in its usual rows, mark right under it, body squashed
    markY = toneY + h(toneM!);
    const n = markY + h(markM!) - top;
    for (let i = 0; i < n; i++) {
      const sq = squash(g, top);
      g = sq ?? shift(g, 1);
      top += 1;
    }
  } else if (stacked) {
    // mark sits directly on the letter, tone right above it
    markY = top - h(markM!);
    toneY = markY - h(toneM!);
  }

  if (tone === "dot") {
    const cx = Math.floor(center + 0.5);
    if (g[geo.dotRow][cx] !== BG) {
      // descender (ỵ): raise the letter one row
      g = shift(g, -1);
      top -= 1;
    }
  }
  const c = new Canvas(g, geo);
  if (markM) c.place(markM, markY, center);
  if (toneM) {
    let toneX = center;
    if (vmark === "horn") {
      // keep the tone clear of the horn: up a row, or left on capitals
      if (upper) toneX -= 1;
      else toneY -= 1;
    }
    c.place(toneM, toneY, toneX);
  }
  if (vmark === "horn") horn(c, top);
  if (vmark === "stroke") stroke(c, upper);
  if (tone === "dot") c.place(geo.invented("dot"), geo.dotRow, center);

  const w = Math.max(width, ...c.touched.map((x) => x + 1));
  if (w > 8) throw new Error(`${JSON.stringify(ch)}: glyph width ${w} exceeds 8`);
  return [c.g, w];
}

/**
 * Generated (glyph, width) for every slot byte, drawn on the game's own base letter.
 * `rom` must still hold the game's original glyphs; `cm` is the ORIGINAL charmap.
 */
export function buildGlyphs(rom: Uint8Array, spec: FontSpec, slots: Map<string, number>, cm: CharMap): Map<number, [Glyph, number]> {
  const geo = fontGeometry(rom, spec, cm);
  const out = new Map<number, [Glyph, number]>();
  for (const [ch, byte] of slots) {
    const code = cm.encode.get(decompose(ch).letter);
    if (code === undefined) throw new Error(`base letter of ${ch} is not in the charmap`);
    out.set(byte, compose(readGlyph(rom, spec, code), readWidth(rom, spec, code), ch, geo));
  }
  return out;
}
