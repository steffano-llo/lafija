import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  application,
  applicationContact,
  company,
  contact,
  interview,
  stage,
  stageTransition,
  user,
} from "@/db/schema";
import { createTestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const { createApplication, getApplication, updateApplication, updateApplicationNotes, findOrCreateCompany } =
  await import("./applications");
const { listStages } = await import("./stages");
const { moveApplication, listApplicationHistory } = await import("./board");
const { listInterviews, createInterview, updateInterview, setInterviewOutcome, deleteInterview } = await import(
  "./interviews"
);
const {
  listApplicationContacts,
  listLinkableContacts,
  createContact,
  updateContact,
  deleteContact,
  linkContact,
  unlinkContact,
} = await import("./contacts");

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
  const id = `detail-user-${counter}`;
  await db.insert(user).values({ id, name: `User ${counter}`, email: `detail${counter}@example.com` });
  return id;
}

/** Raw rows of every app table: refusals must leave them byte-identical. */
async function snapshot() {
  return JSON.stringify([
    await db.select().from(company).orderBy(company.id),
    await db.select().from(stage).orderBy(stage.id),
    await db.select().from(application).orderBy(application.id),
    await db.select().from(stageTransition).orderBy(stageTransition.id),
    await db.select().from(interview).orderBy(interview.id),
    await db.select().from(contact).orderBy(contact.id),
    await db
      .select()
      .from(applicationContact)
      .orderBy(applicationContact.applicationId, applicationContact.contactId),
  ]);
}

async function newApplication(userId: string, companyName = "Acme", role = "Engineer") {
  const result = await createApplication(db, userId, { companyName, role });
  if (!result.ok) throw new Error(`create failed: ${JSON.stringify(result)}`);
  return result.application;
}

async function newInterview(userId: string, applicationId: string, input: Record<string, unknown> = {}) {
  const result = await createInterview(db, userId, applicationId, {
    scheduledAt: "2025-03-10T15:00:00.000Z",
    type: "video",
    ...input,
  });
  if (!result.ok) throw new Error(`interview failed: ${JSON.stringify(result)}`);
  return result.interview;
}

async function newContact(userId: string, applicationId: string, input: Record<string, unknown> = {}) {
  const result = await createContact(db, userId, applicationId, { name: "Ana Recruiter", ...input });
  if (!result.ok) throw new Error(`contact failed: ${JSON.stringify(result)}`);
  return result.contact;
}

const names = (contacts: { name: string }[] | null) => contacts?.map((c) => c.name) ?? null;

