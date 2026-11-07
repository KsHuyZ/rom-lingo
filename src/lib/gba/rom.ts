// ROM-level operations: header, string discovery, rebuilding with repointing.
import type { CharMap } from "./charmap";
import { decodeString, encodeString, EncodeError, EOS } from "./text";

export const ROM_BASE = 0x08000000;
export const MAX_ROM = 32 * 1024 * 1024;

export type RomHeader = {
  title: string;
  code: string;
  maker: string;
  version: number;
  size: number;
  crc32: number;
};

export type EntryKind = "dialogue" | "species" | "move" | "ability" | "item";

export type Entry = {
  id: string;
  kind: EntryKind;
  index?: number; // table index for fixed entries
  offset: number;
  /** bytes available in place, incl. terminator */
  capacity: number;
  /** ROM offsets of pointers that reference this string */
  refs: number[];
  /** fixed-size table slot: cannot be repointed */
  fixed: boolean;
  /** other pointers land inside this string: never overwrite in place */
  shared: boolean;
  text: string;
};

// ---------------------------------------------------------------- header

export function readHeader(rom: Uint8Array): RomHeader {
  if (rom.length < 0xc0 || rom[0xb2] !== 0x96) throw new Error("Không phải ROM GBA hợp lệ");
  const ascii = (a: number, b: number) =>
    String.fromCharCode(...rom.subarray(a, b)).replace(/\0+$/, "");
  return {
    title: ascii(0xa0, 0xac),
    code: ascii(0xac, 0xb0),
    maker: ascii(0xb0, 0xb2),
    version: rom[0xbc],
    size: rom.length,
    crc32: crc32(rom),
  };
}

// ---------------------------------------------------------------- tables

type TableSpec = {
  kind: Exclude<EntryKind, "dialogue">;
  stride: number;
  nameLen: number;
  /** names of entries #1 and #2, used to auto-locate the table */
  probe: [string, string];
  count: number | "itemId";
};

// Offsets differ per game/revision, so we locate tables by content instead
// of hardcoding addresses. Works for Ruby/Sapphire/Emerald/FireRed/LeafGreen.
const TABLES: TableSpec[] = [
  { kind: "species", stride: 11, nameLen: 11, probe: ["BULBASAUR", "IVYSAUR"], count: 412 },
  { kind: "move", stride: 13, nameLen: 13, probe: ["POUND", "KARATE CHOP"], count: 355 },
  { kind: "ability", stride: 13, nameLen: 13, probe: ["STENCH", "DRIZZLE"], count: 78 },
  { kind: "item", stride: 44, nameLen: 14, probe: ["MASTER BALL", "ULTRA BALL"], count: "itemId" },
];

function findAll(rom: Uint8Array, pat: Uint8Array): number[] {
  const hits: number[] = [];
  let i = rom.indexOf(pat[0]);
  while (i >= 0 && i + pat.length <= rom.length) {
    let k = 1;
    while (k < pat.length && rom[i + k] === pat[k]) k++;
    if (k === pat.length) hits.push(i);
    i = rom.indexOf(pat[0], i + 1);
  }
  return hits;
}

function locateTable(rom: Uint8Array, cm: CharMap, t: TableSpec): number | null {
  const first = encodeString(t.probe[0], cm);
  for (const hit of findAll(rom, first)) {
    const start = hit - t.stride; // entry #1 sits one stride after #0
    if (start < 0) continue;
    const second = decodeString(rom, start + t.stride * 2, cm, t.nameLen);
    if (second.terminated && second.text === t.probe[1]) return start;
  }
  return null;
}

export function scanTables(rom: Uint8Array, cm: CharMap): { entries: Entry[]; ranges: [number, number][] } {
  const entries: Entry[] = [];
  const ranges: [number, number][] = [];
  const dv = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  for (const t of TABLES) {
    const start = locateTable(rom, cm, t);
    if (start === null) continue;
    const tableStart = entries.length;
    let lastReal = -1; // last item whose itemId field equals its index
    let i = 0;
    for (; ; i++) {
      const off = start + i * t.stride;
      if (off + t.stride > rom.length) break;
      const d = decodeString(rom, off, cm, t.nameLen);
      // A name may fill the whole slot with no 0xFF, e.g. "POKéBLOCK CASE" (14/14).
      const valid = d.unknown === 0 && (d.terminated || d.length === t.nameLen);
      if (t.count === "itemId") {
        // ItemData: name[14], u16 itemId, ... Unused slots (e.g. FireRed #52-62)
        // carry itemId = 0 (ITEM_NONE), so accept 0 as well as the index.
        const id = dv.getUint16(off + 14, true);
        if ((id !== i && id !== 0) || !valid || i > 1000) break;
        if (id === i) lastReal = i;
      } else if (i >= t.count) break;
      // placeholder slots the game never shows ("????????", "?")
      if (/^\?*$/.test(d.text)) {
        entries.push(null as unknown as Entry); // keep index alignment, removed below
        continue;
      }
      entries.push({
        id: `${t.kind}:${i}`,
        kind: t.kind,
        index: i,
        offset: off,
        capacity: t.nameLen,
        refs: [],
        fixed: true,
        shared: false,
        text: d.text,
      });
    }
    if (t.count === "itemId") {
      // drop trailing itemId=0 slots: they are past the end of the real table
      i = lastReal + 1;
      entries.length = tableStart + i;
    }
    ranges.push([start, start + i * t.stride]);
  }
  return { entries: entries.filter(Boolean), ranges };
}

