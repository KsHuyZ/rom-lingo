// Server functions called from the translate page ("/"). Every handler resolves
// the user from the session cookie; client-supplied ids are never trusted.
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { AUTH_DISABLED, getSessionUser, requireUser } from "../auth";
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
  maxLines: z.number().int().min(1).max(64).optional(),
  cols: z.number().int().min(1).max(512).optional(),
  retry: z.object({ prev: z.string().max(LIMITS.maxTextLen * 2), err: z.string().max(600) }).optional(),
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
