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

function systemPrompt(diacritics: boolean) {
  return `You are localizing the GBA game Pokémon (Generation 3) from English into Vietnamese.

Rules:
1. Translate naturally for Vietnamese players; keep the friendly tone of the original.
2. The text contains numbered markers like ⟦1⟧, ⟦2⟧ standing for game control codes (line breaks, text boxes, player names…). Copy every marker EXACTLY, once each, in the same order, with the same number; place it where the original structure sits. Never translate, renumber, add, drop or alter them, and never replace one with a newline or another marker.
3. Names (moves, items, abilities, titles), also inside dialogue: if a name is in the glossary given with the entries, use exactly that Vietnamese name. Otherwise translate it into natural Vietnamese in Title Case, never ALL CAPS (e.g. "Đấm Lửa"), short, with no ending punctuation. Keep Pokémon species names and trademarks (POKéMON, POKé BALL, TM, HM) in English, in Title Case (PIKACHU -> Pikachu).
4. ${diacritics ? "Use proper Vietnamese with full diacritics, precomposed Unicode (NFC). Use only Vietnamese letters, ASCII, and the punctuation … “ ” ‘ ’ é ♂ ♀ ¥ × ·; no emoji or other symbols." : "Write Vietnamese WITHOUT diacritics (khong dau): only ASCII letters. The game font has no accented letters yet."}
5. Dialogue: keep the markers in the same order and the same count, so the text boxes and line breaks keep the original structure. Do not insert real newlines; line breaks inside a box are re-flowed to the box width automatically.
6. When an item has "max" set, the translation must be at most that many characters (control tokens count as 1).
7. Reply with ONLY a JSON array, no prose, no code fences: [{"i":"<id>","v":"<translation>"}, ...] with one entry per input id.

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
    t: masked.get(it.id) ?? it.text,
    ...(retry?.has(it.id) ? { prev: retry.get(it.id)!.prev, err: retry.get(it.id)!.err } : {}),
  }));
  const glossary = glossaryPrompt(items.map((it) => it.text));
  const head = retry
    ? "Your previous answer for these entries broke the markers. Translate again: fix the problem described in \"err\" and keep the markers exactly as in \"t\".\n"
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
const MARKER_RETRIES = 2;

export function validate(item: ChunkItem, text: string, diacritics: boolean): string | undefined {
  if (!text.trim() && item.text.trim()) return "AI trả về chuỗi rỗng";
  if (hasPlaceholder(text) || !sameTokens(item.text, text)) return MARKER_ISSUE;
  if (item.fixed && approxBytes(text) > item.capacity)
    return `Quá dài: ${approxBytes(text) - 1}/${item.capacity - 1}`;
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
  const reply = todo.length ? await provider.complete(systemPrompt(diacritics), userPrompt(todo, maskedText)) : "[]";
  const map = parseReply(reply);
  const missing = todo.filter((it) => !map.has(it.id)).length;
  // a reply that skipped most of the chunk is a failed call, not flagged lines
  if (todo.length && missing > todo.length / 2) throw new Error(`AI bỏ sót ${missing}/${todo.length} mục`);

  const finish = (it: ChunkItem, v: string): ChunkResult => {
    let nv = unmaskTokens(v, masks.get(it.id)?.tokens ?? []).normalize("NFC");
    // too long for a fixed slot: the glossary's short form for this exact name, when it fits
    if (it.fixed && it.kind !== "dialogue" && approxBytes(nv) > it.capacity) {
      const short = lookup(it.kind, it.text)?.vi_short?.normalize("NFC");
      if (short && !validate(it, short, diacritics)) nv = short;
    }
    const issue = validate(it, nv, diacritics);
    return issue ? { id: it.id, text: nv, ok: false, issue } : { id: it.id, text: nv, ok: true };
  };

  const done = new Map<string, ChunkResult>();
  for (const it of todo) {
    const v = map.get(it.id);
    if (v !== undefined) done.set(it.id, finish(it, v));
  }

  // lines whose control codes came back wrong: ask again with the exact error, a couple of times
  for (let round = 0; round < MARKER_RETRIES; round++) {
    const bad = todo.filter((it) => {
      const r = done.get(it.id);
      return map.get(it.id) === undefined || (r && !r.ok && r.issue === MARKER_ISSUE);
    });
    if (!bad.length) break;
    const retry = new Map<string, Retry>(
      bad.map((it) => {
        const want = masks.get(it.id)!.tokens.map((_, i) => `⟦${i + 1}⟧`).join(" ");
        const prev = map.get(it.id) ?? "";
        const got = prev.match(/⟦\s*\d+\s*⟧/g)?.join(" ") || "none";
        return [it.id, { prev, err: `Expected markers in order: ${want || "(none)"}. Your answer had: ${got}.` }];
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