describe("interviews", () => {
  it("creates, lists by scheduled time, edits, changes the outcome and deletes", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);

    const created = await createInterview(db, userId, app.id, {
      scheduledAt: "2025-03-12T09:30:00-03:00",
      type: "technical",
      notes: "  Live coding  ",
    });
    expect(created).toEqual({
      ok: true,
      interview: expect.objectContaining({
        applicationId: app.id,
        scheduledAt: new Date("2025-03-12T12:30:00.000Z"),
        type: "technical",
        notes: "Live coding",
        outcome: "pending",
      }),
    });
    const earlier = await newInterview(userId, app.id, { scheduledAt: "2025-03-01T10:00:00Z", type: "phone" });

    expect((await listInterviews(db, userId, app.id))?.map((i) => i.type)).toEqual(["phone", "technical"]);

    const id = created.ok ? created.interview.id : "";
    expect(
      await updateInterview(db, userId, id, {
        scheduledAt: "2025-02-01T10:00:00Z",
        type: "onsite",
        outcome: "passed",
        notes: "",
      }),
    ).toEqual({
      ok: true,
      interview: expect.objectContaining({
        id,
        scheduledAt: new Date("2025-02-01T10:00:00Z"),
        type: "onsite",
        outcome: "passed",
        notes: null,
      }),
    });
    expect((await listInterviews(db, userId, app.id))?.map((i) => i.id)).toEqual([id, earlier.id]);

    expect(await setInterviewOutcome(db, userId, earlier.id, "cancelled")).toEqual({
      ok: true,
      interview: expect.objectContaining({ id: earlier.id, outcome: "cancelled", type: "phone" }),
    });

    expect(await deleteInterview(db, userId, id)).toEqual({ ok: true });
    expect((await listInterviews(db, userId, app.id))?.map((i) => i.id)).toEqual([earlier.id]);
    expect(await deleteInterview(db, userId, id)).toEqual({ ok: false, reason: "not_found" });
  });

  it.each([
    [{ type: "video" }, { scheduledAt: ["Date and time is required."] }],
    [{ scheduledAt: "", type: "video" }, { scheduledAt: ["Date and time is required."] }],
    [{ scheduledAt: "2025-02-30T10:00:00Z", type: "video" }, { scheduledAt: ["Enter a valid date and time."] }],
    [{ scheduledAt: "2025-03-10T10:00", type: "video" }, { scheduledAt: ["Enter a valid date and time."] }],
    [{ scheduledAt: "tomorrow", type: "video" }, { scheduledAt: ["Enter a valid date and time."] }],
    [{ scheduledAt: "2150-01-01T10:00:00Z", type: "video" }, { scheduledAt: ["Enter a date between 1970 and 2099."] }],
    [{ scheduledAt: "2025-03-10T10:00:00Z" }, { type: ["Choose a valid interview type."] }],
    [{ scheduledAt: "2025-03-10T10:00:00Z", type: "dinner" }, { type: ["Choose a valid interview type."] }],
    [{ scheduledAt: "2025-03-10T10:00:00Z", type: "video", outcome: "won" }, { outcome: ["Choose a valid outcome."] }],
    [
      { scheduledAt: "2025-03-10T10:00:00Z", type: "video", notes: "n".repeat(5001) },
      { notes: ["Notes must be at most 5000 characters."] },
    ],
  ])("refuses invalid input case %# with field errors and no change", async (input, fieldErrors) => {
    const userId = await newUser();
    const app = await newApplication(userId);
    const existing = await newInterview(userId, app.id);
    const before = await snapshot();

    expect(await createInterview(db, userId, app.id, input)).toEqual({ ok: false, reason: "invalid", fieldErrors });
    expect(await updateInterview(db, userId, existing.id, input)).toEqual({ ok: false, reason: "invalid", fieldErrors });
    expect(await snapshot()).toBe(before);
  });

  it("refuses an unknown outcome with no change", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);
    const existing = await newInterview(userId, app.id);
    const before = await snapshot();

    for (const outcome of ["won", "", null, 3, undefined]) {
      expect(await setInterviewOutcome(db, userId, existing.id, outcome)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(await snapshot()).toBe(before);
  });

  it("returns null for the interviews of an unknown application", async () => {
    const userId = await newUser();
    expect(await listInterviews(db, userId, "nope")).toBeNull();
  });
});

