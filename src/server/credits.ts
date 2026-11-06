// Credit ledger. All balance-changing paths take a per-user advisory lock
// inside their transaction, so concurrent job creations cannot overdraw.
import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "./database/client";
import { creditLedger } from "./database/schema";

export const CREDITS_PER_1K_CHARS = Number(process.env.CREDITS_PER_1K_CHARS ?? 1);
const SIGNUP_CREDITS = Number(process.env.SIGNUP_CREDITS ?? 200);

export class InsufficientCredits extends Error {
  constructor(
    public readonly balance: number,
    public readonly needed: number,
  ) {
    super(`Không đủ credit: cần ${needed}, còn ${balance}`);
  }
}

export async function lockUser(tx: Tx, userId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"credits:" + userId}))`);
}

export async function balanceOf(tx: Tx | typeof db, userId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${creditLedger.delta}), 0)` })
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId));
  return Number(row?.total ?? 0);
}

export async function grantSignupCredits(userId: string) {
  if (SIGNUP_CREDITS <= 0) return;
  // payment_ref UNIQUE makes this idempotent if the hook ever fires twice
  await db
    .insert(creditLedger)
    .values({ userId, delta: SIGNUP_CREDITS, kind: "signup", paymentRef: `signup:${userId}` })
    .onConflictDoNothing();
}

/** Hold credits for a job. Must run inside the transaction that creates it. */
export async function reserve(tx: Tx, userId: string, jobId: string, amount: number) {
  await lockUser(tx, userId);
  const balance = await balanceOf(tx, userId);
  if (balance < amount) throw new InsufficientCredits(balance, amount);
  await tx.insert(creditLedger).values({ userId, delta: -amount, kind: "reserve", jobId });
}

/** Return the unused part of a reservation. Caller guarantees once-only. */
export async function release(tx: Tx, userId: string, jobId: string, amount: number) {
  if (amount <= 0) return;
  await lockUser(tx, userId);
  await tx.insert(creditLedger).values({ userId, delta: amount, kind: "release", jobId });
}

/**
 * Add purchased credits. `paymentRef` is the gateway's transaction id; a
 * replayed webhook hits the UNIQUE constraint and is ignored.
 * Returns false if this payment was already credited.
 */
export async function topUp(userId: string, amount: number, paymentRef: string, note?: string) {
  const rows = await db
    .insert(creditLedger)
    .values({ userId, delta: amount, kind: "topup", paymentRef, note })
    .onConflictDoNothing()
    .returning({ id: creditLedger.id });
  return rows.length > 0;
}
