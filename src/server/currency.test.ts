import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { application, company, user, userSettings } from "@/db/schema";
import { createTestDb } from "@/test/db";
import { formatSalary } from "@/components/applications/format";
import { CURRENCIES } from "@/lib/validation/settings";

vi.mock("server-only", () => ({}));

const { createApplication, updateApplication, listApplications, getApplication } = await import("./applications");
const { getUserSettings, setDefaultCurrency } = await import("./settings");

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

async function newUser() {
  counter += 1;
  const id = `currency-user-${counter}`;
  await db.insert(user).values({ id, name: `User ${counter}`, email: `currency${counter}@example.com` });
  return id;
}

async function snapshot() {
  return JSON.stringify([
    await db.select().from(company).orderBy(company.id),
    await db.select().from(application).orderBy(application.id),
    await db.select().from(userSettings).orderBy(userSettings.userId),
  ]);
}

const base = { companyName: "Acme", role: "Engineer" };

describe("salary currency", () => {
  it("stores the currency with the salary and shows them together", async () => {
    const userId = await newUser();
    const result = await createApplication(db, userId, { ...base, salaryRange: "50k-60k", salaryCurrency: "EUR" });
    expect(result).toEqual({
      ok: true,
      application: expect.objectContaining({ salaryRange: "50k-60k", salaryCurrency: "EUR" }),
    });
    const [listed] = await listApplications(db, userId);
    expect(formatSalary(listed.salaryRange, listed.salaryCurrency)).toBe("50k-60k EUR");
  });

  it("requires a currency when a salary is given, and stores nothing", async () => {
    const userId = await newUser();
    const before = await snapshot();
    for (const salaryCurrency of [undefined, "", "  "]) {
      expect(await createApplication(db, userId, { ...base, salaryRange: "50k", salaryCurrency })).toEqual({
        ok: false,
        reason: "invalid",
        fieldErrors: { salaryCurrency: ["Choose the currency of the salary."] },
      });
    }
    expect(await snapshot()).toBe(before);
  });

  it.each(["usd", "US", "USDD", "ZZZ", "U$D", 42])("refuses the invalid currency %j with no change", async (salaryCurrency) => {
    const userId = await newUser();
    const created = await createApplication(db, userId, { ...base, salaryRange: "50k", salaryCurrency: "USD" });
    if (!created.ok) throw new Error("create failed");
    const before = await snapshot();
    const invalid = { ok: false, reason: "invalid", fieldErrors: { salaryCurrency: ["Choose a valid currency."] } };
    expect(await createApplication(db, userId, { ...base, salaryRange: "50k", salaryCurrency })).toEqual(invalid);
    expect(await updateApplication(db, userId, created.application.id, { ...base, salaryRange: "50k", salaryCurrency })).toEqual(
      invalid,
    );
    expect(await snapshot()).toBe(before);
  });

  it("stores no currency without a salary (the form always posts the preselected one)", async () => {
    const userId = await newUser();
    const result = await createApplication(db, userId, { ...base, salaryRange: "", salaryCurrency: "ARS" });
    expect(result).toEqual({ ok: true, application: expect.objectContaining({ salaryRange: null, salaryCurrency: null }) });
    if (!result.ok) return;
    const edited = await updateApplication(db, userId, result.application.id, { ...base, salaryRange: "1M", salaryCurrency: "ARS" });
    expect(edited).toEqual({ ok: true, application: expect.objectContaining({ salaryRange: "1M", salaryCurrency: "ARS" }) });
    expect(formatSalary(null, null)).toBe("—");
  });

  it("the database refuses a salary without currency and a malformed code", async () => {
    const userId = await newUser();
    const created = await createApplication(db, userId, { ...base, salaryRange: "50k", salaryCurrency: "USD" });
    if (!created.ok) throw new Error("create failed");
    const { eq } = await import("drizzle-orm");
    await expect(db.update(application).set({ salaryCurrency: null }).where(eq(application.id, created.application.id))).rejects.toThrow();
    await expect(db.update(application).set({ salaryCurrency: "usd" }).where(eq(application.id, created.application.id))).rejects.toThrow();
    expect((await getApplication(db, userId, created.application.id))?.salaryCurrency).toBe("USD");
  });
});

describe("default currency setting", () => {
  it("is USD until the user picks another one from the list", async () => {
    const userId = await newUser();
    expect((await getUserSettings(db, userId)).defaultCurrency).toBe("USD");
    expect(CURRENCIES).toEqual(["USD", "EUR", "ARS", "BRL", "CLP", "COP", "MXN", "PEN", "UYU", "GBP", "CAD"]);
    expect(await setDefaultCurrency(db, userId, { defaultCurrency: "ARS" })).toEqual({ ok: true, defaultCurrency: "ARS" });
    expect((await getUserSettings(db, userId)).defaultCurrency).toBe("ARS");
  });

  it.each(["", "ars", "ZZZ", null, 1])("refuses %j and changes nothing", async (defaultCurrency) => {
    const userId = await newUser();
    const before = await snapshot();
    expect(await setDefaultCurrency(db, userId, { defaultCurrency })).toEqual({
      ok: false,
      reason: "invalid",
      fieldErrors: { defaultCurrency: ["Choose a valid currency."] },
    });
    expect(await snapshot()).toBe(before);
  });

  it("is per user", async () => {
    const alice = await newUser();
    const bob = await newUser();
    await setDefaultCurrency(db, alice, { defaultCurrency: "EUR" });
    expect((await getUserSettings(db, bob)).defaultCurrency).toBe("USD");
    // Changing the default leaves existing applications alone.
    const created = await createApplication(db, alice, { ...base, salaryRange: "1", salaryCurrency: "USD" });
    await setDefaultCurrency(db, alice, { defaultCurrency: "BRL" });
    expect(created.ok && (await getApplication(db, alice, created.application.id))?.salaryCurrency).toBe("USD");
  });
});
