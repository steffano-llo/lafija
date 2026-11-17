import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { user } from "@/db/schema";
import { createAuth, withDemoSignUp, type Auth } from "@/lib/auth";
import { createTestDb } from "@/test/db";

vi.mock("server-only", () => ({}));
const { createDemoAccount, deleteExpiredDemoAccounts } = await import("./demo");
const { rowsOf } = await import("./board");

type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];
let db: TestDb;
let close: () => Promise<void>;
let auth: Auth;
const BASE_URL = "http://localhost:3000";
const HOUR = 3_600_000;
const PW = "correct-horse-battery";

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
const httpSignUp = (email: string, headers: Record<string, string> = {}) =>
  auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL, ...headers },
      body: JSON.stringify({ name: "X", email, password: PW }),
    }),
  );
const emails = async () => rowsOf<{ email: string }>(await db.execute(sql`select email from "user"`)).map((r) => r.email);

describe("T10.1 verifier probes (S23)", () => {
  it("refuses the demo domain on every public creation path, in any case, writing nothing", async () => {
    const before = await snapshot();
    for (const email of ["a@demo.lafija.invalid", "B@DEMO.LAFIJA.INVALID", "c@Demo.Lafija.Invalid"]) {
      const res = await httpSignUp(email, { "x-demo-sign-up": email, cookie: "demo=1" });
      expect(res.status, email).toBe(400);
      expect(await res.json()).toMatchObject({ code: "EMAIL_DOMAIN_RESERVED", message: "This email domain is reserved." });
      await expect(auth.api.signUpEmail({ body: { name: "X", email, password: PW } })).rejects.toBeDefined();
    }
    // Email sign-up reaches internalAdapter.createUser through the routes above; Google reaches createOAuthUser.
    const ctx = await auth.$context;
    await expect(
      ctx.internalAdapter.createOAuthUser(
        { name: "G", email: "g@demo.lafija.invalid", emailVerified: true },
        { providerId: "google", accountId: "g-1" },
      ),
    ).rejects.toBeDefined();
    expect(await snapshot()).toEqual(before);
  });

  it("the marker allows exactly its own address and does not leak into concurrent sign-ups", async () => {
    const [own, other, concurrent] = await Promise.all([
      withDemoSignUp("demo-own@demo.lafija.invalid", () => httpSignUp("demo-own@demo.lafija.invalid")),
      withDemoSignUp("demo-own2@demo.lafija.invalid", () => httpSignUp("demo-other@demo.lafija.invalid")),
      httpSignUp("demo-conc@demo.lafija.invalid"),
    ]);
    expect([own.status, other.status, concurrent.status]).toEqual([200, 400, 400]);
    expect((await emails()).filter((e) => e.endsWith("@demo.lafija.invalid"))).toEqual(["demo-own@demo.lafija.invalid"]);
    const demo = await createDemoAccount(auth, db, { baseURL: BASE_URL, clientIp: null });
    expect(demo.ok).toBe(true);
  });

  it("orphans: only lower-case demo-domain users without a demo row older than 24 h; real rows byte-identical", async () => {
    await db.execute(sql`delete from "user" where email like '%@demo.lafija.invalid'`);
    const now = new Date();
    const at = (ms: number) => new Date(now.getTime() - ms);
    await db.insert(user).values([
      { id: "o-young", name: "o", email: "o-young@demo.lafija.invalid", createdAt: at(24 * HOUR - 60_000) },
      { id: "o-old", name: "o", email: "o-old@demo.lafija.invalid", createdAt: at(24 * HOUR + 60_000) },
      { id: "r-upper", name: "r", email: "R@DEMO.LAFIJA.INVALID", createdAt: at(9000 * HOUR) },
      { id: "r-sub", name: "r", email: "r@sub.demo.lafija.invalid", createdAt: at(9000 * HOUR) },
      { id: "r-suffix", name: "r", email: "r@demo.lafija.invalid.example.com", createdAt: at(9000 * HOUR) },
      { id: "r-other", name: "r", email: "r@notdemo.lafija.invalid", createdAt: at(9000 * HOUR) },
      { id: "r-real", name: "r", email: "r@example.com", createdAt: at(9000 * HOUR) },
    ]);
    expect(await deleteExpiredDemoAccounts(db, { now })).toEqual({ deleted: 1 });
    expect(await emails()).not.toContain("o-old@demo.lafija.invalid");
    expect(await emails()).toContain("o-young@demo.lafija.invalid");
    await db.execute(sql`delete from "user" where id = 'o-young'`);
    const before = await snapshot();
    expect(await deleteExpiredDemoAccounts(db, { now: new Date(now.getTime() + 3650 * 24 * HOUR) })).toEqual({ deleted: 0 });
    expect(await snapshot()).toEqual(before);
  });

  it("a signed-in user cannot move its email into the demo domain", async () => {
    await auth.api.signUpEmail({ body: { name: "R", email: "mover@example.com", password: PW } });
    const { headers } = await auth.api.signInEmail({
      body: { email: "mover@example.com", password: PW },
      returnHeaders: true,
    });
    const cookie = new Headers({
      cookie: headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; "),
    });
    await expect(
      auth.api.updateUser({ body: { email: "mover@demo.lafija.invalid" } as never, headers: cookie }),
    ).rejects.toBeDefined();
    await expect(
      auth.api.changeEmail({ body: { newEmail: "mover@demo.lafija.invalid" }, headers: cookie }),
    ).rejects.toBeDefined();
    expect(await emails()).toContain("mover@example.com");
  });
});
