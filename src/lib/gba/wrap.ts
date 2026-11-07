// Pixel-width word wrap for Gen 3 text boxes.
// Port of Vietrom/vietrom/text/wrap.py. Text uses this app's escapes:
//   \n new line   \l scroll (Vietrom {SCROLL})   \p new text box (Vietrom {PAGE})
// A real line break typed in the editor counts as \n.
import type { CharMap } from "./charmap";
import { NAMED_GLYPHS } from "./charmap";

export type BoxSpec = {
  /** pixels */
  width: number;
  /** visible lines */
  lines: number;
  /** extra lines scroll (\l) instead of overflowing */
  scroll?: boolean;
};

export class WrapError extends Error {}

/** a newline after a line narrower than this share of the box is deliberate */
const SEMANTIC_RATIO = 0.75;
const GLYPH_LIMIT = 0xf7; // bytes below this draw a glyph; the rest are control codes
const SPLIT = /(\\n|\\l|\\p|\n| +|\{[^}]*\})/;
const KEYED = { F7: "DYNAMIC", F8: "KEYPAD_ICON", F9: "EXTRA_SYMBOL" } as const;
const GLYPH_BY_NAME = new Map(Object.entries(NAMED_GLYPHS).map(([b, n]) => [n, Number(b)]));

export type Measure = (s: string) => number;

/** Width of one `{...}` token: names that print text count at their widest value. */
function tagWidth(tag: string, widths: Uint8Array, tagWidths: Record<string, number>): number {
  const name = tag.slice(1, -1);
  if (name in tagWidths) return tagWidths[name];
  const keyed = /^(F7|F8|F9):/i.exec(name);
  if (keyed) return tagWidths[KEYED[keyed[1].toUpperCase() as keyof typeof KEYED]] ?? 0;
  const glyph = GLYPH_BY_NAME.get(name);
  if (glyph !== undefined) return widths[glyph];
  if (/^[0-9A-Fa-f]{2}$/.test(name)) {
    const b = parseInt(name, 16);
    return b < GLYPH_LIMIT ? widths[b] : 0;
  }
  return 0; // control codes draw nothing
}

export function makeMeasure(widths: Uint8Array, cm: CharMap, tagWidths: Record<string, number>): Measure {
  return (text) => {
    let total = 0;
    for (let i = 0; i < text.length; ) {
      if (text[i] === "{") {
        const close = text.indexOf("}", i);
        if (close > 0) {
          total += tagWidth(text.slice(i, close + 1), widths, tagWidths);
          i = close + 1;
          continue;
        }
      }
      const cp = String.fromCodePoint(text.codePointAt(i)!);
      const b = cm.encode.get(cp) ?? cm.encode.get(cp.normalize("NFC"));
      total += b !== undefined ? widths[b] : 0; // unknown characters count 0
      i += cp.length;
    }
    return total;
  };
}

const pages = (text: string) => text.split("\\p");

/** Most lines on any page (newlines and \l both start a line). */
export function lineCount(text: string): number {
  return Math.max(...pages(text).map((p) => (p.match(/\\n|\\l|\n/g)?.length ?? 0) + 1));
}

/** Widest single line in pixels. */
export function widest(text: string, m: Measure): number {
  return Math.max(...text.split(/\\[nlp]|\n/).map(m));
}

type Atom = { space: boolean; text: string };

/** Split a page at hard breaks; soft breaks become spaces. */
function paragraphs(page: string, box: BoxSpec, m: Measure): Atom[][] {
  const paras: Atom[][] = [[]];
  let seg = ""; // text of the line being read
  let word = "";
  const flush = () => {
    if (word) {
      paras[paras.length - 1].push({ space: false, text: word });
      word = "";
    }
  };
  for (const part of page.split(SPLIT)) {
    if (part === "" || part === undefined) continue;
    if (part === "\\n" || part === "\n" || part === "\\l") {
      flush();
      const hard = part !== "\\l" && m(seg.replace(/ +$/, "")) < SEMANTIC_RATIO * box.width;
      const cur = paras[paras.length - 1];
      if (hard) paras.push([]);
      else if (cur.length && !cur[cur.length - 1].space) cur.push({ space: true, text: " " });
      seg = "";
    } else if (part[0] === " ") {
      flush();
      paras[paras.length - 1].push({ space: true, text: part });
      seg += part;
    } else {
      // plain text or a tag: part of the current word
      word += part;
      seg += part;
    }
  }
  flush();
  return paras;
}