describe("contacts", () => {
  it("creates a contact in the application's company and links it", async () => {
    const userId = await newUser();
    const app = await newApplication(userId, "Acme");

    const result = await createContact(db, userId, app.id, {
      name: " Ana ",
      role: "Recruiter",
      email: "ana@acme.com",
      linkedin: "https://www.linkedin.com/in/ana",
      notes: "Met at a meetup",
    });

    expect(result).toEqual({
      ok: true,
      contact: expect.objectContaining({
        companyId: app.companyId,
        name: "Ana",
        role: "Recruiter",
        email: "ana@acme.com",
        linkedin: "https://www.linkedin.com/in/ana",
        notes: "Met at a meetup",
      }),
    });
    expect(names(await listApplicationContacts(db, userId, app.id))).toEqual(["Ana"]);
  });

  it("edits a contact; blank optional fields become null", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);
    const created = await newContact(userId, app.id, { email: "a@b.co", role: "HR" });

    expect(await updateContact(db, userId, created.id, { name: "Ana B", role: "", email: " ", linkedin: "http://x.io" }))
      .toEqual({
        ok: true,
        contact: expect.objectContaining({ id: created.id, name: "Ana B", role: null, email: null, linkedin: "http://x.io" }),
      });
  });

  it.each([
    [{}, { name: ["Name is required."] }],
    [{ name: "  " }, { name: ["Name is required."] }],
    [{ name: "A", email: "not-an-email" }, { email: ["Enter a valid email address."] }],
    [{ name: "A", email: "a@" }, { email: ["Enter a valid email address."] }],
    [{ name: "A", linkedin: "linkedin.com/in/a" }, { linkedin: ["Enter a valid http(s) URL."] }],
    [{ name: "A", linkedin: "javascript:alert(1)" }, { linkedin: ["Enter a valid http(s) URL."] }],
    [{ name: "n".repeat(121) }, { name: ["Name must be at most 120 characters."] }],
  ])("refuses invalid input case %# with field errors and no change", async (input, fieldErrors) => {
    const userId = await newUser();
    const app = await newApplication(userId);
    const existing = await newContact(userId, app.id);
    const before = await snapshot();

    expect(await createContact(db, userId, app.id, input)).toEqual({ ok: false, reason: "invalid", fieldErrors });
    expect(await updateContact(db, userId, existing.id, input)).toEqual({ ok: false, reason: "invalid", fieldErrors });
    expect(await snapshot()).toBe(before);
  });

  it("links an existing contact of the same company, idempotently, and unlinks it", async () => {
    const userId = await newUser();
    const first = await newApplication(userId, "Acme", "Frontend");
    const second = await newApplication(userId, "acme", "Backend");
    const ana = await newContact(userId, first.id, { name: "Ana" });

    expect(names(await listLinkableContacts(db, userId, second.id))).toEqual(["Ana"]);
    expect(await linkContact(db, userId, second.id, ana.id)).toEqual({ ok: true });
    expect(await linkContact(db, userId, second.id, ana.id)).toEqual({ ok: true });
    expect(names(await listApplicationContacts(db, userId, second.id))).toEqual(["Ana"]);
    expect(await listLinkableContacts(db, userId, second.id)).toEqual([]);
    expect(await db.select().from(applicationContact).where(eq(applicationContact.contactId, ana.id))).toHaveLength(2);

    expect(await unlinkContact(db, userId, second.id, ana.id)).toEqual({ ok: true });
    expect(await unlinkContact(db, userId, second.id, ana.id)).toEqual({ ok: true });
    expect(await listApplicationContacts(db, userId, second.id)).toEqual([]);
    // Unlinking keeps the contact and its other links.
    expect(names(await listApplicationContacts(db, userId, first.id))).toEqual(["Ana"]);
  });

  it("refuses to link a contact of another company, with no change", async () => {
    const userId = await newUser();
    const acme = await newApplication(userId, "Acme");
    const globex = await newApplication(userId, "Globex");
    const ana = await newContact(userId, acme.id, { name: "Ana" });
    const before = await snapshot();

    expect(await listLinkableContacts(db, userId, globex.id)).toEqual([]);
    expect(await linkContact(db, userId, globex.id, ana.id)).toEqual({ ok: false, reason: "other_company" });
    expect(await snapshot()).toBe(before);
  });

  it("the database refuses a link across companies", async () => {
    const userId = await newUser();
    const acme = await newApplication(userId, "Acme");
    const globex = await newApplication(userId, "Globex");
    const ana = await newContact(userId, acme.id, { name: "Ana" });

    for (const companyId of [acme.companyId, globex.companyId]) {
      await expect(
        db.insert(applicationContact).values({ applicationId: globex.id, contactId: ana.id, userId, companyId }),
      ).rejects.toThrow();
    }
  });

  it("deleting a contact removes all its links", async () => {
    const userId = await newUser();
    const first = await newApplication(userId, "Acme", "A");
    const second = await newApplication(userId, "Acme", "B");
    const ana = await newContact(userId, first.id, { name: "Ana" });
    const bob = await newContact(userId, first.id, { name: "Bob" });
    await linkContact(db, userId, second.id, ana.id);

    expect(await deleteContact(db, userId, ana.id)).toEqual({ ok: true });

    expect(names(await listApplicationContacts(db, userId, first.id))).toEqual(["Bob"]);
    expect(await listApplicationContacts(db, userId, second.id)).toEqual([]);
    expect(await db.select().from(applicationContact).where(eq(applicationContact.contactId, ana.id))).toEqual([]);
    expect(await deleteContact(db, userId, ana.id)).toEqual({ ok: false, reason: "not_found" });
    expect(bob.name).toBe("Bob");
  });

  it("moving an application to another company drops its links to the old company's contacts", async () => {
    const userId = await newUser();
    const app = await newApplication(userId, "Acme", "Engineer");
    const ana = await newContact(userId, app.id, { name: "Ana" });

    const moved = await updateApplication(db, userId, app.id, { companyName: "Globex", role: "Engineer" });

    expect(moved).toMatchObject({ ok: true, application: { companyName: "Globex" } });
    expect(await listApplicationContacts(db, userId, app.id)).toEqual([]);
    // The contact stays with its company.
    expect(await db.select({ id: contact.id }).from(contact).where(eq(contact.id, ana.id))).toEqual([{ id: ana.id }]);
  });

  it("editing an application without changing its company keeps its links", async () => {
    const userId = await newUser();
    const app = await newApplication(userId, "Acme", "Engineer");
    await newContact(userId, app.id, { name: "Ana" });

    expect(await updateApplication(db, userId, app.id, { companyName: "ACME", role: "Lead" })).toMatchObject({ ok: true });

    expect(names(await listApplicationContacts(db, userId, app.id))).toEqual(["Ana"]);
  });

  it("lists linked contacts by name and returns null for an unknown application", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);
    await newContact(userId, app.id, { name: "zoe" });
    await newContact(userId, app.id, { name: "Ana" });

    expect(names(await listApplicationContacts(db, userId, app.id))).toEqual(["Ana", "zoe"]);
    expect(await listApplicationContacts(db, userId, "nope")).toBeNull();
    expect(await listLinkableContacts(db, userId, "nope")).toBeNull();
  });
});

