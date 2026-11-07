// Prompting + strict validation of model output for one chunk.
import { buildCharMap } from "~/lib/gba/charmap";
import { approxBytes, hasPlaceholder, maskTokens, sameTokens, unmaskTokens } from "~/lib/gba/tokens";
import { glossaryPrompt, lookup } from "./glossary";
import { VIETNAMESE } from "~/lib/gba/vietnamese";
import { FIRERED_US_10 } from "~/lib/gba/vi-profile";
import type { ChunkItem, ChunkResult } from "../database/schema";
import type { ChatProvider } from "./providers";

// Characters a translation may use when the build adds the Vietnamese font: the default
// charmap minus the slots the font reclaims, plus every Vietnamese letter.
const VI_ALLOWED = (() => {
  const set = new Set([...buildCharMap().encode.keys()].filter((c) => !FIRERED_US_10.reclaim.includes(c)));
  for (const c of VIETNAMESE) set.add(c);
  return set;
})();

const KIND_HINT: Record<string, string> = {
  dialogue: "in-game dialogue",
  species: "Pokémon species name",
  move: "move name",
  ability: "ability name",
  item: "item name",
};

/** Typographic punctuation the GBA font has no glyph for, mapped to what it does have. */
export function normalizePunct(v: string): string {
  return v.replace(/\s*[—–―]\s*/g, "-").replace(/\u00a0/g, " ");
}

function systemPrompt(diacritics: boolean) {
  return `You are localizing the GBA game Pokémon (Generation 3) from English into Vietnamese.

Rules:
1. Translate naturally for Vietnamese players; keep the friendly tone of the original.
2. The text contains numbered markers like ⟦1⟧, ⟦2⟧ standing for game control codes (line breaks, text boxes, player names…). Copy every marker EXACTLY, once each, in the same order, with the same number; place it where the original structure sits. Never translate, renumber, add, drop or alter them, and never replace one with a newline or another marker.
3. Names (moves, items, abilities, titles), also inside dialogue: if a name is in the glossary given with the entries, use exactly that Vietnamese name. Otherwise translate it into natural Vietnamese in Title Case, never ALL CAPS (e.g. "Đấm Lửa"), short, with no ending punctuation. Keep Pokémon species names and trademarks (POKéMON, POKé BALL, TM, HM) in English, in Title Case (PIKACHU -> Pikachu).
4. ${diacritics ? "Use proper Vietnamese with full diacritics, precomposed Unicode (NFC). Use only Vietnamese letters, ASCII, and the punctuation … “ ” ‘ ’ é ♂ ♀ ¥ × ·; no emoji or other symbols. Never use the long dashes — or –; write a plain hyphen - (the original uses \"--\")." : "Write Vietnamese WITHOUT diacritics (khong dau): only ASCII letters. The game font has no accented letters yet."}
5. Dialogue: keep the markers in the same order and the same count, so the text boxes and line breaks keep the original structure. Do not insert real newlines; line breaks inside a box are re-flowed to the box width automatically.
6. When an item has "max" set, the translation must be at most that many characters (control tokens count as 1).
7. When an item has "lines" and "cols", it is shown in a fixed window: the translation may take at most "lines" lines per page, each about "cols" characters wide (the \u27e6\u27e7 markers and blank lines do not count). Vietnamese runs longer than English, so condense: drop filler words and fold clauses, but keep every fact and instruction.
8. Reply with ONLY a JSON array, no prose, no code fences: [{"i":"<id>","v":"<translation>"}, ...] with one entry per input id.

Marker examples (every marker kept, same order and count, never turned into a newline):
- in:  "Humph!⟦1⟧At least you’re raising your⟦2⟧POKéMON!"
  out: "${diacritics ? "Hừm!⟦1⟧Ít ra cậu cũng đang nuôi dưỡng⟦2⟧POKéMON của mình!" : "Hum!⟦1⟧It ra cau cung dang nuoi duong⟦2⟧POKéMON cua minh!"}"
- in:  "⟦1⟧, your POKéMON is ready!⟦2⟧Come back soon.⟦3⟧"
  out: "${diacritics ? "⟦1⟧, POKéMON của bạn đã sẵn sàng!⟦2⟧Hãy quay lại sớm nhé.⟦3⟧" : "⟦1⟧, POKéMON cua ban da san sang!⟦2⟧Hay quay lai som nhe.⟦3⟧"}"`;
}

