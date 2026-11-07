import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------- Better Auth
// Field set mirrors better-auth@1.7.12 getAuthTables().

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------- jobs

export const JOB_STATUSES = ["queued", "running", "paused", "done", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const translationJobs = pgTable(
  "translation_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    gameCode: text("game_code").notNull(),
    romCrc32: text("rom_crc32").notNull(),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    options: jsonb("options").$type<{ diacritics: boolean }>().notNull(),
    totalStrings: integer("total_strings").notNull(),
    doneStrings: integer("done_strings").notNull().default(0),
    flaggedStrings: integer("flagged_strings").notNull().default(0),
    totalChunks: integer("total_chunks").notNull(),
    doneChunks: integer("done_chunks").notNull().default(0),
    failedChunks: integer("failed_chunks").notNull().default(0),
    fallbackChunks: integer("fallback_chunks").notNull().default(0),
    released: boolean("released").notNull().default(false),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("translation_jobs_user_rom_idx").on(t.userId, t.gameCode, t.romCrc32)],
);

export type ChunkItem = {
  id: string;
  kind: string;
  text: string;
  /** byte budget incl. terminator — only enforced for fixed table slots */
  capacity: number;
  fixed: boolean;
  maxLines?: number;
  cols?: number;
  retry?: { prev: string; err: string };
};

export type ChunkResult = {
  id: string;
  text: string;
  ok: boolean;
  issue?: string;
};

export const CHUNK_STATUSES = ["pending", "running", "done", "failed", "cancelled"] as const;

export const translationChunks = pgTable(
  "translation_chunks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => translationJobs.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    status: text("status", { enum: CHUNK_STATUSES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    items: jsonb("items").$type<ChunkItem[]>().notNull(),
    results: jsonb("results").$type<ChunkResult[]>(),
    chars: integer("chars").notNull(),
    provider: text("provider"),
    error: text("error"),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("translation_chunks_job_idx").on(t.jobId, t.idx),
    index("translation_chunks_claim_idx")
      .on(t.status, t.availableAt)
      .where(sql`status in ('pending','running')`),
  ],
);
