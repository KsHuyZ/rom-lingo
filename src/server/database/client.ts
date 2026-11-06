import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

function connectionUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set");
  const u = new URL(raw);
  // `pgbouncer=true` is a Prisma convention; postgres.js would send it as a
  // startup parameter and the server rejects it.
  u.searchParams.delete("pgbouncer");
  return u.toString();
}

// Supabase transaction pooler (port 6543) does not support prepared
// statements, hence `prepare: false`. Reuse one client across dev HMR reloads.
const g = globalThis as unknown as { __romLingoSql?: ReturnType<typeof postgres> };
export const sqlClient =
  g.__romLingoSql ?? (g.__romLingoSql = postgres(connectionUrl(), { prepare: false, max: 8 }));

export const db = drizzle(sqlClient, { schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
