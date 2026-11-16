import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { application, applicationContact, company, contact, interview, stage, stageTransition, user } from "@/db/schema";
import { createTestDb } from "@/test/db";
import { parseContactInput } from "@/lib/validation/contact";
import { parseInterviewInput } from "@/lib/validation/interview";

vi.mock("server-only", () => ({}));
const { createApplication, updateApplication, updateApplicationNotes } = await import("./applications");
const { createInterview, updateInterview, setInterviewOutcome } = await import("./interviews");
const { createContact, updateContact, linkContact, listApplicationContacts } = await import("./contacts");

type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];
let db: TestDb;
let close: () => Promise<void>;
let n = 0;
beforeAll(async () => ({ db, close } = await createTestDb()));
afterAll(async () => close());

async function newUser() {
  n += 1;
  const id = `probe-user-${n}`;
  await db.insert(user).values({ id, name: `P${n}`, email: `probe${n}@example.com` });
  return id;
}
async function app(userId: string, companyName: string, role = "Eng") {
  const result = await createApplication(db, userId, { companyName, role });
  if (!result.ok) throw new Error("create failed");
  return result.application;
}
async function snapshot() {
  return JSON.stringify([
    await db.select().from(company).orderBy(company.id),
    await db.select().from(stage).orderBy(stage.id),
    await db.select().from(application).orderBy(application.id),
    await db.select().from(stageTransition).orderBy(stageTransition.id),
    await db.select().from(interview).orderBy(interview.id),
    await db.select().from(contact).orderBy(contact.id),
    await db.select().from(applicationContact).orderBy(applicationContact.applicationId, applicationContact.contactId),
  ]);
}
const names = (contacts: { name: string }[] | null) => contacts?.map((c) => c.name) ?? null;

describe("company change cleanup scope", () => {
  it("removes only the moved application's links; sibling and other-user links and contacts survive", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const a1 = await app(alice, "Acme", "A1");
    const a2 = await app(alice, "Acme", "A2");
    const ana = (await createContact(db, alice, a1.id, { name: "Ana" })) as { ok: true; contact: { id: string } };
    expect(await linkContact(db, alice, a2.id, ana.contact.id)).toEqual({ ok: true });
    const b1 = await app(bob, "Acme", "B1");
    await createContact(db, bob, b1.id, { name: "Bert" });
    const other = (await db.select().from(stage)).find((s) => s.userId === alice && s.id !== a1.stageId)!;

    const moved = await updateApplication(db, alice, a1.id, { companyName: "Globex", role: "A1", stageId: other.id });
    expect(moved).toMatchObject({ ok: true, application: { companyName: "Globex" } });
    expect(await listApplicationContacts(db, alice, a1.id)).toEqual([]);
    expect(names(await listApplicationContacts(db, alice, a2.id))).toEqual(["Ana"]);
    expect(names(await listApplicationContacts(db, bob, b1.id))).toEqual(["Bert"]);
    expect((await db.select().from(contact)).filter((c) => c.userId === alice).map((c) => c.name)).toEqual(["Ana"]);
    await updateApplication(db, alice, a1.id, { companyName: "Acme", role: "A1" });
    expect(await listApplicationContacts(db, alice, a1.id)).toEqual([]);
  });

  it("a foreign updateApplication changes nothing, links included", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const a = await app(alice, "Acme");
    await createContact(db, alice, a.id, { name: "Ana" });
    const before = await snapshot();
    expect(await updateApplication(db, bob, a.id, { companyName: "Globex", role: "x" })).toEqual({ ok: false, reason: "not_found" });
    expect(await snapshot()).toBe(before);
  });
});

describe("foreign ids with invalid input", () => {
  it("stay not_found and leave every table byte-identical", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const a = await app(alice, "Acme");
    const i = await createInterview(db, alice, a.id, { scheduledAt: "2025-01-01T10:00:00Z", type: "phone" });
    const c = await createContact(db, alice, a.id, { name: "Ana" });
    if (!i.ok || !c.ok) throw new Error("setup failed");
    const before = await snapshot();
    const notFound = { ok: false, reason: "not_found" };
    expect(await updateApplicationNotes(db, bob, a.id, { notes: "x".repeat(20_000) })).toEqual(notFound);
    expect(await createInterview(db, bob, a.id, { type: "bogus" })).toEqual(notFound);
    expect(await updateInterview(db, bob, i.interview.id, { type: "bogus" })).toEqual(notFound);
    expect(await setInterviewOutcome(db, bob, i.interview.id, "bogus")).toEqual(notFound);
    expect(await createContact(db, bob, a.id, { name: "" })).toEqual(notFound);
    expect(await updateContact(db, bob, c.contact.id, { name: "" })).toEqual(notFound);
    expect(await snapshot()).toBe(before);
  });
});

