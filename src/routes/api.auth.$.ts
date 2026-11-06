// Better Auth endpoints: /api/auth/sign-up/email, /api/auth/sign-in/email, ...
import { createFileRoute } from "@tanstack/react-router";
import { auth } from "~/server/auth";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => auth.handler(request),
      POST: ({ request }) => auth.handler(request),
    },
  },
});