type Retry = { prev: string; err: string };

function userPrompt(items: ChunkItem[], masked: Map<string, string>, retry?: Map<string, Retry>) {
  const payload = items.map((it) => ({
    i: it.id,
    k: KIND_HINT[it.kind] ?? it.kind,
    ...(it.fixed ? { max: it.capacity - 1 } : {}),
    ...(it.maxLines ? { lines: it.maxLines, cols: it.cols } : {}),
    t: masked.get(it.id) ?? it.text,
    ...(retry?.has(it.id) ? { prev: retry.get(it.id)!.prev, err: retry.get(it.id)!.err } : {}),
  }));
  const glossary = glossaryPrompt(items.map((it) => it.text));
  const head = retry
    ? "Your previous answer for these entries was rejected. Translate again: fix the problem described in \"err\" (\"prev\" is the rejected answer), keep the markers exactly as in \"t\" and respect \"max\".\n"
    : "";
  return `${glossary ? glossary + "\n\n" : ""}${head}Translate these entries:\n${JSON.stringify(payload)}`;
}

function parseReply(reply: string): Map<string, string> {
  // tolerate code fences or stray prose around the array
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("Không tìm thấy JSON trong phản hồi AI");
  const arr = JSON.parse(reply.slice(start, end + 1)) as unknown;
  if (!Array.isArray(arr)) throw new Error("Phản hồi AI không phải mảng");
  const out = new Map<string, string>();
  for (const e of arr) {
    if (e && typeof e.i === "string" && typeof e.v === "string") out.set(e.i, e.v);
  }
  return out;
}

const MARKER_ISSUE = "Sai mã điều khiển so với bản gốc";
const TOO_LONG_PREFIX = "Quá dài";
const RETRIES = 2;

/**
 * Rough line count of `text` in a fixed window of `cols` characters per line. The real check
 * is pixel based and runs in the browser; this only decides when asking the model to shorten
 * is worth it, so it never flags a result on its own.
 */
export function estimateLines(text: string, cols: number): number {
  let most = 0;
  for (const page of text.split("\\p")) {
    let n = 0;
    // a blank line between paragraphs is not drawn by the layout, so each paragraph wraps alone
    for (const para of page.split(/(?:\\n|\n){2,}/)) {
      let len = 0;
      let lines = 0;
      for (const word of para.replace(/\\[nl]|\n/g, " ").split(/\s+/).filter(Boolean)) {
        const w = [...word.replace(/\{[^}]*\}/g, "x")].length;
        if (!lines) (lines = 1), (len = w);
        else if (len + 1 + w > cols) (lines += 1), (len = w);
        else len += 1 + w;
      }
      n += lines;
    }
    most = Math.max(most, n);
  }
  return most;
}

export function validate(item: ChunkItem, text: string, diacritics: boolean): string | undefined {
  if (!text.trim() && item.text.trim()) return "AI trả về chuỗi rỗng";
  if (hasPlaceholder(text) || !sameTokens(item.text, text)) return MARKER_ISSUE;
  if (item.fixed && approxBytes(text) > item.capacity)
    return `${TOO_LONG_PREFIX}: ${approxBytes(text) - 1}/${item.capacity - 1}`;
  if (diacritics) {
    const bad = [...text.replace(/\{[^}]*\}|\\[nlp]|\n/g, "")].find((c) => !VI_ALLOWED.has(c));
    if (bad) return `Ký tự không có trong font: "${bad}"`;
  }
  // eslint-disable-next-line no-control-regex
  if (!diacritics && /[^\x00-\x7F…“”‘’é♂♀]/.test(text.replace(/\{[^}]*\}/g, ""))) return "Có ký tự có dấu";
  return undefined;
}

/**
 * Translate one chunk. Throws when the reply is unusable as a whole (the
 * caller retries / falls back); per-item problems become flagged results.
 */
