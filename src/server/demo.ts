import "server-only";

import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { demoAccount } from "@/db/schema";
import { withDemoSignUp, type Auth } from "@/lib/auth";
import {
  DEMO_ACCOUNT_LIMIT,
  DEMO_EMAIL_DOMAIN,
  DEMO_EMAIL_LIKE,
  DEMO_LIFETIME_HOURS,
} from "@/lib/validation/demo";
import type { Db } from "./applications";
import { runAtomic } from "./atomic";
import { rowsOf } from "./board";
import { seedDemoData } from "./demo-seed";

/** createDemoAccount addresses are `demo-` + 24 lower-case hex characters. */
const DEMO_LOCAL_PART_BYTES = 12;
/**
 * Orphan cleanup only matches generated addresses, so an account that signed up publicly with the
 * demo domain before the domain was reserved (T10.1) is never treated as an orphan.
 */
const GENERATED_DEMO_EMAIL_REGEX = `^demo-[0-9a-f]{${DEMO_LOCAL_PART_BYTES * 2}}@demo\\.lafija\\.invalid$`;

export { DEMO_ACCOUNT_LIMIT };

/** Expired demo accounts deleted per cleanup run at most; the rest go in the next run (hourly). */
export const DEMO_CLEANUP_BATCH_SIZE = 500;

/** Serializes the live-demo cap check with the demo row insert (any constant works; this is "laFija"). */
const DEMO_CAP_LOCK = 0x6c61_4669;

export type DemoFailure = "limit" | "rate_limited" | "failed";

export type DemoResult =
  | { ok: true; userId: string; email: string; password: string; expiresAt: Date }
  | { ok: false; reason: DemoFailure };

export type DemoCleanupSummary = { deleted: number };

const DEMO_ERROR_MESSAGES: Record<DemoFailure, string> = {
  limit: "Too many people are trying the demo right now. Please try again later, or create a free account.",
  rate_limited: "Too many demo requests from your network. Please wait a few seconds and try again.",
  failed: "The demo could not be started. Please try again.",
};

export function demoErrorMessage(reason: DemoFailure): string {
  return DEMO_ERROR_MESSAGES[reason];
}

async function countLiveDemos(db: Db, now: Date): Promise<number> {
  const [row] = rowsOf<{ live: number }>(
    await db.execute(
      sql`select count(*)::int as "live" from "demo_account" where "expires_at" > ${now.toISOString()}::timestamptz`,
    ),
  );
  return row?.live ?? 0;
}

/**
 * Undoes a demo sign-up that never became a usable demo (cap reached at the last moment, or the
 * seed failed): deletes that one user, and only while its address has the demo domain.
 */
async function discardDemoUser(db: Db, userId: string): Promise<void> {
  await db.execute(sql`delete from "user" where "id" = ${userId} and "email" like ${DEMO_EMAIL_LIKE}`);
}

/**
 * "Try the demo" (S6). Creates a user `demo-<random>@demo.lafija.invalid` with a random password,
 * its `demo_account` row and the sample search, and returns the credentials so the caller can sign
 * in. Abuse limits:
 * - the global cap: no more than `limit` (200) live demo accounts; checked before anything is
 *   written, and again under a transaction-scoped advisory lock when the demo row is inserted;
 * - Better Auth rate limiting: the sign-up goes through Better Auth's HTTP handler
 *   (`auth.handler`, POST /api/auth/sign-up/email) with the visitor's `x-forwarded-for`, so the
 *   built-in per-IP rule for /sign-up (3 requests per 10 s, better-auth
 *   dist/api/rate-limiter/index.mjs `getDefaultSpecialRules`) applies; direct `auth.api` calls skip
 *   it (dist/api/index.mjs:175 only runs it in the router). Rate limiting is on in production only.
 * No email is ever sent: the verification sender skips demo addresses (`src/lib/email/verification.ts`).
 * Public sign-up refuses the demo domain; this sign-up runs inside `withDemoSignUp(email)`, the
 * in-process marker that lets Better Auth's `user.create.before` hook accept this one address.
 */