// ---------------------------------------------------------------- dialogue

/** Every aligned word that looks like a ROM pointer, grouped by target. */
export function scanPointers(rom: Uint8Array): Map<number, number[]> {
  const dv = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  const map = new Map<number, number[]>();
  const limit = ROM_BASE + rom.length;
  for (let i = 0; i + 4 <= rom.length; i += 4) {
    const v = dv.getUint32(i, true);
    if (v >= ROM_BASE && v < limit) {
      const t = v - ROM_BASE;
      const list = map.get(t);
      if (list) list.push(i);
      else map.set(t, [i]);
    }
  }
  return map;
}

// Byte classes for the fast pre-filter (no string building).
const C_BAD = 0, C_CHAR = 1, C_LETTER = 2, C_CTRL = 3, C_ARG1 = 4, C_FC = 5, C_EOS = 6;

function byteClasses(cm: CharMap): Uint8Array {
  const cls = new Uint8Array(256);
  for (let b = 0; b < 256; b++) {
    const c = cm.decode[b];
    if (c !== undefined) cls[b] = /\p{L}/u.test(c) ? C_LETTER : C_CHAR;
  }
  for (const b of [0x34, 0x53, 0x54, 0x55, 0x56]) cls[b] = C_CHAR;
  cls[0xfa] = cls[0xfb] = cls[0xfe] = C_CTRL;
  cls[0xf7] = cls[0xf8] = cls[0xf9] = cls[0xfd] = C_ARG1;
  cls[0xfc] = C_FC;
  cls[0xff] = C_EOS;
  return cls;
}

/** Fast check: terminated, no unknown bytes, mostly letters. */
function looksLikeText(rom: Uint8Array, t: number, cls: Uint8Array): boolean {
  let letters = 0, chars = 0;
  const end = Math.min(rom.length, t + 1024);
  for (let o = t; o < end; o++) {
    switch (cls[rom[o]]) {
      case C_EOS:
        return o - t >= 3 && letters >= 2 && letters * 2 >= chars;
      case C_BAD:
        return false;
      case C_LETTER: letters++; chars++; break;
      case C_CHAR: chars++; break;
      case C_ARG1: o++; break;
      case C_FC: o += 1; break; // sub-code; args are rare, decodeString handles exact length
    }
  }
  return false;
}

// ---- event-script pointers. The script bytecode packs a 4-byte pointer right after its opcode,
// so most of them sit at unaligned addresses that the word-aligned scan above can never see
// (every NPC line behind `msgbox`). Port of Vietrom's gen3 plugin: only these command shapes count.
const TB_TEXTS = [2, 2, 2, 1, 3, 2, 3, 3, 3, 2]; // trainerbattle type -> leading text pointers
const LOADWORD_NEXT = new Set([0x09, 0x1a]); // callstd, setorcopyvar
const MESSAGE_NEXT = new Set([0x66, 0x02, 0x03, 0x04, 0x32]); // waitmessage, end, return, call, waitfanfare

/** Pointer value at p as a ROM offset, or -1 when it is not a pointer into the ROM. */
function ptrAt(rom: Uint8Array, p: number): number {
  if (p + 4 > rom.length || (rom[p + 3] !== 0x08 && rom[p + 3] !== 0x09)) return -1;
  const v = (rom[p] | (rom[p + 1] << 8) | (rom[p + 2] << 16) | (rom[p + 3] << 24)) >>> 0;
  const t = v - ROM_BASE;
  return t > 0 && t < rom.length ? t : -1;
}

