import { defineConfig } from "drizzle-kit";

// Migrations run over Supabase's *session* pooler (port 5432): the transaction
// pooler (6543) used by the app cannot run multi-statement migrations safely.
function migrationUrl(): string {
  const u = new URL(process.env.DIRECT_URL || process.env.DATABASE_URL!);
  u.searchParams.delete("pgbouncer");
  if (u.hostname.endsWith(".pooler.supabase.com") && u.port === "6543") u.port = "5432";
  return u.toString();
}

export default defineConfig({
  schema: "./src/server/database/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: migrationUrl() },
});
