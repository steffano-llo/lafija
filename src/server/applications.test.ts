import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { application, company, user } from "@/db/schema";
import { createTestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const {
  createApplication,
  findOrCreateCompany,
  getApplication,
  listApplications,
  listCompanies,
  setApplicationArchived,
  updateApplication,
} = await import("./applications");

type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];

let db: TestDb;
let close: () => Promise<void>;
let counter = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

/** A fresh user per test keeps the tests independent on the shared in-memory database. */
async function newUser() {
  counter += 1;
  const id = `user-${counter}`;
  await db.insert(user).values({ id, name: `User ${counter}`, email: `user${counter}@example.com` });
  return id;
}

async function create(userId: string, input: Record<string, unknown>) {
  const result = await createApplication(db, userId, input);
  if (!result.ok) throw new Error(`create failed: ${JSON.stringify(result)}`);
  return result.application;
}

describe("createApplication", () => {
  it("stores the application with its company and lists it", async () => {
    const userId = await newUser();

    const result = await createApplication(db, userId, {
      companyName: " Acme ",
      role: "Frontend Engineer",
      url: "https://acme.com/jobs/1",
      source: "LinkedIn",
      salaryRange: "50k-60k",
      salaryCurrency: "USD",
      appliedAt: "2024-05-01",
    });

    expect(result).toEqual({
      ok: true,
      application: expect.objectContaining({
        companyName: "Acme",
        role: "Frontend Engineer",
        url: "https://acme.com/jobs/1",
        source: "LinkedIn",
        salaryRange: "50k-60k",
        salaryCurrency: "USD",
        appliedAt: "2024-05-01",
        archived: false,
      }),
    });
    expect(await listApplications(db, userId)).toEqual([result.ok && result.application]);
    expect(await listCompanies(db, userId)).toEqual([expect.objectContaining({ name: "Acme" })]);
  });

  it("returns field errors and stores nothing when the input is invalid", async () => {
    const userId = await newUser();

    const result = await createApplication(db, userId, { companyName: "Acme", role: "", url: "ftp://acme.com" });

    expect(result).toEqual({
      ok: false,
      reason: "invalid",
      fieldErrors: { role: ["Role is required."], url: ["Enter a valid http(s) URL."] },
    });
    expect(await listApplications(db, userId)).toEqual([]);
    expect(await listApplications(db, userId, { archived: true })).toEqual([]);
    expect(await listCompanies(db, userId)).toEqual([]);
  });
});

describe("findOrCreateCompany", () => {
  it("reuses the user's company regardless of case and spacing", async () => {
    const userId = await newUser();

    const first = await findOrCreateCompany(db, userId, "Acme");
    const second = await findOrCreateCompany(db, userId, "ACME");
    const a = await create(userId, { companyName: " acme ", role: "Backend" });

    expect(second.id).toBe(first.id);
    expect(a.companyId).toBe(first.id);
    // The first spelling is kept.
    expect(a.companyName).toBe("Acme");
    expect(await listCompanies(db, userId)).toEqual([expect.objectContaining({ id: first.id, name: "Acme" })]);
  });

  it("never shares a company between users", async () => {
    const alice = await newUser();
    const bob = await newUser();

    const aliceAcme = await findOrCreateCompany(db, alice, "Acme");
    const bobAcme = await findOrCreateCompany(db, bob, "acme");

    expect(bobAcme.id).not.toBe(aliceAcme.id);
    expect(bobAcme.name).toBe("acme");
    expect(await listCompanies(db, alice)).toEqual([expect.objectContaining({ id: aliceAcme.id, name: "Acme" })]);
    expect(await listCompanies(db, bob)).toEqual([expect.objectContaining({ id: bobAcme.id, name: "acme" })]);
  });
});

describe("listApplications", () => {
  it("lists active applications by default and archived ones on request, newest applied first", async () => {
    const userId = await newUser();
    const older = await create(userId, { companyName: "Acme", role: "Old", appliedAt: "2024-01-10" });
    const undated = await create(userId, { companyName: "Acme", role: "Undated" });
    const newer = await create(userId, { companyName: "Globex", role: "New", appliedAt: "2024-03-01" });
    const archived = await create(userId, { companyName: "Initech", role: "Gone" });
    await setApplicationArchived(db, userId, archived.id, true);

    expect((await listApplications(db, userId)).map((a) => a.id)).toEqual([newer.id, older.id, undated.id]);
    expect((await listApplications(db, userId, { archived: true })).map((a) => a.id)).toEqual([archived.id]);
  });
});

