// Server-Sent Events: live progress for one translation job.
// Sends a full snapshot first (so reconnects lose nothing), then deltas.
import { createFileRoute } from "@tanstack/react-router";
import { getSessionUser } from "~/server/auth";
import { jobEvents, type JobEvent } from "~/server/jobs/events";
import { doneResults, getJobForUser, toSnapshot } from "~/server/jobs/service";
import { ensureWorker } from "~/server/jobs/worker";

export const Route = createFileRoute("/api/jobs/$id/events")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        ensureWorker();
        const user = await getSessionUser(request.headers);
        if (!user) return new Response("Unauthorized", { status: 401 });
        if (!/^[0-9a-f-]{36}$/.test(params.id)) return new Response("Not found", { status: 404 });
        const job = await getJobForUser(params.id, user.id);
        if (!job) return new Response("Not found", { status: 404 });

        const enc = new TextEncoder();
        let cleanup = () => {};
        const stream = new ReadableStream<Uint8Array>({
          async start(ctrl) {
            let closed = false;
            const write = (chunk: string) => {
              if (closed) return;
              try {
                ctrl.enqueue(enc.encode(chunk));
              } catch {
                closed = true;
              }
            };
            const send = (e: JobEvent) => write(`data: ${JSON.stringify(e)}\n\n`);

            // subscribe before reading the snapshot so no event falls in the gap;
            // duplicates are harmless (client merges by string id)
            const buffered: JobEvent[] = [];
            let ready = false;
            const off = jobEvents.subscribe(job.id, (e) => (ready ? send(e) : buffered.push(e)));
            const ping = setInterval(() => write(": ping\n\n"), 15_000);
            cleanup = () => {
              closed = true;
              clearInterval(ping);
              off();
            };
            request.signal.addEventListener("abort", () => {
              cleanup();
              try {
                ctrl.close();
              } catch {
                /* already closed */
              }
            });

            const fresh = (await getJobForUser(job.id, user.id)) ?? job;
            send({ type: "snapshot", job: toSnapshot(fresh), results: await doneResults(job.id) });
            ready = true;
            buffered.forEach(send);
          },
          cancel() {
            cleanup();
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no", // nginx: do not buffer SSE
          },
        });
      },
    },
  },
});