/** Candidate groups of pointer positions (all must be accepted) and whether the context is strong. */
function scriptCandidates(rom: Uint8Array): { group: number[]; strong: boolean }[] {
  const out: { group: number[]; strong: boolean }[] = [];
  const n = rom.length;
  for (let i = 0; i + 6 < n; i++) {
    const b = rom[i];
    if (b === 0x0f && rom[i + 1] === 0x00) {
      const next = rom[i + 6];
      if (ptrAt(rom, i + 2) >= 0 && LOADWORD_NEXT.has(next)) out.push({ group: [i + 2], strong: next === 0x09 });
    } else if (b === 0x67) {
      if (ptrAt(rom, i + 1) >= 0 && MESSAGE_NEXT.has(rom[i + 5])) out.push({ group: [i + 1], strong: false });
    } else if (b === 0x5c && rom[i + 1] <= 9) {
      const k = TB_TEXTS[rom[i + 1]];
      const group = Array.from({ length: k }, (_, j) => i + 6 + 4 * j);
      if (group.every((p) => ptrAt(rom, p) >= 0)) out.push({ group, strong: true });
    }
  }
  return out;
}

/** A string starts after the previous one's terminator (or after its 1-3 bytes of zero padding). */
function startsString(rom: Uint8Array, t: number): boolean {
  if (t <= 0) return false;
  if (rom[t - 1] === 0xff) return true;
  if (t % 4) return false;
  let i = t - 1;
  while (i >= 0 && t - i <= 3 && rom[i] === 0) i--;
  return i >= 0 && i < t - 1 && rom[i] === 0xff;
}

export function scanDialogue(
  rom: Uint8Array,
  cm: CharMap,
  ptrs: Map<number, number[]>,
  exclude: [number, number][],
): Entry[] {
  const cls = byteClasses(cm);
  const inExcluded = (o: number) => exclude.some(([a, b]) => o >= a && o < b);

  // add the script-command pointers to the aligned ones (copy: the caller's map stays as it was)
  ptrs = new Map([...ptrs].map(([t, l]) => [t, [...l]]));
  const okTarget = (t: number, strong: boolean) =>
    t > 0 && !inExcluded(t) && (rom[t - 1] === 0xff || (strong && t % 4 === 0)) && looksLikeText(rom, t, cls);
  for (const { group, strong } of scriptCandidates(rom)) {
    const ts = group.map((p) => ptrAt(rom, p));
    if (!ts.every((t) => okTarget(t, strong))) continue;
    group.forEach((p, k) => {
      const list = ptrs.get(ts[k]);
      if (!list) ptrs.set(ts[k], [p]);
      else if (!list.includes(p)) list.push(p);
    });
  }

  const targets: number[] = [];
  for (const t of ptrs.keys()) if (looksLikeText(rom, t, cls) && !inExcluded(t)) targets.push(t);
  targets.sort((a, b) => a - b);
  const out: Entry[] = [];
  for (const t of targets) {
    const d = decodeString(rom, t, cm, 1024);
    if (!d.terminated || d.unknown > 0) continue;

    const prev = out[out.length - 1];
    if (prev && t < prev.offset + prev.capacity) {
      // pointer into the middle of an earlier string (shared suffix)
      prev.shared = true;
      continue;
    }
    // junk guard: real strings follow another string's terminator; code/graphics rarely do
    if (!startsString(rom, t)) continue;
    out.push({
      id: `dialogue:${t.toString(16)}`,
      kind: "dialogue",
      offset: t,
      capacity: d.length,
      refs: ptrs.get(t)!,
      fixed: false,
      shared: false,
      text: d.text,
    });
  }
  return out;
}

export function extractAll(rom: Uint8Array, cm: CharMap): Entry[] {
  const { entries, ranges } = scanTables(rom, cm);
  const ptrs = scanPointers(rom);
  return [...entries, ...scanDialogue(rom, cm, ptrs, ranges)];
}

// ---------------------------------------------------------------- rebuild

export type BuildIssue = { id: string; message: string };

export type BuildResult = {
  rom: Uint8Array;
  written: number;
  relocated: number;
  issues: BuildIssue[];
};

/**
 * Apply translations to a copy of the ROM. Strings that no longer fit are
 * moved into the expansion area (ROM grows toward 32 MB) and every pointer
 * to them is rewritten. Original bytes of moved strings are left untouched,
 * so anything we failed to detect still points at valid text.
 */
