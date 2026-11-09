// Background worker living inside the Node server process.
// Each loop: claim one chunk -> translate -> persist + emit progress.
// All state is in Postgres, so a restart resumes where it stopped.
import { eq, sql } from "drizzle-orm";
import { db } from "../database/client";
import { translationChunks, translationJobs, type ChunkItem, type ChunkResult } from "../database/schema";
import { providers, ProviderError, type ChatProvider } from "../ai/providers";
import { translateChunk } from "../ai/translate";
import { jobEvents } from "./events";
import { finalizeIfDone, toSnapshot } from "./service";

const MAX_ATTEMPTS = 3;
const STALE_LOCK = "5 minutes"; // a 'running' chunk older than this was orphaned by a crash
const IDLE_MS = 2_000;

type Claimed = {
  id: number;
  job_id: string;
  idx: number;
  attempts: number;
  items: ChunkItem[];
  diacritics: boolean;
};

async function claimChunk(): Promise<Claimed | null> {
  const rows = await db.execute(sql`
    with next as (
      select c.id
      from translation_chunks c
      join translation_jobs j on j.id = c.job_id
      where j.status in ('queued', 'running')
        and c.available_at <= now()
        and (c.status = 'pending'
             or (c.status = 'running' and c.locked_at < now() - ${STALE_LOCK}::interval))
      order by j.created_at, c.idx
      limit 1
      for update of c skip locked
    )
    update translation_chunks c
       set status = 'running', locked_at = now(), attempts = c.attempts + 1, updated_at = now()
      from next, translation_jobs j
     where c.id = next.id and j.id = c.job_id
    returning c.id, c.job_id, c.idx, c.attempts, c.items, (j.options->>'diacritics')::boolean as diacritics
  `);
  const row = (rows as unknown as Claimed[])[0];
  if (!row) return null;
  await db
    .update(translationJobs)
    .set({ status: "running", updatedAt: sql`now()` })
    .where(sql`${translationJobs.id} = ${row.job_id} and ${translationJobs.status} = 'queued'`);
  return row;
}

// --- throttle for the primary provider (gemini-web dislikes bursts)
const MIN_INTERVAL = Number(process.env.AI_MIN_INTERVAL_MS ?? 0);
let nextSlot = 0;
async function throttle() {
  if (!MIN_INTERVAL) return;
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

async function runProviders(c: Claimed): Promise<{ results: ChunkResult[]; provider: ChatProvider }> {
  const { primary, fallback } = providers();
  if (!primary && !fallback) throw new ProviderError("Chưa cấu hình AI provider", false);
  let firstError: unknown;
  if (primary) {
    try {
      await throttle();
      return { results: await translateChunk(primary, c.items, c.diacritics), provider: primary };
    } catch (e) {
      firstError = e;
      console.warn(`[worker] chunk ${c.job_id}#${c.idx} primary failed:`, (e as Error).message);
    }
  }
  if (fallback) return { results: await translateChunk(fallback, c.items, c.diacritics), provider: fallback };
  throw firstError;
}

/** message safe to show in the browser: never echo upstream bodies or hosts */
function publicError(e: Error | null): string {
  if (!e) return "Dịch thất bại";
  if (e instanceof ProviderError) return e.transient ? "Dịch vụ AI đang bận, vui lòng thử lại sau" : "Dịch vụ AI chưa sẵn sàng";
  return "Dịch thất bại";
}

async function processChunk(c: Claimed) {
  let outcome: { results: ChunkResult[]; provider: ChatProvider } | null = null;
  let error: Error | null = null;
  try {
    outcome = await runProviders(c);
  } catch (e) {
    error = e as Error;
  }

  const job = await db.transaction(async (tx) => {
    if (outcome) {
      const flagged = outcome.results.filter((r) => !r.ok).length;
      await tx
        .update(translationChunks)
        .set({ status: "done", results: outcome.results, provider: outcome.provider.label, error: null, updatedAt: sql`now()` })
        .where(eq(translationChunks.id, c.id));
      await tx
        .update(translationJobs)
        .set({
          doneChunks: sql`${translationJobs.doneChunks} + 1`,
          doneStrings: sql`${translationJobs.doneStrings} + ${c.items.length}`,
          flaggedStrings: sql`${translationJobs.flaggedStrings} + ${flagged}`,
          fallbackChunks: sql`${translationJobs.fallbackChunks} + ${outcome.provider.name === "fallback" ? 1 : 0}`,
          updatedAt: sql`now()`,
        })
        .where(eq(translationJobs.id, c.job_id));
    } else if (c.attempts < MAX_ATTEMPTS && (!(error instanceof ProviderError) || error.transient)) {
      // retry later with backoff: 30s, 60s
      await tx
        .update(translationChunks)
        .set({
          status: "pending",
          error: error?.message ?? "unknown",
          availableAt: sql`now() + make_interval(secs => ${30 * c.attempts})`,
          updatedAt: sql`now()`,
        })
        .where(eq(translationChunks.id, c.id));
    } else {
      // give up on this chunk: mark it failed (detail stays server-side; job.error is shown to the browser)
      console.error(`[worker] chunk ${c.job_id}#${c.idx} failed:`, error?.message);
      await tx
        .update(translationChunks)
        .set({ status: "failed", error: error?.message ?? "unknown", updatedAt: sql`now()` })
        .where(eq(translationChunks.id, c.id));
      await tx
        .update(translationJobs)
        .set({ failedChunks: sql`${translationJobs.failedChunks} + 1`, error: publicError(error), updatedAt: sql`now()` })
        .where(eq(translationJobs.id, c.job_id));
    }
    const finished = await finalizeIfDone(tx, c.job_id);
    if (finished) return finished;
    const [j] = await tx.select().from(translationJobs).where(eq(translationJobs.id, c.job_id));
    return j;
  });

  const snap = toSnapshot(job);
  if (outcome) {
    jobEvents.emit(c.job_id, {
      type: "chunk",
      job: snap,
      chunkIdx: c.idx,
      // generic on purpose: provider.label is the backend host
      provider: outcome.provider.name === "fallback" ? "AI (dự phòng)" : "AI",
      results: outcome.results,
    });
  }
  if (!outcome || job.released) jobEvents.emit(c.job_id, { type: "status", job: snap });
}

async function loop(id: number) {
  for (;;) {
    try {
      const c = await claimChunk();
      if (!c) {
        await new Promise((r) => setTimeout(r, IDLE_MS));
        continue;
      }
      await processChunk(c);
    } catch (e) {
      console.error(`[worker ${id}]`, e);
      await new Promise((r) => setTimeout(r, IDLE_MS * 2));
    }
  }
}

/** Idempotent: safe to call from every request handler. */
export function ensureWorker() {
  const g = globalThis as unknown as { __romLingoWorker?: boolean };
  if (g.__romLingoWorker || typeof window !== "undefined") return;
  g.__romLingoWorker = true;
  const n = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 1));
  for (let i = 0; i < n; i++) void loop(i);
  console.log(`[worker] started ×${n}`);
}
