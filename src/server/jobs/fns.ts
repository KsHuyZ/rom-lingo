// Server functions called from the /translate page. Every handler resolves
// the user from the session cookie; client-supplied ids are never trusted.
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { AUTH_DISABLED, getSessionUser, requireUser } from "../auth";
import { balanceOf, CREDITS_PER_1K_CHARS, topUp, InsufficientCredits } from "../credits";
import { db } from "../database/client";
import { LIMITS } from "~/lib/job-plan";
import { controlJob, createJob, latestJobForRom, toSnapshot } from "./service";
import { ensureWorker } from "./worker";

const headers = () => new Headers(getRequestHeaders() as HeadersInit);

const ItemSchema = z.object({
  id: z.string().max(64),
  // Pokémon names ("species") are never translated, so the server refuses them
  kind: z.enum(["dialogue", "move", "ability", "item"]),
  text: z.string().max(LIMITS.maxTextLen),
  capacity: z.number().int().min(1).max(4096),
  fixed: z.boolean(),
});

const JobInput = z
  .object({
    gameCode: z.string().regex(/^[A-Z0-9]{4}$/),
    romCrc32: z.string().regex(/^[0-9a-f]{1,8}$/),
    diacritics: z.boolean(),
    items: z.array(ItemSchema).min(1).max(LIMITS.maxItems),
  })
  .refine((v) => v.items.reduce((n, i) => n + i.text.length, 0) <= LIMITS.maxTotalChars, "Quá nhiều text");

export const getAccount = createServerFn({ method: "GET" }).handler(async () => {
  ensureWorker();
  const user = await getSessionUser(headers());
  if (!user) return null;
  return {
    user,
    balance: await balanceOf(db, user.id),
    creditsPer1k: CREDITS_PER_1K_CHARS,
    devTopUp: process.env.NODE_ENV !== "production",
    authDisabled: AUTH_DISABLED,
  };
});

export const startJob = createServerFn({ method: "POST" })
  .validator(JobInput)
  .handler(async ({ data }) => {
    ensureWorker();
    const user = await requireUser(headers());
    try {
      return { ok: true as const, job: await createJob(user.id, data) };
    } catch (e) {
      if (e instanceof InsufficientCredits)
        return { ok: false as const, error: e.message, balance: e.balance, needed: e.needed };
      return { ok: false as const, error: (e as Error).message };
    }
  });

export const findJob = createServerFn({ method: "GET" })
  .validator(z.object({ gameCode: z.string(), romCrc32: z.string() }))
  .handler(async ({ data }) => {
    ensureWorker();
    const user = await getSessionUser(headers());
    if (!user) return null;
    const j = await latestJobForRom(user.id, data.gameCode, data.romCrc32);
    return j ? toSnapshot(j) : null;
  });

export const jobControl = createServerFn({ method: "POST" })
  .validator(z.object({ jobId: z.string().uuid(), action: z.enum(["pause", "resume", "cancel"]) }))
  .handler(async ({ data }) => {
    const user = await requireUser(headers());
    return controlJob(data.jobId, user.id, data.action);
  });

/** Stand-in for the payment gateway until it is chosen. Disabled in production. */
export const devTopUp = createServerFn({ method: "POST" }).handler(async () => {
  if (process.env.NODE_ENV === "production") throw new Error("Not available");
  const user = await requireUser(headers());
  await topUp(user.id, 1000, `dev:${user.id}:${Date.now()}`, "dev top-up");
  return { balance: await balanceOf(db, user.id) };
});
