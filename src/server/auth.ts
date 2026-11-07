import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { oneTap } from "better-auth/plugins";
import { db } from "./database/client";
import * as schema from "./database/schema";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  // Google-only sign-in: one real Google account per user.
  emailAndPassword: { enabled: false },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    },
  },
  // must stay last: copies Set-Cookie into TanStack Start's response
  plugins: [oneTap(), tanstackStartCookies()],
});

export type SessionUser = { id: string; email: string; name: string };

/**
 * Login is on by default. Dev escape hatch: set AUTH_DISABLED=1 and every request runs as one
 * fixed local user.
 */
export const AUTH_DISABLED = process.env.AUTH_DISABLED === "1";

const LOCAL_USER: SessionUser = { id: "local-dev", email: "local@rom-lingo.local", name: "Local" };
let localUser: Promise<SessionUser> | null = null;

function ensureLocalUser(): Promise<SessionUser> {
  return (localUser ??= (async () => {
    const now = new Date();
    await db
      .insert(schema.user)
      .values({ ...LOCAL_USER, emailVerified: true, createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    return LOCAL_USER;
  })().catch((e) => {
    localUser = null; // retry on the next request
    throw e;
  }));
}

/** Current user from request headers, or null. */
export async function getSessionUser(headers: Headers): Promise<SessionUser | null> {
  if (AUTH_DISABLED) return ensureLocalUser();
  const s = await auth.api.getSession({ headers });
  return s ? { id: s.user.id, email: s.user.email, name: s.user.name } : null;
}

export async function requireUser(headers: Headers): Promise<SessionUser> {
  const u = await getSessionUser(headers);
  if (!u) throw new Response("Unauthorized", { status: 401 });
  return u;
}
