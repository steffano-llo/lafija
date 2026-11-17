import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { demoAccount } from "@/db/schema";
import { createAuth, withDemoSignUp, type Auth } from "@/lib/auth";
import { createTestDb } from "@/test/db";

vi.mock("server-only", () => ({}));
const seedControl = vi.hoisted(() => ({ fail: false }));
vi.mock("./demo-seed", async (importOriginal) => {
  const original = await importOriginal<typeof import("./demo-seed")>();
  return {
    ...original,
    seedDemoData: async (...args: Parameters<typeof original.seedDemoData>) => {
      if (seedControl.fail) throw new Error("seed boom");
      return original.seedDemoData(...args);
    },
  };
});

const { createDemoAccount, deleteExpiredDemoAccounts } = await import("./demo");
const { seedDemoData } = await import("./demo-seed");
const { rowsOf } = await import("./board");

type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];
let db: TestDb;
let close: () => Promise<void>;
let auth: Auth;
const BASE_URL = "http://localhost:3000";

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  auth = createAuth({
    db,
    secret: "test-secret-with-at-least-thirty-two-chars",
    baseURL: BASE_URL,
    google: { clientId: "id", clientSecret: "s" },
  });
});
afterAll(async () => close());

/** Every row of every public table, for byte-identical comparisons. */
async function snapshot() {
  const tables = rowsOf<{ name: string }>(
    await db.execute(
      sql`select table_name as "name" from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1`,
    ),
  );
  const out: Record<string, string[]> = {};
  for (const { name } of tables) {
    out[name] = rowsOf<{ j: string }>(
      await db.execute(sql`select to_jsonb(t)::text as "j" from ${sql.identifier(name)} t order by 1`),
    ).map((r) => r.j);
  }
  return out;
}
const userIds = async () => rowsOf<{ id: string; email: string }>(await db.execute(sql`select id, email from "user" order by id`));

describe("T10 verifier probes", () => {
  it("rollback after a seed failure deletes only the new demo user; every other row stays byte-identical", async () => {
    const { user: real } = await auth.api.signUpEmail({
      body: { name: "R", email: "keep@example.com", password: "correct-horse-battery" },
    });
    await seedDemoData(db, real.id, new Date());
    const before = await snapshot();
    seedControl.fail = true;
    try {
      await expect(createDemoAccount(auth, db, { baseURL: BASE_URL, clientIp: null })).resolves.toEqual({
        ok: false,
        reason: "failed",
      });
    } finally {
      seedControl.fail = false;
    }
    expect(await snapshot()).toEqual(before);
  });

  // T10.1: public sign-up now refuses the demo domain, so there is no crafted demo-domain user to keep.
  it("public sign-up with the demo domain in any case is refused and writes nothing", async () => {
    const before = await snapshot();
    await expect(
      auth.api.signUpEmail({ body: { name: "C", email: "Mixed@Demo.Lafija.Invalid", password: "correct-horse-battery" } }),
    ).rejects.toMatchObject({ statusCode: 400, body: { code: "EMAIL_DOMAIN_RESERVED", message: "This email domain is reserved." } });
    expect(await snapshot()).toEqual(before);
  });

  // T10.1 closes the former GAP: no public demo-domain user exists to attach a demo row to.
  it("FIXED GAP: a public demo-domain sign-up is refused (HTTP route and auth.api), so no demo row can be attached", async () => {
    const before = await snapshot();
    const res = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({ name: "C2", email: "crafted2@demo.lafija.invalid", password: "correct-horse-battery" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "EMAIL_DOMAIN_RESERVED", message: "This email domain is reserved." });
    await expect(
      auth.api.signUpEmail({ body: { name: "C2", email: "crafted2@demo.lafija.invalid", password: "correct-horse-battery" } }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await snapshot()).toEqual(before);
    expect((await userIds()).some((u) => u.email === "crafted2@demo.lafija.invalid")).toBe(false);
    await expect(
      db.insert(demoAccount).values({ userId: "no-such-user", email: "crafted2@demo.lafija.invalid" }),
    ).rejects.toBeDefined();
  });

  it("a signed-in demo user cannot change its email through Better Auth", async () => {
    const demo = await createDemoAccount(auth, db, { baseURL: BASE_URL, clientIp: null });
    if (!demo.ok) throw new Error(demo.reason);
    const { headers } = await auth.api.signInEmail({
      body: { email: demo.email, password: demo.password },
      returnHeaders: true,
    });
    const cookie = headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    await expect(
      auth.api.changeEmail({ body: { newEmail: "victim@example.com" }, headers: new Headers({ cookie }) }),
    ).rejects.toBeDefined();
    await auth.api
      .updateUser({ body: { email: "victim@example.com" } as never, headers: new Headers({ cookie }) })
      .catch(() => undefined);
    expect((await userIds()).find((u) => u.id === demo.userId)!.email).toBe(demo.email);
  });

  // T10.1 closes the former ORPHAN gap. The orphans are made the way a crash would leave them: the
  // internal demo sign-up succeeded (inside withDemoSignUp) and the demo row was never written.
  it("FIXED ORPHAN: a demo-domain user without a demo row is cleaned once older than 24 h, kept before", async () => {
    const orphan = async (email: string) => {
      const res = await withDemoSignUp(email, () =>
        auth.handler(
          new Request(`${BASE_URL}/api/auth/sign-up/email`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: BASE_URL },
            body: JSON.stringify({ name: "Demo user", email, password: "correct-horse-battery" }),
          }),
        ),
      );
      expect(res.ok).toBe(true);
    };
    await orphan("demo-0123456789abcdef01234567@demo.lafija.invalid");
    await orphan("demo-89abcdef0123456789abcdef@demo.lafija.invalid");
    await db.execute(sql`update "user" set "created_at" = now() - interval '25 hours' where email = 'demo-0123456789abcdef01234567@demo.lafija.invalid'`);
    await db.execute(sql`update "user" set "created_at" = now() - interval '23 hours' where email = 'demo-89abcdef0123456789abcdef@demo.lafija.invalid'`);

    await deleteExpiredDemoAccounts(db);

    const emails = (await userIds()).map((u) => u.email);
    expect(emails).not.toContain("demo-0123456789abcdef01234567@demo.lafija.invalid");
    expect(emails).toContain("demo-89abcdef0123456789abcdef@demo.lafija.invalid");
  });

  it("rate limit: a multi-value x-forwarded-for falls into one shared bucket (advisory off Vercel)", async () => {
    const limited = createAuth({
      db,
      secret: "test-secret-with-at-least-thirty-two-chars",
      baseURL: BASE_URL,
      google: { clientId: "id", clientSecret: "s" },
      rateLimit: { enabled: true },
    });
    const results = [];
    for (const ip of ["1.1.1.1, 9.9.9.1", "2.2.2.2, 9.9.9.2", "3.3.3.3, 9.9.9.3", "4.4.4.4, 9.9.9.4"]) {
      results.push((await createDemoAccount(limited, db, { baseURL: BASE_URL, clientIp: ip })).ok);
    }
    expect(results).toEqual([true, true, true, false]);
  });
});
