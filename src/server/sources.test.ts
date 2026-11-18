import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { application, stageTransition, user } from "@/db/schema";
import { createTestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const { createApplication, updateApplication, getApplication, listSourceSuggestions } = await import("./applications");

type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];

let db: TestDb;
let close: () => Promise<void>;
let counter = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 30_000);

afterAll(async () => {
  await close();
});

async function newUser() {
  counter += 1;
  const id = `source-user-${counter}`;
  await db.insert(user).values({ id, name: `User ${counter}`, email: `source${counter}@example.com` });
  return id;
}

async function create(userId: string, source: string | undefined, role = "Engineer") {
  const result = await createApplication(db, userId, { companyName: "Acme", role, source });
  if (!result.ok) throw new Error(`create failed: ${JSON.stringify(result)}`);
  return result.application;
}

describe("source normalization on create and edit (S20)", () => {
  it("collapses whitespace and stores the preset spelling for a case-insensitive preset match", async () => {
    const userId = await newUser();
    expect((await create(userId, "  get   ON board ")).source).toBe("Get on Board");
    expect((await create(userId, "LINKEDIN")).source).toBe("LinkedIn");
    expect((await create(userId, "  My   Network ")).source).toBe("My Network");
    expect((await create(userId, "   ")).source).toBeNull();
    expect((await create(userId, undefined)).source).toBeNull();
  });

  it("the user's existing form wins over the preset and over the typed case", async () => {
    const userId = await newUser();
    // An existing form stored before this rule (raw insert, like data the migration left as is).
    const first = await create(userId, "Placeholder");
    await db.update(application).set({ source: "linkedIN" }).where(eqId(first.id));
    expect((await create(userId, "LinkedIn")).source).toBe("linkedIN");
    expect((await create(userId, " LINKEDIN ")).source).toBe("linkedIN");
    expect((await create(userId, "acme jobs")).source).toBe("acme jobs");
    expect((await create(userId, "ACME   Jobs")).source).toBe("acme jobs");
  });

  it("is per user: another user's form never applies", async () => {
    const a = await newUser();
    const b = await newUser();
    expect((await create(a, "Tech Hub")).source).toBe("Tech Hub");
    expect((await create(b, "TECH HUB")).source).toBe("TECH HUB");
    expect((await create(a, "tech hub")).source).toBe("Tech Hub");
  });

  it("an edit uses the form of the user's other applications, not its own previous one", async () => {
    const userId = await newUser();
    const only = await create(userId, "Foo Board");
    // Sole application with that source: the user can change its case.
    const recased = await updateApplication(db, userId, only.id, { companyName: "Acme", role: "Engineer", source: "FOO board" });
    expect(recased).toMatchObject({ ok: true, application: { source: "FOO board" } });

    const other = await create(userId, "Indeed");
    const edited = await updateApplication(db, userId, other.id, { companyName: "Acme", role: "Engineer", source: " foo   BOARD " });
    expect(edited).toMatchObject({ ok: true, application: { source: "FOO board" } });
    const cleared = await updateApplication(db, userId, other.id, { companyName: "Acme", role: "Engineer", source: "  " });
    expect(cleared).toMatchObject({ ok: true, application: { source: null } });
  });

  it("a refused edit changes nothing", async () => {
    const userId = await newUser();
    const app = await create(userId, "LinkedIn");
    const stranger = await newUser();
    const before = JSON.stringify([await db.select().from(application).orderBy(application.id), await db.select().from(stageTransition).orderBy(stageTransition.id)]);
    expect(await updateApplication(db, stranger, app.id, { companyName: "Acme", role: "X", source: "linkedin" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await updateApplication(db, userId, app.id, { companyName: "", role: "X", source: "linkedin" })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    const after = JSON.stringify([await db.select().from(application).orderBy(application.id), await db.select().from(stageTransition).orderBy(stageTransition.id)]);
    expect(after).toBe(before);
    expect((await getApplication(db, userId, app.id))?.source).toBe("LinkedIn");
  });
});

describe("listSourceSuggestions", () => {
  it("returns the user's forms (most used first) then the remaining presets, case-insensitively unique", async () => {
    const userId = await newUser();
    await create(userId, "Referral");
    await create(userId, "Referral");
    await create(userId, "linkedin"); // stored as the preset "LinkedIn"
    await create(userId, "Wellfound");
    const stranger = await newUser();
    await create(stranger, "Secret Board");
    expect(await listSourceSuggestions(db, userId)).toEqual([
      "Referral",
      "LinkedIn",
      "Wellfound",
      "Computrabajo",
      "Bumeran",
      "Get on Board",
      "Indeed",
      "Referido",
    ]);
    expect(await listSourceSuggestions(db, await newUser())).toEqual([
      "LinkedIn",
      "Computrabajo",
      "Bumeran",
      "Get on Board",
      "Indeed",
      "Referido",
    ]);
  });
});

function eqId(id: string) {
  return eq(application.id, id);
}