function layOut(para: Atom[], limit: number, m: Measure): string[] {
  const lines: string[] = [];
  let cur = "";
  let curW = 0;
  let pending = "";
  let started = false;
  for (const a of para) {
    if (a.space) {
      pending += a.text;
      continue;
    }
    const ww = m(a.text);
    if (ww > limit) throw new WrapError(`Từ rộng hơn ô thoại (${ww} > ${limit} px): ${a.text}`);
    const sw = m(pending);
    if (!started) {
      if (sw + ww > limit) throw new WrapError(`Khoảng trắng đầu + từ đầu rộng hơn ô thoại (${sw + ww} > ${limit} px)`);
      cur = pending + a.text;
      curW = sw + ww;
      started = true;
    } else if (curW + sw + ww <= limit) {
      cur += pending + a.text;
      curW += sw + ww;
    } else {
      lines.push(cur);
      cur = a.text;
      curW = ww;
    }
    pending = "";
  }
  lines.push(cur); // trailing spaces are dropped: they would count against the width
  return lines;
}

/**
 * Re-wrap `text` to `box`. `\p` and short-line newlines are kept; other newlines and `\l`
 * are re-flowed. Scroll boxes join lines 1|2 with `\n` and later lines with `\l`; other
 * boxes allow max(box.lines, minLines) lines per page.
 */
export function wrap(text: string, box: BoxSpec, m: Measure, minLines = 0): string {
  // Spaces are dropped only at break points. The text's own trailing spaces are kept, glued
  // to its last word: the game may append more text to a fragment such as "sharply ".
  const body = text.replace(/ +$/, "");
  const tail = text.slice(body.length);
  const ps = pages(body);
  const out = ps.map((page, n) => {
    const paras = paragraphs(page, box, m);
    if (tail && n === ps.length - 1) {
      const last = paras[paras.length - 1];
      if (last.length && !last[last.length - 1].space) last[last.length - 1].text += tail;
      else last.push({ space: false, text: tail });
    }
    const lines = paras.flatMap((p) => layOut(p, box.width, m));
    if (box.scroll) return lines.map((ln, k) => (k === 0 ? ln : (k === 1 ? "\\n" : "\\l") + ln)).join("");
    const limit = Math.max(box.lines, minLines);
    if (lines.length > limit) throw new WrapError(`Cần ${lines.length} dòng, ô thoại chỉ có ${limit}`);
    return lines.join("\\n");
  });
  return out.join("\\p");
}

/**
 * Wrap the translation of one dialogue entry. The original is proof of the window's size:
 * the box is never narrower than its widest line. Only text printed in the scrolling
 * message box (`scrolls`) may gain `\l`; elsewhere it is a fixed window of
 * max(box.lines, original lines) lines.
 */
export function wrapDialogue(
  original: string,
  translation: string,
  box: BoxSpec,
  m: Measure,
  mOriginal: Measure,
  scrolls: boolean,
): string {
  const lines = lineCount(original);
  const canScroll = !!box.scroll && (original.includes("\\l") || (scrolls && lines < 3));
  // Proof of the window's width. Lines with a {F7:..} value buffer (counts, scores) are measured
  // at the same worst-case tag width the translation gets: those slots hold short numbers, so
  // the original's own layout is the better yardstick (the trainer card line "BATTLES: {F7:00}
  // WINS ..." would otherwise look 70 px wider than its window and nothing could fit).
  const proof = Math.max(
    ...original.split(/\\[nlp]|\n/).map((ln) => (/\{F[789]:/i.test(ln) ? m(ln) : mOriginal(ln))),
  );
  const eff: BoxSpec = {
    width: Math.max(box.width, proof),
    lines: canScroll ? box.lines : Math.max(box.lines, lines),
    scroll: canScroll,
  };
  return wrap(translation, eff, m, lines);
}