export function buildRom(
  src: Uint8Array,
  entries: Entry[],
  translations: Record<string, string>,
  cm: CharMap,
): BuildResult {
  const out = new Uint8Array(MAX_ROM);
  out.set(src);
  out.fill(0xff, src.length);
  const dv = new DataView(out.buffer);

  let cursor = src.length;
  const findFree = () => {
    if (src.length < MAX_ROM) return;
    // full-size ROM: fall back to the largest 0xFF run in the second half
    let best = 0, bestLen = 0;
    for (let i = MAX_ROM / 2; i < MAX_ROM; ) {
      if (src[i] !== 0xff) { i++; continue; }
      let j = i;
      while (j < MAX_ROM && src[j] === 0xff) j++;
      if (j - i > bestLen) { best = i; bestLen = j - i; }
      i = j;
    }
    cursor = best + 16; // keep a margin after whatever precedes the run
  };
  findFree();
  const alloc = (n: number) => {
    cursor = (cursor + 3) & ~3;
    if (cursor + n > MAX_ROM) throw new Error("Hết chỗ trống trong ROM");
    const at = cursor;
    cursor += n;
    return at;
  };

  const issues: BuildIssue[] = [];
  let written = 0;
  let relocated = 0;
  for (const e of entries) {
    const tr = translations[e.id];
    if (tr === undefined || tr === "" || tr === e.text) continue;
    let bytes: Uint8Array;
    try {
      bytes = encodeString(tr, cm);
    } catch (err) {
      issues.push({ id: e.id, message: err instanceof EncodeError ? err.message : String(err) });
      continue;
    }
    if (e.fixed) {
      if (bytes.length > e.capacity) {
        issues.push({ id: e.id, message: `Quá dài: ${bytes.length - 1}/${e.capacity - 1} ký tự` });
        continue;
      }
      out.set(bytes, e.offset);
      out.fill(EOS, e.offset + bytes.length, e.offset + e.capacity);
    } else if (bytes.length <= e.capacity && !e.shared) {
      out.set(bytes, e.offset);
      out.fill(EOS, e.offset + bytes.length, e.offset + e.capacity);
    } else {
      try {
        const at = alloc(bytes.length);
        out.set(bytes, at);
        for (const p of e.refs) dv.setUint32(p, ROM_BASE + at, true);
        relocated++;
      } catch (err) {
        issues.push({ id: e.id, message: String((err as Error).message) });
        continue;
      }
    }
    written++;
  }

  // trim to the smallest power-of-two size that holds everything
  const used = Math.max(src.length, cursor);
  let size = 1 << 20;
  while (size < used) size <<= 1;
  return { rom: out.slice(0, Math.min(size, MAX_ROM)), written, relocated, issues };
}

// ---------------------------------------------------------------- patch

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal BPS patch writer (SourceRead + TargetRead only). */
export function createBps(source: Uint8Array, target: Uint8Array): Uint8Array {
  let buf = new Uint8Array(1 << 16);
  let len = 0;
  const byte = (b: number) => {
    if (len === buf.length) {
      const nb = new Uint8Array(buf.length * 2);
      nb.set(buf);
      buf = nb;
    }
    buf[len++] = b;
  };
  const varint = (n: number) => {
    for (;;) {
      const x = n % 128;
      n = Math.floor(n / 128);
      if (n === 0) return byte(0x80 | x);
      byte(x);
      n--;
    }
  };
  const u32 = (n: number) => [0, 8, 16, 24].forEach((s) => byte((n >>> s) & 0xff));

  "BPS1".split("").forEach((c) => byte(c.charCodeAt(0)));
  varint(source.length);
  varint(target.length);
  varint(0);

  let litStart = -1;
  const flush = (end: number) => {
    if (litStart < 0) return;
    varint((end - litStart - 1) * 4 + 1); // TargetRead
    for (let k = litStart; k < end; k++) byte(target[k]);
    litStart = -1;
  };
  const n = target.length;
  let targetRel = 0; // BPS TargetCopy cursor
  for (let i = 0; i < n; ) {
    let j = i;
    while (j < n && j < source.length && source[j] === target[j]) j++;
    // run of a repeated byte (e.g. 0xFF expansion area): RLE via TargetCopy
    let r = i;
    if (j === i && i > 0) while (r < n && target[r] === target[i - 1]) r++;
    if (j - i >= 8 || (j === n && j > i)) {
      flush(i);
      varint((j - i - 1) * 4); // SourceRead
      i = j;
    } else if (r - i >= 32) {
      flush(i);
      varint((r - i - 1) * 4 + 3); // TargetCopy from the byte just written
      const delta = i - 1 - targetRel;
      varint(Math.abs(delta) * 2 + (delta < 0 ? 1 : 0));
      targetRel = r;
      i = r;
    } else {
      if (litStart < 0) litStart = i;
      i = j > i ? j : i + 1;
    }
  }
  flush(n);
  u32(crc32(source));
  u32(crc32(target));
  u32(crc32(buf.subarray(0, len)));
  return buf.slice(0, len);
}
