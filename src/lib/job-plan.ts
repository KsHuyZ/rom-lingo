// Chunk planning, shared so the browser can preview exactly what the server will run.
import { billableChars } from "./gba/tokens";

export type PlanItem = {
  id: string;
  kind: "dialogue" | "move" | "ability" | "item"; // Pokémon names (species) are never translated
  text: string;
  capacity: number;
  fixed: boolean;
  /** dialogue in a fixed window: most lines a page may take (set when the original shows it) */
  maxLines?: number;
  /** characters of the widest original line, a rough width budget per line */
  cols?: number;
  /** a rejected earlier answer and why, so the model corrects it instead of starting over */
  retry?: { prev: string; err: string };
};

const CTRL = /\{[^}]*\}|\\[nlp]|\n/g;

/**
 * Window limits implied by a dialogue's original: three or more lines without `\l` means a
 * fixed window of that many lines (e.g. the intro text); shorter ones may scroll, so no limit.
 */
export function dialogueLimits(text: string): { maxLines?: number; cols?: number } {
  const lines = Math.max(...text.split("\\p").map((p) => (p.match(/\\n|\\l|\n/g)?.length ?? 0) + 1));
  if (text.includes("\\l") || lines < 3) return {};
  const cols = Math.max(...text.split(/\\[nlp]|\n/).map((l) => [...l.replace(CTRL, "")].length));
  return { maxLines: lines, cols: Math.max(1, cols) };
}

const CHUNK_SIZE = { dialogue: 40, names: 80 };

/** Request limits, validated on the server. */
export const LIMITS = { maxItems: 20_000, maxTextLen: 2_048, maxTotalChars: 2_000_000 };

/** Dialogue keeps ROM order so neighbouring lines give the model context. */
export function planChunks<T extends PlanItem>(items: T[]) {
  const dialogue = items.filter((i) => i.kind === "dialogue");
  const names = items.filter((i) => i.kind !== "dialogue");
  const chunks: T[][] = [];
  for (let i = 0; i < names.length; i += CHUNK_SIZE.names) chunks.push(names.slice(i, i + CHUNK_SIZE.names));
  for (let i = 0; i < dialogue.length; i += CHUNK_SIZE.dialogue)
    chunks.push(dialogue.slice(i, i + CHUNK_SIZE.dialogue));
  return chunks.map((c) => {
    const chars = c.reduce((n, it) => n + billableChars(it.text), 0);
    return { items: c, chars };
  });
}

export function quote(items: PlanItem[]) {
  const plan = planChunks(items);
  return {
    chunks: plan.length,
    chars: plan.reduce((n, c) => n + c.chars, 0),
  };
}
