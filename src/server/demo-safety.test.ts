import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { demoAccount, user } from "@/db/schema";
import { createAuth, type Auth } from "@/lib/auth";
import { createTestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const { createDemoAccount, deleteExpiredDemoAccounts } = await import("./demo");
const { seedDemoData } = await import("./demo-seed");
const { rowsOf } = await import("./board");

// S23: "que el borrado no pueda aplicarse jamás a una cuenta real. Agrega un test que lo demuestre."
// A real account is any user without a demo_account row; the database itself refuses a demo row for
// a real address, and cleanup needs both the row (expired) and the demo email domain.

type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];
let db: TestDb;
let close: () => Promise<void>;
let auth: Auth;
const BASE_URL = "http://localhost:3000";
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  auth = createAuth({
    db,
    secret: "test-secret-with-at-least-thirty-two-chars",
    baseURL: BASE_URL,
    google: { clientId: "id", clientSecret: "secret" },
  });
});

afterAll(async () => {
  await close();
});

async function signUp(email: string): Promise<string> {
  const { user: created } = await auth.api.signUpEmail({
    body: { name: "Real person", email, password: "correct-horse-battery" },
  });
  return created.id;
}

async function demo(createdAt: Date): Promise<string> {
  const result = await createDemoAccount(auth, db, { baseURL: BASE_URL, clientIp: null, now: createdAt });
  if (!result.ok) throw new Error(`demo creation failed: ${result.reason}`);
  return result.userId;
}

/** Postgres SQLSTATE of a driver error, also when Drizzle wraps it in `cause`. */
async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    for (let current: unknown = error; current && typeof current === "object"; current = (current as { cause?: unknown }).cause) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    }
    return "unknown";
  }
  return undefined;
}

/** Every row of every table in `public`, as canonical JSON text, per table. */
async function snapshot(): Promise<Record<string, { owner: string | null; json: string }[]>> {
  const tables = rowsOf<{ name: string }>(
    await db.execute(sql`select table_name as "name" from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`),
  );
  const result: Record<string, { owner: string | null; json: string }[]> = {};
  for (const { name } of tables) {
    const rows = rowsOf<{ json: string }>(
      await db.execute(sql`select to_jsonb(t)::text as "json" from ${sql.identifier(name)} t order by 1`),
    );
    result[name] = rows.map(({ json }) => {
      const row = JSON.parse(json) as Record<string, unknown>;
      const owner = (name === "user" ? row.id : row.user_id) as string | undefined;
      return { owner: owner ?? null, json };
    });
  }
  return result;
}

function without(snap: Awaited<ReturnType<typeof snapshot>>, owners: readonly string[]) {
  return Object.fromEntries(
    Object.entries(snap).map(([table, rows]) => [table, rows.filter((row) => !owners.includes(row.owner ?? ""))]),
  );
}

describe("the database refuses demo rows for real accounts (S23)", () => {
  it("(a) rejects a demo_account row for a real user, whatever email it claims", async () => {
    const realId = await signUp("ana@example.com");
    const before = await snapshot();

    // Its real address fails the domain check; a demo address fails the (user_id, email) foreign key.
    expect(await sqlState(db.insert(demoAccount).values({ userId: realId, email: "ana@example.com" }))).toBe("23514");
    expect(
      await sqlState(db.insert(demoAccount).values({ userId: realId, email: "demo-abc@demo.lafija.invalid" })),
    ).toBe("23503");
    // Upper case does not slip past the lower-case domain check.
    expect(
      await sqlState(db.insert(demoAccount).values({ userId: realId, email: "ANA@DEMO.LAFIJA.INVALID" })),
    ).toBe("23514");
    expect(await snapshot()).toEqual(before);
  });

  it("(b) rejects changing a demo user's email to a real address, and moving or extending its demo row", async () => {
    const realId = await signUp("bruno@example.com");
    const demoId = await demo(new Date());
    const before = await snapshot();

    expect(await sqlState(db.execute(sql`update "user" set "email" = 'bruno2@example.com' where "id" = ${demoId}`))).toBe(
      "23514",
    );
    expect(
      await sqlState(db.execute(sql`update "demo_account" set "email" = 'bruno2@example.com' where "user_id" = ${demoId}`)),
    ).not.toBeUndefined();
    expect(
      await sqlState(db.execute(sql`update "demo_account" set "user_id" = ${realId} where "user_id" = ${demoId}`)),
    ).toBe("23503");
    expect(
      await sqlState(
        db.execute(sql`update "demo_account" set "expires_at" = "expires_at" + interval '1 day' where "user_id" = ${demoId}`),
      ),
    ).toBe("23514");
    expect(await snapshot()).toEqual(before);
  });
});

