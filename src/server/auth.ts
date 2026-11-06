import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { db } from "./database/client";
import * as schema from "./database/schema";
import { grantSignupCredits } from "./credits";
import { creditLedger } from "./database/schema";

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
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    // TODO: requireEmailVerification once an email sender is configured —
    // without it, signup credits can be farmed with throwaway addresses.
  },
  databaseHooks: {
    user: {
      create: {
        after: async (u) => {
          await grantSignupCredits(u.id);
        },
      },
    },
  },
  // must stay last: copies Set-Cookie into TanStack Start's response
  plugins: [tanstackStartCookies()],
});

export type SessionUser = { id: string; email: string; name: string };

/**
 * TEMPORARY: login is off, every request runs as one fixed local user with a huge credit
 * grant. Set AUTH_ENABLED=1 to bring the real sign-in back (nothing else needs to change).
 */
export const AUTH_DISABLED = process.env.AUTH_ENABLED !== "1";

const LOCAL_USER: SessionUser = { id: "local-dev", email: "local@rom-lingo.local", name: "Local" };
let localUser: Promise<SessionUser> | null = null;

function ensureLocalUser(): Promise<SessionUser> {
  return (localUser ??= (async () => {
    const now = new Date();
    await db
      .insert(schema.user)
      .values({ ...LOCAL_USER, emailVerified: true, createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    // unique payment_ref makes the grant happen once
    await db
      .insert(creditLedger)
      .values({ userId: LOCAL_USER.id, delta: 1_000_000_000, kind: "topup", paymentRef: "local-dev-grant", note: "auth disabled" })
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