describe("application notes", () => {
  it("saves, shows and clears the free notes", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);
    expect(app.notes).toBeNull();

    expect(await updateApplicationNotes(db, userId, app.id, { notes: "  Ask about remote.\nFollow up Friday.  " }))
      .toEqual({ ok: true, notes: "Ask about remote.\nFollow up Friday." });
    expect((await getApplication(db, userId, app.id))?.notes).toBe("Ask about remote.\nFollow up Friday.");

    expect(await updateApplicationNotes(db, userId, app.id, { notes: "   " })).toEqual({ ok: true, notes: null });
    expect((await getApplication(db, userId, app.id))?.notes).toBeNull();
  });

  it("refuses notes that are too long with no change", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);
    await updateApplicationNotes(db, userId, app.id, { notes: "keep" });
    const before = await snapshot();

    expect(await updateApplicationNotes(db, userId, app.id, { notes: "n".repeat(10_001) })).toEqual({
      ok: false,
      reason: "invalid",
      fieldErrors: { notes: ["Notes must be at most 10000 characters."] },
    });
    expect(await snapshot()).toBe(before);
  });
});

describe("stage history", () => {
  it("lists the application's transitions oldest first with English labels", async () => {
    const userId = await newUser();
    const stages = await listStages(db, userId);
    const byName = (name: string) => stages.find((s) => s.name === name)!.id;
    const app = await newApplication(userId);
    const other = await newApplication(userId, "Globex");
    await moveApplication(db, userId, app.id, { stageId: byName("Screening"), index: 0 });
    await moveApplication(db, userId, other.id, { stageId: byName("Offer"), index: 0 });
    await moveApplication(db, userId, app.id, { stageId: byName("Interview"), index: 0 });
    await moveApplication(db, userId, app.id, { stageId: byName("Interview"), index: 0 });

    const history = await listApplicationHistory(db, userId, app.id);

    expect(history?.map((h) => h.label)).toEqual([
      "Created in Applied",
      "Applied → Screening",
      "Screening → Interview",
    ]);
    expect(history?.[0]).toEqual({
      id: expect.any(String),
      at: app.createdAt,
      fromStageName: null,
      toStageName: "Applied",
      label: "Created in Applied",
    });
    const times = history!.map((h) => h.at.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(await listApplicationHistory(db, userId, "nope")).toBeNull();
  });

  it("orders transitions with the same timestamp by creation first", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);
    const [created] = await db.select().from(stageTransition).where(eq(stageTransition.applicationId, app.id));
    const screening = (await listStages(db, userId)).find((s) => s.name === "Screening")!;
    // Same instant as the creation row, inserted with an id that sorts first.
    await db.insert(stageTransition).values({
      id: "0000",
      userId,
      applicationId: app.id,
      fromStageId: created.toStageId,
      toStageId: screening.id,
      at: created.at,
    });

    expect((await listApplicationHistory(db, userId, app.id))?.map((h) => h.label)).toEqual([
      "Created in Applied",
      "Applied → Screening",
    ]);
  });
});

