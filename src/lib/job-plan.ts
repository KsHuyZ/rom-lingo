// Chunk planning + pricing, shared so the browser can quote the exact price
// the server will reserve.
import { billableChars, chunkCost } from "./gba/tokens";

export type PlanItem = {
  id: string;
  kind: "dialogue" | "move" | "ability" | "item"; // Pokémon names (species) are never translated
  text: string;
  capacity: number;
  fixed: boolean;
};

const CHUNK_SIZE = { dialogue: 40, names: 80 };

/** Request limits, validated on the server. */
export const LIMITS = { maxItems: 20_000, maxTextLen: 2_048, maxTotalChars: 2_000_000 };

/** Dialogue keeps ROM order so neighbouring lines give the model context. */
export function planChunks<T extends PlanItem>(items: T[], creditsPer1k: number) {
  const dialogue = items.filter((i) => i.kind === "dialogue");
  const names = items.filter((i) => i.kind !== "dialogue");
  const chunks: T[][] = [];
  for (let i = 0; i < names.length; i += CHUNK_SIZE.names) chunks.push(names.slice(i, i + CHUNK_SIZE.names));
  for (let i = 0; i < dialogue.length; i += CHUNK_SIZE.dialogue)
    chunks.push(dialogue.slice(i, i + CHUNK_SIZE.dialogue));
  return chunks.map((c) => {
    const chars = c.reduce((n, it) => n + billableChars(it.text), 0);
    return { items: c, chars, cost: chunkCost(chars, creditsPer1k) };
  });
}

export function quote(items: PlanItem[], creditsPer1k: number) {
  const plan = planChunks(items, creditsPer1k);
  return {
    chunks: plan.length,
    chars: plan.reduce((n, c) => n + c.chars, 0),
    credits: plan.reduce((n, c) => n + c.cost, 0),
  };
}