describe("updateApplication", () => {
  it("updates the fields and moves the application to the found-or-created company", async () => {
    const userId = await newUser();
    const created = await create(userId, { companyName: "Acme", role: "Frontend", source: "LinkedIn" });
    const globex = await findOrCreateCompany(db, userId, "Globex");

    const result = await updateApplication(db, userId, created.id, {
      companyName: "GLOBEX",
      role: "Staff Frontend",
      url: "https://globex.com/careers",
      source: "",
      salaryRange: "70k",
      salaryCurrency: "EUR",
      appliedAt: "2024-04-02",
    });

    const expected = {
      ...created,
      companyId: globex.id,
      companyName: "Globex",
      role: "Staff Frontend",
      url: "https://globex.com/careers",
      source: null,
      salaryRange: "70k",
      salaryCurrency: "EUR",
      appliedAt: "2024-04-02",
      updatedAt: expect.any(Date),
    };
    expect(result).toEqual({ ok: true, application: expected });
    expect(await getApplication(db, userId, created.id)).toEqual(expected);
  });

  it("returns field errors and leaves the stored application unchanged", async () => {
    const userId = await newUser();
    const created = await create(userId, { companyName: "Acme", role: "Frontend" });

    const result = await updateApplication(db, userId, created.id, {
      companyName: "Globex",
      role: "Frontend",
      appliedAt: "2999-01-01",
    });

    expect(result).toEqual({
      ok: false,
      reason: "invalid",
      fieldErrors: { appliedAt: ["Applied date cannot be in the future."] },
    });
    expect(await getApplication(db, userId, created.id)).toEqual(created);
    expect(await listCompanies(db, userId)).toEqual([expect.objectContaining({ name: "Acme" })]);
  });

  it("returns not found for an unknown id and creates no company", async () => {
    const userId = await newUser();

    expect(await updateApplication(db, userId, "missing", { companyName: "Acme", role: "X" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await listCompanies(db, userId)).toEqual([]);
  });
});

describe("setApplicationArchived", () => {
  it("archives and unarchives an application", async () => {
    const userId = await newUser();
    const created = await create(userId, { companyName: "Acme", role: "Frontend" });

    const archived = await setApplicationArchived(db, userId, created.id, true);
    expect(archived).toEqual({ ok: true, application: { ...created, archived: true, updatedAt: expect.any(Date) } });
    expect(await listApplications(db, userId)).toEqual([]);
    expect(await getApplication(db, userId, created.id)).toMatchObject({ archived: true });

    const restored = await setApplicationArchived(db, userId, created.id, false);
    expect(restored).toMatchObject({ ok: true, application: { archived: false } });
    expect((await listApplications(db, userId)).map((a) => a.id)).toEqual([created.id]);
  });

  it("returns not found for an unknown id", async () => {
    const userId = await newUser();
    expect(await setApplicationArchived(db, userId, "missing", true)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("per-user isolation", () => {
  it("keeps another user's application out of reach", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const own = await create(alice, { companyName: "Acme", role: "Frontend", appliedAt: "2024-05-01" });

    expect(await listApplications(db, bob)).toEqual([]);
    expect(await listApplications(db, bob, { archived: true })).toEqual([]);
    expect(await getApplication(db, bob, own.id)).toBeNull();
    expect(await updateApplication(db, bob, own.id, { companyName: "Evil Corp", role: "Hijacked" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await setApplicationArchived(db, bob, own.id, true)).toEqual({ ok: false, reason: "not_found" });

    expect(await getApplication(db, alice, own.id)).toEqual(own);
    expect(await listApplications(db, alice)).toEqual([own]);
    expect(await listCompanies(db, alice)).toEqual([expect.objectContaining({ name: "Acme" })]);
    expect(await listCompanies(db, bob)).toEqual([]);
  });

  it("deletes a user's companies and applications with the user", async () => {
    const userId = await newUser();
    const created = await create(userId, { companyName: "Acme", role: "Frontend" });

    await db.delete(user).where(eq(user.id, userId));

    expect(await getApplication(db, userId, created.id)).toBeNull();
    expect(await listCompanies(db, userId)).toEqual([]);
  });
});

describe("per-user isolation regressions", () => {
  async function snapshot() {
    return JSON.stringify([
      await db.select().from(application).orderBy(application.id),
      await db.select().from(company).orderBy(company.id),
    ]);
  }

  it("refuses to move another user's application to their company name, with no side effects", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const own = await create(alice, { companyName: "OnlyAlice", role: "R" });
    await findOrCreateCompany(db, alice, "SecretAlice");
    const before = await snapshot();

    expect(await updateApplication(db, bob, own.id, { companyName: "SecretAlice", role: "X" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await snapshot()).toBe(before);
  });

  it("database rejects an application pointing at another user's company", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const own = await create(alice, { companyName: "C1", role: "R" });
    const bobsCompany = await findOrCreateCompany(db, bob, "C2");

    await expect(
      db.update(application).set({ companyId: bobsCompany.id }).where(eq(application.id, own.id)),
    ).rejects.toThrow();
  });

  it("concurrent find-or-create yields one company", async () => {
    const userId = await newUser();
    const rows = await Promise.all(["Race", "race", "RACE ", " Race"].map((name) => findOrCreateCompany(db, userId, name)));

    expect(new Set(rows.map((row) => row.id)).size).toBe(1);
    expect(await listCompanies(db, userId)).toHaveLength(1);
  });
});