describe("per-user isolation", () => {
  it("every operation on another user's ids is not_found and changes nothing", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const aliceApp = await newApplication(alice, "Acme");
    const aliceInterview = await newInterview(alice, aliceApp.id);
    const aliceContact = await newContact(alice, aliceApp.id, { name: "Ana" });
    await updateApplicationNotes(db, alice, aliceApp.id, { notes: "private" });
    // Bob has an application and contact of his own "Acme", so only ownership separates them.
    const bobApp = await newApplication(bob, "Acme");
    const bobContact = await newContact(bob, bobApp.id, { name: "Bert" });
    const before = await snapshot();
    const notFound = { ok: false, reason: "not_found" };
    const validInterview = { scheduledAt: "2025-01-01T10:00:00Z", type: "phone" };

    expect(await getApplication(db, bob, aliceApp.id)).toBeNull();
    expect(await listApplicationHistory(db, bob, aliceApp.id)).toBeNull();
    expect(await listInterviews(db, bob, aliceApp.id)).toBeNull();
    expect(await listApplicationContacts(db, bob, aliceApp.id)).toBeNull();
    expect(await listLinkableContacts(db, bob, aliceApp.id)).toBeNull();
    expect(await updateApplicationNotes(db, bob, aliceApp.id, { notes: "mine" })).toEqual(notFound);
    expect(await createInterview(db, bob, aliceApp.id, validInterview)).toEqual(notFound);
    expect(await updateInterview(db, bob, aliceInterview.id, validInterview)).toEqual(notFound);
    expect(await setInterviewOutcome(db, bob, aliceInterview.id, "failed")).toEqual(notFound);
    expect(await deleteInterview(db, bob, aliceInterview.id)).toEqual(notFound);
    expect(await createContact(db, bob, aliceApp.id, { name: "Spy" })).toEqual(notFound);
    expect(await updateContact(db, bob, aliceContact.id, { name: "Spy" })).toEqual(notFound);
    expect(await deleteContact(db, bob, aliceContact.id)).toEqual(notFound);
    // Every pairing of own and foreign ids.
    expect(await linkContact(db, bob, bobApp.id, aliceContact.id)).toEqual(notFound);
    expect(await linkContact(db, bob, aliceApp.id, bobContact.id)).toEqual(notFound);
    expect(await linkContact(db, bob, aliceApp.id, aliceContact.id)).toEqual(notFound);
    expect(await unlinkContact(db, bob, aliceApp.id, aliceContact.id)).toEqual(notFound);
    expect(await unlinkContact(db, bob, bobApp.id, aliceContact.id)).toEqual(notFound);
    expect(await unlinkContact(db, bob, aliceApp.id, bobContact.id)).toEqual(notFound);

    expect(await snapshot()).toBe(before);
    expect(names(await listApplicationContacts(db, alice, aliceApp.id))).toEqual(["Ana"]);
    expect(names(await listApplicationContacts(db, bob, bobApp.id))).toEqual(["Bert"]);
  });

  it("unknown and hostile ids are not_found with no change", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);
    const before = await snapshot();
    const notFound = { ok: false, reason: "not_found" };

    for (const id of ["", "nope", "' or 1=1 --", "x".repeat(500), "a\u0000b"]) {
      expect(await createInterview(db, userId, id, { scheduledAt: "2025-01-01T10:00:00Z", type: "phone" })).toEqual(notFound);
      expect(await setInterviewOutcome(db, userId, id, "passed")).toEqual(notFound);
      expect(await deleteInterview(db, userId, id)).toEqual(notFound);
      expect(await createContact(db, userId, id, { name: "X" })).toEqual(notFound);
      expect(await deleteContact(db, userId, id)).toEqual(notFound);
      expect(await linkContact(db, userId, app.id, id)).toEqual(notFound);
      expect(await updateApplicationNotes(db, userId, id, { notes: "x" })).toEqual(notFound);
    }
    expect(await snapshot()).toBe(before);
  });

  it("the database refuses an interview or contact pointing at another user's rows", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const aliceApp = await newApplication(alice);

    await expect(
      db.insert(interview).values({ userId: bob, applicationId: aliceApp.id, scheduledAt: new Date(), type: "phone" }),
    ).rejects.toThrow();
    await expect(db.insert(contact).values({ userId: bob, companyId: aliceApp.companyId, name: "Spy" })).rejects.toThrow();
  });
});