export async function createDemoAccount(
  auth: Auth,
  db: Db,
  {
    baseURL,
    clientIp,
    now = new Date(),
    limit = DEMO_ACCOUNT_LIMIT,
  }: { baseURL: string; clientIp: string | null; now?: Date; limit?: number },
): Promise<DemoResult> {
  if ((await countLiveDemos(db, now)) >= limit) return { ok: false, reason: "limit" };

  const email = `demo-${randomBytes(DEMO_LOCAL_PART_BYTES).toString("hex")}@${DEMO_EMAIL_DOMAIN}`;
  const password = randomBytes(24).toString("base64url");
  const headers = new Headers({ "content-type": "application/json", origin: new URL(baseURL).origin });
  if (clientIp) headers.set("x-forwarded-for", clientIp);
  const response = await withDemoSignUp(email, () =>
    auth.handler(
      new Request(new URL("/api/auth/sign-up/email", baseURL), {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Demo user", email, password }),
      }),
    ),
  );
  if (response.status === 429) return { ok: false, reason: "rate_limited" };
  if (!response.ok) return { ok: false, reason: "failed" };
  const body = (await response.json()) as { user?: { id?: unknown } };
  const userId = body.user?.id;
  if (typeof userId !== "string") return { ok: false, reason: "failed" };

  const at = now.toISOString();
  const [, inserted] = await runAtomic(db, [
    sql`select pg_advisory_xact_lock(${DEMO_CAP_LOCK})`,
    sql`insert into "demo_account" ("user_id", "email", "created_at", "expires_at")
      select ${userId}, ${email}, ${at}::timestamptz,
        ${at}::timestamptz + make_interval(hours => ${DEMO_LIFETIME_HOURS})
      where (select count(*) from "demo_account" where "expires_at" > ${at}::timestamptz) < ${limit}
      returning "expires_at" as "expiresAt"`,
  ]);
  const row = (inserted as { expiresAt: string | Date }[])[0];
  if (!row) {
    await discardDemoUser(db, userId);
    return { ok: false, reason: "limit" };
  }

  try {
    await seedDemoData(db, userId, now);
  } catch (error) {
    console.error("Demo seed failed:", error instanceof Error ? error.name : "unknown error");
    await discardDemoUser(db, userId);
    return { ok: false, reason: "failed" };
  }
  return { ok: true, userId, email, password, expiresAt: new Date(row.expiresAt) };
}

/** The user's demo row and the milliseconds left before cleanup (database clock), or null for a real account. */
export async function getDemoAccount(
  db: Db,
  userId: string,
): Promise<{ createdAt: Date; expiresAt: Date; msLeft: number } | null> {
  const [row] = await db
    .select({
      createdAt: demoAccount.createdAt,
      expiresAt: demoAccount.expiresAt,
      msLeft: sql<number>`greatest(0, floor(extract(epoch from (${demoAccount.expiresAt} - now())) * 1000))::float8`,
    })
    .from(demoAccount)
    .where(eq(demoAccount.userId, userId));
  return row ? { ...row, msLeft: Number(row.msLeft) } : null;
}

/**
 * Deletes expired demo accounts (S6, S23) in one statement. Candidates are
 * - users with a `demo_account` row whose `expires_at` is before `now`, and
 * - orphans (T10.1): demo-domain users with NO `demo_account` row created more than 24 hours before
 *   `now` (a crash between the demo sign-up and its demo row). Public sign-up refuses the demo
 *   domain (`src/lib/auth.ts`), so every demo-domain user was created by `createDemoAccount`.
 * Oldest due time first (expiry, or created_at + 24 h for an orphan), at most `batchSize` in total.
 * Every deleted user must also have an address in the demo domain (lower case, as Better Auth stores
 * it), so a real account can never match. Foreign keys cascade to all of their data. Returns the count only.
 */
export async function deleteExpiredDemoAccounts(
  db: Db,
  { now = new Date(), batchSize = DEMO_CLEANUP_BATCH_SIZE }: { now?: Date; batchSize?: number } = {},
): Promise<DemoCleanupSummary> {
  const at = now.toISOString();
  const result = await db.execute(sql`
    delete from "user" u
    where u."id" in (
        select c."id" from (
          select d."user_id" as "id", d."expires_at" as "due" from "demo_account" d
          where d."expires_at" < ${at}::timestamptz and d."email" like ${DEMO_EMAIL_LIKE}
          union all
          select o."id", o."created_at" + make_interval(hours => ${DEMO_LIFETIME_HOURS}) from "user" o
          where o."email" like ${DEMO_EMAIL_LIKE}
            and o."email" ~ ${GENERATED_DEMO_EMAIL_REGEX}
            and o."created_at" < ${at}::timestamptz - make_interval(hours => ${DEMO_LIFETIME_HOURS})
            and not exists (select 1 from "demo_account" x where x."user_id" = o."id")
        ) c
        order by c."due", c."id"
        limit ${batchSize}
      )
      and u."email" like ${DEMO_EMAIL_LIKE}
    returning u."id"
  `);
  return { deleted: rowsOf<{ id: string }>(result).length };
}