describe("detail validation", () => {
  it("requires an offset on scheduledAt and stores that instant", () => {
    expect(parseInterviewInput({ scheduledAt: "2025-03-10T10:00", type: "phone" }).success).toBe(false);
    expect(parseInterviewInput({ scheduledAt: "invalid", type: "phone" }).success).toBe(false);
    expect(parseInterviewInput({ scheduledAt: "", type: "phone" })).toMatchObject({
      fieldErrors: { scheduledAt: ["Date and time is required."] },
    });
    expect(parseInterviewInput({ scheduledAt: "2100-01-01T00:00:00Z", type: "phone" }).success).toBe(false);
    const ok = parseInterviewInput({ scheduledAt: "2025-03-10T10:00:00-05:00", type: "phone" });
    expect(ok.success && ok.data.scheduledAt.toISOString()).toBe("2025-03-10T15:00:00.000Z");
    expect(parseInterviewInput({ scheduledAt: "2025-03-10T10:00:00Z", type: "Phone" }).success).toBe(false);
    expect(parseInterviewInput({ scheduledAt: "2025-03-10T10:00:00Z", type: "phone", outcome: "won" }).success).toBe(false);
  });

  it("validates contact email and linkedin", () => {
    for (const linkedin of ["javascript:alert(1)", "ftp://x.com", "linkedin.com/in/a", "https://"]) {
      expect(parseContactInput({ name: "A", linkedin }).success, linkedin).toBe(false);
    }
    expect(parseContactInput({ name: "A", linkedin: "https://www.linkedin.com/in/a" }).success).toBe(true);
    for (const email of ["a", "a@", "@b.com", "a b@c.com"]) {
      expect(parseContactInput({ name: "A", email }).success, email).toBe(false);
    }
    expect(parseContactInput({ name: "  ", email: "a@b.com" }).success).toBe(false);
  });
});

describe("migration 0004 on a populated database", () => {
  it("adds null notes and leaves existing rows unchanged", async () => {
    const folder = fileURLToPath(new URL("../../drizzle", import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), "lafija-m4-"));
    cpSync(folder, dir, { recursive: true });
    const journalPath = join(dir, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
    journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === "0003_board") + 1);
    writeFileSync(journalPath, JSON.stringify(journal));
    const client = new PGlite();
    const pdb = drizzle({ client });
    try {
      await migrate(pdb, { migrationsFolder: dir });
      await client.exec(`
        insert into "user" (id, name, email) values ('u1','One','one@example.com'), ('u2','Two','two@example.com');
        insert into company (id, user_id, name) values ('c1','u1','Acme'), ('c2','u2','Globex');`);
      await client.exec(`
        insert into stage (id, user_id, name, category, position) values ('s1','u1','Applied','active',0), ('s2','u2','Applied','active',0);
        insert into application (id, user_id, company_id, role, stage_id, position) values
          ('a1','u1','c1','R1','s1','a0'), ('a2','u2','c2','R2','s2','a0');
        insert into stage_transition (id, user_id, application_id, from_stage_id, to_stage_id) values ('t1','u1','a1',null,'s1');`);
      const tables = ["user", "company", "stage", "stage_transition"];
      const hash = async (q: string) => createHash("sha256").update(JSON.stringify((await client.query(q)).rows)).digest("hex");
      const before = await Promise.all(tables.map((t) => hash(`select * from "${t}" order by id`)));
      const appBefore = await hash(`select * from application order by id`);
      await migrate(pdb, { migrationsFolder: folder });
      expect(await Promise.all(tables.map((t) => hash(`select * from "${t}" order by id`)))).toEqual(before);
      const cols = (
        await client.query<{ column_name: string }>(
          `select column_name from information_schema.columns where table_name='application' and column_name<>'notes' order by ordinal_position`,
        )
      ).rows
        .map((r) => `"${r.column_name}"`)
        .join(",");
      expect(await hash(`select ${cols} from application order by id`)).toBe(appBefore);
      expect((await client.query(`select notes from application where notes is not null`)).rows).toEqual([]);
      await client.exec(`insert into contact (id,user_id,company_id,name) values ('k1','u1','c1','Ana');
        insert into application_contact (application_id,contact_id,user_id,company_id) values ('a1','k1','u1','c1');`);
      await expect(
        client.exec(`insert into application_contact (application_id,contact_id,user_id,company_id) values ('a2','k1','u2','c2')`),
      ).rejects.toThrow();
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
