// src/routes/api.posts.ts
// Server-only API route — returns JSON for external consumers.
// Demonstrates TanStack Start API routes alongside UI routes.
import { createFileRoute } from "@tanstack/react-router";
import { getPaginatedPosts } from "~/server/db";

export const Route = createFileRoute("/api/posts")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);

        const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
        const pageSize = Math.max(1, parseInt(url.searchParams.get("pageSize") || "10", 10) || 10);
        const q = url.searchParams.get("q")?.trim() || undefined;
        const sortParam = url.searchParams.get("sort");
        const sort = sortParam === "popular" ? ("popular" as const) : ("newest" as const);

        const data = getPaginatedPosts({
          page,
          pageSize,
          q,
          sort,
        });

        return Response.json(data, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "s-maxage=60, stale-while-revalidate=120",
            "X-SSR-Mode": "api-route",
          },
        });
      },
    },
  },
});