describe("cascades", () => {
  it("deleting an application deletes its interviews and links, not its contacts", async () => {
    const userId = await newUser();
    const app = await newApplication(userId, "Acme");
    await newInterview(userId, app.id);
    const ana = await newContact(userId, app.id);

    await db.delete(application).where(and(eq(application.id, app.id), eq(application.userId, userId)));

    expect(await db.select().from(interview).where(eq(interview.applicationId, app.id))).toEqual([]);
    expect(await db.select().from(applicationContact).where(eq(applicationContact.applicationId, app.id))).toEqual([]);
    expect(await db.select({ id: contact.id }).from(contact).where(eq(contact.id, ana.id))).toEqual([{ id: ana.id }]);
  });

  it("deleting a company deletes its contacts and their links", async () => {
    const userId = await newUser();
    const app = await newApplication(userId, "Acme");
    const ana = await newContact(userId, app.id);
    // A company can only be deleted once it has no applications.
    await db.delete(application).where(eq(application.id, app.id));
    const acme = await findOrCreateCompany(db, userId, "Acme");

    await db.delete(company).where(eq(company.id, acme.id));

    expect(await db.select().from(contact).where(eq(contact.id, ana.id))).toEqual([]);
    expect(await db.select().from(applicationContact).where(eq(applicationContact.contactId, ana.id))).toEqual([]);
  });

  it("deleting a user deletes their interviews, contacts and links", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);
    await newInterview(userId, app.id);
    await newContact(userId, app.id);

    await db.delete(user).where(eq(user.id, userId));

    expect(await db.select().from(interview).where(eq(interview.userId, userId))).toEqual([]);
    expect(await db.select().from(contact).where(eq(contact.userId, userId))).toEqual([]);
    expect(await db.select().from(applicationContact).where(eq(applicationContact.userId, userId))).toEqual([]);
  });
});
