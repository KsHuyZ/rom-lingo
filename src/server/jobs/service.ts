import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { planChunks, type PlanItem } from "~/lib/job-plan";
import { db, type Tx } from "../database/client";
import {
  translationChunks,
  translationJobs,
  type ChunkItem,
  type ChunkResult,
  type JobStatus,
} from "../database/schema";
import { jobEvents, type JobSnapshot } from "./events";


type JobRow = typeof translationJobs.$inferSelect;

export function toSnapshot(j: JobRow): JobSnapshot {
  return {
    id: j.id,
    status: j.status,
    totalStrings: j.totalStrings,
    doneStrings: j.doneStrings,
    flaggedStrings: j.flaggedStrings,
    totalChunks: j.totalChunks,
    doneChunks: j.doneChunks,
    failedChunks: j.failedChunks,
    fallbackChunks: j.fallbackChunks,
    error: j.error,
    createdAt: j.createdAt.toISOString(),
  };
}

const ACTIVE: JobStatus[] = ["queued", "running", "paused"];

export async function createJob(
  userId: string,
  input: { gameCode: string; romCrc32: string; diacritics: boolean; items: ChunkItem[] },
) {
  const plan = planChunks(input.items as PlanItem[]);

  const job = await db.transaction(async (tx) => {
    // lock first so two concurrent requests cannot both pass the check below
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"jobs:" + userId}))`);
    // one active job per ROM per user: avoids duplicate work for the same text
    const existing = await tx
      .select({ id: translationJobs.id })
      .from(translationJobs)
      .where(
        and(
          eq(translationJobs.userId, userId),
          eq(translationJobs.gameCode, input.gameCode),
          eq(translationJobs.romCrc32, input.romCrc32),
          inArray(translationJobs.status, ACTIVE),
        ),
      );
    if (existing.length) throw new Error("ROM này đang có một job dịch chưa xong");

    const [j] = await tx
      .insert(translationJobs)
      .values({
        userId,
        gameCode: input.gameCode,
        romCrc32: input.romCrc32,
        options: { diacritics: input.diacritics },
        totalStrings: input.items.length,
        totalChunks: plan.length,
      })
      .returning();
    // insert in slices: one huge VALUES list can exceed parameter limits
    for (let i = 0; i < plan.length; i += 100) {
      await tx.insert(translationChunks).values(
        plan.slice(i, i + 100).map((c, k) => ({
          jobId: j.id,
          idx: i + k,
          items: c.items,
          chars: c.chars,
        })),
      );
    }
    return j;
  });
  return toSnapshot(job);
}

export async function getJobForUser(jobId: string, userId: string) {
  const [j] = await db
    .select()
    .from(translationJobs)
    .where(and(eq(translationJobs.id, jobId), eq(translationJobs.userId, userId)));
  return j ?? null;
}

/** Most recent job for this ROM (active first), so a reopened tab can resume. */
export async function latestJobForRom(userId: string, gameCode: string, romCrc32: string) {
  const [j] = await db
    .select()
    .from(translationJobs)
    .where(
      and(
        eq(translationJobs.userId, userId),
        eq(translationJobs.gameCode, gameCode),
        eq(translationJobs.romCrc32, romCrc32),
      ),
    )
    .orderBy(desc(translationJobs.createdAt))
    .limit(1);
  return j ?? null;
}

export async function doneResults(jobId: string): Promise<ChunkResult[]> {
  const rows = await db
    .select({ results: translationChunks.results })
    .from(translationChunks)
    .where(and(eq(translationChunks.jobId, jobId), eq(translationChunks.status, "done")))
    .orderBy(asc(translationChunks.idx));
  return rows.flatMap((r) => r.results ?? []);
}

/**
 * Close the job once no chunk is pending/running and set its final status
 * exactly once (guarded by the `released` flag).
 */
export async function finalizeIfDone(tx: Tx, jobId: string): Promise<JobRow | null> {
  const [open] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(translationChunks)
    .where(and(eq(translationChunks.jobId, jobId), inArray(translationChunks.status, ["pending", "running"])));
  if (open.n > 0) return null;

  const [j] = await tx
    .update(translationJobs)
    .set({
      released: true,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
      status: sql`case when ${translationJobs.status} = 'cancelled' then 'cancelled'
                       when ${translationJobs.doneChunks} = 0 then 'failed' else 'done' end`,
    })
    .where(and(eq(translationJobs.id, jobId), eq(translationJobs.released, false)))
    .returning();
  if (!j) return null; // already finalized
  return j;
}

export async function controlJob(jobId: string, userId: string, action: "pause" | "resume" | "cancel") {
  const j = await db.transaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(translationJobs)
      .where(and(eq(translationJobs.id, jobId), eq(translationJobs.userId, userId)))
      .for("update");
    if (!cur) throw new Error("Không tìm thấy job");
    if (!ACTIVE.includes(cur.status)) return cur;

    if (action === "pause") {
      const [u] = await tx.update(translationJobs).set({ status: "paused", updatedAt: sql`now()` })
        .where(eq(translationJobs.id, jobId)).returning();
      return u;
    }
    if (action === "resume") {
      const [u] = await tx.update(translationJobs).set({ status: "running", updatedAt: sql`now()` })
        .where(eq(translationJobs.id, jobId)).returning();
      return u;
    }
    // cancel: drop pending chunks; a running chunk finishes normally
    await tx.update(translationChunks).set({ status: "cancelled", updatedAt: sql`now()` })
      .where(and(eq(translationChunks.jobId, jobId), eq(translationChunks.status, "pending")));
    const [u] = await tx.update(translationJobs).set({ status: "cancelled", updatedAt: sql`now()` })
      .where(eq(translationJobs.id, jobId)).returning();
    return (await finalizeIfDone(tx, jobId)) ?? u;
  });
  jobEvents.emit(jobId, { type: "status", job: toSnapshot(j) });
  return toSnapshot(j);
}
