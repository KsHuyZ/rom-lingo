// In-process pub/sub for job progress. Fine for a single server instance;
// with several instances, swap for Postgres LISTEN/NOTIFY (needs a session
// connection — Supabase's transaction pooler does not support it).
import { EventEmitter } from "node:events";
import type { ChunkResult, JobStatus } from "../database/schema";

export type JobSnapshot = {
  id: string;
  status: JobStatus;
  totalStrings: number;
  doneStrings: number;
  flaggedStrings: number;
  totalChunks: number;
  doneChunks: number;
  failedChunks: number;
  fallbackChunks: number;
  creditsReserved: number;
  creditsUsed: number;
  error: string | null;
  createdAt: string;
};

export type JobEvent =
  | { type: "snapshot"; job: JobSnapshot; results: ChunkResult[] }
  | { type: "chunk"; job: JobSnapshot; chunkIdx: number; provider: string; results: ChunkResult[] }
  | { type: "status"; job: JobSnapshot };

const g = globalThis as unknown as { __romLingoJobEvents?: EventEmitter };
const bus = (g.__romLingoJobEvents ??= new EventEmitter().setMaxListeners(0));

export const jobEvents = {
  emit(jobId: string, e: JobEvent) {
    bus.emit(jobId, e);
  },
  subscribe(jobId: string, fn: (e: JobEvent) => void) {
    bus.on(jobId, fn);
    return () => void bus.off(jobId, fn);
  },
};