export async function translateChunk(
  provider: ChatProvider,
  items: ChunkItem[],
  diacritics: boolean,
): Promise<ChunkResult[]> {
  const todo = items.filter((it) => it.text.trim());
  // hide control tokens behind placeholders so the model cannot rewrite them (\p -> \n …)
  const masks = new Map(todo.map((it) => [it.id, maskTokens(it.text)]));
  const maskedText = new Map([...masks].map(([id, m]) => [id, m.masked]));
  // entries that come with a rejected earlier answer (layout failures found in the browser)
  const seeded = new Map<string, Retry>(
    todo.filter((it) => it.retry).map((it) => [it.id, { prev: maskTokens(it.retry!.prev).masked, err: it.retry!.err }]),
  );
  const reply = todo.length
    ? await provider.complete(systemPrompt(diacritics), userPrompt(todo, maskedText, seeded.size ? seeded : undefined))
    : "[]";
  const map = parseReply(reply);
  const missing = todo.filter((it) => !map.has(it.id)).length;
  // a reply that skipped most of the chunk is a failed call, not flagged lines
  if (todo.length && missing > todo.length / 2) throw new Error(`AI bỏ sót ${missing}/${todo.length} mục`);

  const finish = (it: ChunkItem, v: string): ChunkResult => {
    let nv = normalizePunct(unmaskTokens(v, masks.get(it.id)?.tokens ?? [])).normalize("NFC");
    // names (move / ability / item) that the glossary knows exactly: its Vietnamese name wins over
    // whatever the model wrote, since the prompt hint is only advisory. When the full name does
    // not fit a fixed slot, fall back to the short form.
    if (it.kind !== "dialogue" && it.kind !== "species") {
      const g = lookup(it.kind, it.text);
      const fits = (c?: string) => !!c && !validate(it, c.normalize("NFC"), diacritics);
      const pick = [g?.vi, g?.vi_short].find(fits);
      if (pick) nv = pick.normalize("NFC");
    }
    const issue = validate(it, nv, diacritics);
    return issue ? { id: it.id, text: nv, ok: false, issue } : { id: it.id, text: nv, ok: true };
  };

  const done = new Map<string, ChunkResult>();
  for (const it of todo) {
    const v = map.get(it.id);
    if (v !== undefined) done.set(it.id, finish(it, v));
  }

  // lines whose control codes came back wrong or that overflow a fixed slot: ask again with the exact error
  const lineExcess = (it: ChunkItem, r?: ChunkResult) => {
    if (!r?.ok || !it.maxLines || !it.cols) return 0;
    return estimateLines(r.text, it.cols) - it.maxLines;
  };
  const retryable = (r?: ChunkResult) => !!r && !r.ok && (r.issue === MARKER_ISSUE || !!r.issue?.startsWith(TOO_LONG_PREFIX));
  for (let round = 0; round < RETRIES; round++) {
    const bad = todo.filter(
      (it) => map.get(it.id) === undefined || retryable(done.get(it.id)) || lineExcess(it, done.get(it.id)) > 0,
    );
    if (!bad.length) break;
    const retry = new Map<string, Retry>(
      bad.map((it) => {
        const want = masks.get(it.id)!.tokens.map((_, i) => `⟦${i + 1}⟧`).join(" ");
        const prev = map.get(it.id) ?? "";
        const got = prev.match(/⟦\s*\d+\s*⟧/g)?.join(" ") || "none";
        const r = done.get(it.id);
        const over = lineExcess(it, r);
        const err = over > 0
          ? `Too long for the window: about ${over + it.maxLines!} lines, at most ${it.maxLines} lines of ~${it.cols} characters each. Condense it: drop filler words, merge clauses, keep every fact.`
          : r?.issue?.startsWith(TOO_LONG_PREFIX)
          ? `Too long for the slot (${r.issue.slice(TOO_LONG_PREFIX.length + 2)} characters). Shorten it to at most ${it.capacity - 1} characters: abbreviate, drop filler words, keep the meaning.`
          : `Expected markers in order: ${want || "(none)"}. Your answer had: ${got}.`;
        return [it.id, { prev, err }];
      }),
    );
    try {
      const again = parseReply(await provider.complete(systemPrompt(diacritics), userPrompt(bad, maskedText, retry)));
      for (const it of bad) {
        const v = again.get(it.id);
        if (v === undefined) continue;
        const r = finish(it, v);
        map.set(it.id, v);
        done.set(it.id, r);
      }
    } catch {
      break; // keep the first-pass results; they stay flagged for review
    }
  }

  return items.map((it) => {
    if (!it.text.trim()) return { id: it.id, text: it.text, ok: true };
    return done.get(it.id) ?? { id: it.id, text: "", ok: false, issue: "AI không trả kết quả" };
  });
}
