// Pokémon name glossary (English -> Vietnamese). Port of Vietrom/vietrom/glossary.py;
// data from Vietrom's glossary_data/pokemon_vi.yaml (English names: PokeAPI, BSD-3-Clause).
import data from "./glossary.json";

export type GlossaryEntry = {
  kind: string;
  en: string;
  aliases?: string[];
  vi?: string;
  vi_short?: string;
};

const PLURAL_KINDS = new Set(["item", "term"]); // "POKé BALLS", "POTIONS"
const PLURAL_SUFFIX = ["es", "s"];
const GENDER: Record<string, string> = { "♀": "f", "♂": "m" }; // keep Nidoran apart

/** lower-case, drop every non letter/digit character, é -> e. */
export function normalize(name: string): string {
  const s = [...name].map((c) => GENDER[c] ?? c).join("").normalize("NFKD").toLowerCase();
  return [...s].filter((c) => /[\p{L}\p{N}]/u.test(c) && !/\p{M}/u.test(c)).join("");
}

const names = (e: GlossaryEntry) => [e.en, ...(e.aliases ?? [])];
const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Index = {
  caps: RegExp | null;
  anycase: RegExp | null;
  byName: Map<string, [GlossaryEntry, boolean][]>;
};
let index: Index | null = null;

function build(entries: GlossaryEntry[]): Index {
  const byName = new Map<string, [GlossaryEntry, boolean][]>();
  const caps = new Set<string>();
  const anycase = new Set<string>();
  const plural = new Set<string>();
  for (const e of entries) {
    // Gen 3 writes some multi-word names run together (DYNAMICPUNCH, SOLARBEAM): match those too
    const joined = names(e)
      .filter((n) => /[\s-]/.test(n.trim()) && e.kind !== "term")
      .map((n) => n.replace(/[\s-]+/g, ""));
    for (let n of new Set([...names(e), ...joined])) {
      n = n.trim();
      if (!n) continue;
      const single = n.split(/\s+/).length === 1;
      // names written ALL CAPS in Gen 3 (single words, and terms of up to 2 letters)
      const capsOnly = e.kind === "term" ? normalize(n).length <= 2 : single;
      (capsOnly ? caps : anycase).add(n);
      if (PLURAL_KINDS.has(e.kind)) plural.add(n);
      const k = n.toLowerCase();
      byName.set(k, [...(byName.get(k) ?? []), [e, capsOnly]]);
    }
  }
  const rx = (set: Set<string>) =>
    set.size
      ? new RegExp(
          "(?<![\\p{L}\\p{N}_])(?:" +
            [...set]
              .sort((a, b) => b.length - a.length)
              .map((n) => escapeRx(n) + (plural.has(n) ? "(?:ES|S)?" : ""))
              .join("|") +
            ")(?![\\p{L}\\p{N}_])",
          "giu",
        )
      : null;
  return { caps: rx(caps), anycase: rx(anycase), byName };
}

const ENTRIES = data as GlossaryEntry[];

function candidates(ix: Index, word: string): [GlossaryEntry, boolean][] {
  const key = word.toLowerCase();
  const direct = ix.byName.get(key);
  if (direct) return direct;
  const out: [GlossaryEntry, boolean][] = [];
  for (const suf of PLURAL_SUFFIX) {
    if (key.endsWith(suf)) {
      for (const [e, c] of ix.byName.get(key.slice(0, -suf.length)) ?? []) if (PLURAL_KINDS.has(e.kind)) out.push([e, c]);
    }
  }
  return out;
}

/**
 * Entries named in `text`. Single-word names (and PP/HP style terms) count only when written
 * ALL CAPS (Gen 3 style), so common words do not match; multi-word names and terms match in
 * any case. Whole words only. Results are in order of appearance.
 */
export function findTerms(text: string, kinds?: Set<string>): GlossaryEntry[] {
  const ix = (index ??= build(ENTRIES));
  const hits: [number, GlossaryEntry][] = [];
  for (const [pat, needCaps] of [[ix.caps, true], [ix.anycase, false]] as const) {
    if (!pat) continue;
    pat.lastIndex = 0;
    for (const m of text.matchAll(pat)) {
      const word = m[0];
      if (needCaps && word !== word.toUpperCase()) continue;
      for (const [e, capsOnly] of candidates(ix, word)) {
        if (capsOnly === needCaps && (!kinds || kinds.has(e.kind))) hits.push([m.index!, e]);
      }
    }
  }
  const out: GlossaryEntry[] = [];
  for (const [, e] of hits.sort((a, b) => a[0] - b[0])) if (!out.includes(e)) out.push(e);
  return out;
}

let byKey: Map<string, GlossaryEntry> | null = null;
/** Exact glossary entry for `name` of `kind` (aliases included), or undefined. */
export function lookup(kind: string, name: string): GlossaryEntry | undefined {
  if (!byKey) {
    byKey = new Map();
    for (const e of ENTRIES) for (const n of names(e)) if (normalize(n)) byKey.set(`${e.kind}|${normalize(n)}`, e);
  }
  return byKey.get(`${kind}|${normalize(name)}`);
}

/** Name as Gen 3 text writes it: ALL CAPS but the é of POKé. */
export const gen3Caps = (name: string) => [...name].map((c) => (c === "é" ? c : c.toUpperCase())).join("");

/** Prompt sections for the glossary entries found in `texts`. Empty string when none. */
export function glossaryPrompt(texts: string[]): string {
  const hits = findTerms(texts.join("\n"));
  const keep = [...new Set(hits.filter((e) => e.kind === "species").map((e) => e.en))];
  const pairs = new Map<string, string>();
  for (const e of hits) {
    if (e.kind === "species" || !e.vi) continue;
    const en = gen3Caps(e.en);
    let line = `${en} => ${e.vi}`;
    if (e.vi_short && e.vi_short !== e.vi) line += ` (short form when space is tight: ${e.vi_short})`;
    if (!pairs.has(en.toUpperCase() + "|" + e.vi)) pairs.set(en.toUpperCase() + "|" + e.vi, line);
  }
  const out: string[] = [];
  if (keep.length) out.push(`Pokémon names to keep in English (Title Case) inside the Vietnamese sentence: ${keep.join(", ")}`);
  if (pairs.size) out.push(`Glossary: how to write these names (use exactly these Vietnamese names, also inside dialogue). Translate the rest of every entry fully into Vietnamese:\n${[...pairs.values()].join("\n")}`);
  return out.join("\n\n");
}
