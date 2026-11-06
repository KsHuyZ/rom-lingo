// Gen 3 string codec. Control codes become editable-safe tokens so a
// translator can move them around but they always re-encode byte-exact.
//
//   \n  FE newline        \l  FA scroll line     \p  FB new box
//   {PLAYER} {RIVAL} {STR_VAR_1..3}   FD placeholders
//   {FC:01 02}        FC extended control code + args (hex)
//   {F8:05}           F7/F8/F9 one-arg codes (keypad icon, symbols)
//   {PK} {MN} {LV}    multi-letter glyphs
//   {A3}              any other raw byte

import { NAMED_GLYPHS, type CharMap } from "./charmap";

export const EOS = 0xff;

// pokeemerald text.c: total length of each FC sub-command (incl. sub-code byte)
const FC_LEN = [1, 2, 2, 2, 4, 2, 2, 1, 2, 1, 1, 3, 2, 2, 2, 1, 3, 2, 2, 2, 2, 1, 1, 1, 1];

const FD_NAMES: Record<number, string> = {
  0x01: "PLAYER",
  0x02: "STR_VAR_1",
  0x03: "STR_VAR_2",
  0x04: "STR_VAR_3",
  0x06: "RIVAL",
};
const FD_BY_NAME = new Map(Object.entries(FD_NAMES).map(([b, n]) => [n, Number(b)]));
const GLYPH_BY_NAME = new Map(Object.entries(NAMED_GLYPHS).map(([b, n]) => [n, Number(b)]));

const hex = (b: number) => b.toString(16).toUpperCase().padStart(2, "0");

export type Decoded = {
  text: string;
  /** bytes consumed including the 0xFF terminator */
  length: number;
  /** count of raw `{XX}` bytes — high means probably not text */
  unknown: number;
  letters: number;
  terminated: boolean;
};

export function decodeString(
  rom: Uint8Array,
  start: number,
  cm: CharMap,
  maxLen = 2048,
): Decoded {
  let s = "";
  let off = start;
  let unknown = 0;
  let letters = 0;
  const end = Math.min(rom.length, start + maxLen);
  while (off < end) {
    const b = rom[off++];
    if (b === EOS) return { text: s, length: off - start, unknown, letters, terminated: true };
    if (b === 0xfe) s += "\\n";
    else if (b === 0xfa) s += "\\l";
    else if (b === 0xfb) s += "\\p";
    else if (b === 0xfd) {
      const a = rom[off++];
      s += `{${FD_NAMES[a] ?? "FD:" + hex(a)}}`;
    } else if (b === 0xfc) {
      const sub = rom[off];
      const n = FC_LEN[sub] ?? 1;
      s += `{FC:${Array.from(rom.subarray(off, off + n), hex).join(" ")}}`;
      off += n;
    } else if (b === 0xf7 || b === 0xf8 || b === 0xf9) {
      s += `{${hex(b)}:${hex(rom[off++])}}`;
    } else {
      const c = cm.decode[b];
      if (c !== undefined) {
        s += c;
        if (/\p{L}/u.test(c)) letters++;
      } else if (NAMED_GLYPHS[b]) s += `{${NAMED_GLYPHS[b]}}`;
      else {
        s += `{${hex(b)}}`;
        unknown++;
      }
    }
  }
  return { text: s, length: off - start, unknown, letters, terminated: false };
}

export class EncodeError extends Error {
  constructor(
    message: string,
    public readonly index: number,
  ) {
    super(message);
  }
}

/** Encode display text back to bytes. Result always ends with 0xFF. */
export function encodeString(text: string, cm: CharMap): Uint8Array {
  const out: number[] = [];
  const multi = [...cm.encode.keys()].filter((k) => k.length > 1).sort((a, b) => b.length - a.length);
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      const c = text[i + 1];
      const code = c === "n" ? 0xfe : c === "l" ? 0xfa : c === "p" ? 0xfb : -1;
      if (code < 0) throw new EncodeError(`Escape không hợp lệ "\\${c ?? ""}"`, i);
      out.push(code);
      i += 2;
      continue;
    }
    if (ch === "{") {
      const close = text.indexOf("}", i);
      if (close < 0) throw new EncodeError("Thiếu dấu }", i);
      out.push(...encodeToken(text.slice(i + 1, close), i));
      i = close + 1;
      continue;
    }
    if (ch === "\n") {
      // allow real line breaks in the editor as \n
      out.push(0xfe);
      i++;
      continue;
    }
    const m = multi.find((k) => text.startsWith(k, i));
    if (m) {
      out.push(cm.encode.get(m)!);
      i += m.length;
      continue;
    }
    // iterate by code point, not UTF-16 unit
    const cp = String.fromCodePoint(text.codePointAt(i)!);
    const b = cm.encode.get(cp) ?? cm.encode.get(cp.normalize("NFC"));
    if (b === undefined) throw new EncodeError(`Ký tự "${cp}" không có trong bảng mã`, i);
    out.push(b);
    i += cp.length;
  }
  out.push(EOS);
  return Uint8Array.from(out);
}

function encodeToken(tok: string, at: number): number[] {
  const fd = FD_BY_NAME.get(tok);
  if (fd !== undefined) return [0xfd, fd];
  const g = GLYPH_BY_NAME.get(tok);
  if (g !== undefined) return [g];
  const parseHex = (s: string) => {
    const bytes = s.trim().split(/\s+/).map((h) => parseInt(h, 16));
    if (bytes.some((b) => !(b >= 0 && b <= 0xff))) throw new EncodeError(`Token lỗi {${tok}}`, at);
    return bytes;
  };
  let m: RegExpExecArray | null;
  if ((m = /^FC:(.+)$/.exec(tok))) return [0xfc, ...parseHex(m[1])];
  if ((m = /^FD:([0-9A-Fa-f]{2})$/.exec(tok))) return [0xfd, parseInt(m[1], 16)];
  if ((m = /^(F7|F8|F9):([0-9A-Fa-f]{2})$/.exec(tok))) return [parseInt(m[1], 16), parseInt(m[2], 16)];
  if (/^[0-9A-Fa-f]{2}$/.test(tok)) return [parseInt(tok, 16)];
  throw new EncodeError(`Token không rõ {${tok}}`, at);
}

/** Rough line-overflow check: Gen 3 dialogue box fits ~36 glyphs per line. */
export function longestLine(text: string): number {
  const plain = text.replace(/\{(PLAYER|RIVAL)\}/g, "XXXXXXX").replace(/\{[^}]*\}/g, "");
  return Math.max(0, ...plain.split(/\\[nlp]|\n/).map((l) => [...l].length));
}