describe("demo cleanup never touches a real account (S23)", () => {
  let realOldId: string;
  let craftedId: string;
  let upperId: string;
  let expiredIds: string[];
  let liveId: string;

  beforeAll(async () => {
    const longAgo = new Date(Date.now() - 400 * 24 * HOUR);
    // Real users: an old one, one whose address has the demo domain but no demo row (a crafted
    // public sign-up), and one with the domain in upper case inserted behind Better Auth's back.
    realOldId = await signUp("old-real@example.com");
    craftedId = await signUp("crafted@demo.lafija.invalid");
    upperId = "upper-case-real-user";
    await db.insert(user).values({ id: upperId, name: "Upper", email: "SOMEONE@DEMO.LAFIJA.INVALID" });
    for (const id of [realOldId, craftedId, upperId]) {
      await db.execute(sql`update "user" set "created_at" = ${longAgo.toISOString()}::timestamptz where "id" = ${id}`);
      await seedDemoData(db, id, longAgo);
    }
    expiredIds = [await demo(new Date(Date.now() - 25 * HOUR)), await demo(new Date(Date.now() - 72 * HOUR))];
    liveId = await demo(new Date(Date.now() - 23 * HOUR));
  });

  it("(c) deletes exactly the expired demo users and leaves every other row byte-identical", async () => {
    const before = await snapshot();
    // The expired demos really own rows in the tables the cascade must clear.
    for (const table of ["user", "session", "account", "demo_account", "stage", "company", "application",
      "stage_transition", "interview", "contact", "application_contact", "reminder"]) {
      expect(before[table].filter((row) => expiredIds.includes(row.owner ?? "")).length, table).toBeGreaterThan(0);
    }

    expect(await deleteExpiredDemoAccounts(db)).toEqual({ deleted: 2 });

    const after = await snapshot();
    expect(after).toEqual(without(before, expiredIds));
    for (const id of [realOldId, craftedId, upperId, liveId]) {
      expect(after.user.some((row) => row.owner === id), id).toBe(true);
    }
  });

  it("(e) the cascade removed every row of the deleted demo users", async () => {
    const after = await snapshot();
    for (const [table, rows] of Object.entries(after)) {
      expect(rows.filter((row) => expiredIds.includes(row.owner ?? "")), table).toEqual([]);
    }
  });

  it("(d) does nothing while no demo has expired", async () => {
    const before = await snapshot();

    expect(await deleteExpiredDemoAccounts(db)).toEqual({ deleted: 0 });
    expect(await snapshot()).toEqual(before);
  });

  it("deletes a demo only once its 24 hours have passed, and at most one batch per run", async () => {
    const extra = await demo(new Date(Date.now() - 30 * HOUR));
    const before = await snapshot();

    // Batch of one: the oldest expiry goes first (the extra demo), the live one stays.
    expect(await deleteExpiredDemoAccounts(db, { batchSize: 1 })).toEqual({ deleted: 1 });
    expect(await snapshot()).toEqual(without(before, [extra]));
    // An hour before its expiry the live demo survives; two hours later it is gone.
    expect(await deleteExpiredDemoAccounts(db, { now: new Date(Date.now() + 0.5 * HOUR) })).toEqual({ deleted: 0 });
    expect(await deleteExpiredDemoAccounts(db, { now: new Date(Date.now() + 2 * HOUR) })).toEqual({ deleted: 1 });
    const after = await snapshot();
    expect(after).toEqual(without(before, [extra, liveId]));
    for (const id of [realOldId, craftedId, upperId]) {
      expect(after.user.some((row) => row.owner === id), id).toBe(true);
    }
  });

  it("even far in the future, cleanup deletes the remaining demos and no real user", async () => {
    const before = await snapshot();
    const demoIds = before.demo_account.map((row) => row.owner!);
    const realIds = before.user.map((row) => row.owner!).filter((id) => !demoIds.includes(id));
    expect(realIds).toEqual(expect.arrayContaining([realOldId, craftedId, upperId]));

    expect(await deleteExpiredDemoAccounts(db, { now: new Date(Date.now() + 10 * 365 * 24 * HOUR) })).toEqual({
      deleted: demoIds.length,
    });
    const after = await snapshot();
    expect(after).toEqual(without(before, demoIds));
    expect(after.user.map((row) => row.owner).sort()).toEqual([...realIds].sort());
    // Nothing left to delete.
    expect(await deleteExpiredDemoAccounts(db, { now: new Date(Date.now() + 10 * 365 * 24 * HOUR) })).toEqual({
      deleted: 0,
    });
  });
});
