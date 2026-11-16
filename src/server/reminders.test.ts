import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  application,
  applicationContact,
  company,
  contact,
  interview,
  reminder,
  stage,
  stageTransition,
  user,
  userSettings,
} from "@/db/schema";
import { createTestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const { createApplication, updateApplication, setApplicationArchived } = await import("./applications");
const { listStages, createStage } = await import("./stages");
const { moveApplication, listStageTransitions } = await import("./board");
const {
  listApplicationReminders,
  listReminders,
  countDueReminders,
  createReminder,
  updateReminder,
  setReminderDone,
  snoozeReminder,
  deleteReminder,
  getFollowUpDays,
  setFollowUpDays,
} = await import("./reminders");

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

const DAY = 24 * 60 * 60 * 1000;

async function newUser() {
  counter += 1;
  const id = `reminder-user-${counter}`;
  await db.insert(user).values({ id, name: `User ${counter}`, email: `reminder${counter}@example.com` });
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
    await db.select().from(applicationContact).orderBy(applicationContact.applicationId, applicationContact.contactId),
    await db.select().from(reminder).orderBy(reminder.id),
    await db.select().from(userSettings).orderBy(userSettings.userId),
  ]);
}

async function stageNamed(userId: string, name: string) {
  const found = (await listStages(db, userId)).find((s) => s.name === name);
  if (!found) throw new Error(`no stage ${name}`);
  return found;
}

async function newApplication(userId: string, input: { companyName?: string; role?: string; stageId?: string } = {}) {
  const result = await createApplication(db, userId, { companyName: "Acme", role: "Engineer", ...input });
  if (!result.ok) throw new Error(`create failed: ${JSON.stringify(result)}`);
  return result.application;
}

async function followUps(userId: string, applicationId: string) {
  const all = await listApplicationReminders(db, userId, applicationId);
  if (!all) throw new Error("not found");
  return all.filter((r) => r.kind === "follow_up");
}

async function transitionsOf(userId: string, applicationId: string) {
  return (await listStageTransitions(db, userId)).filter((t) => t.applicationId === applicationId);
}

async function newReminder(userId: string, applicationId: string, input: Record<string, unknown> = {}) {
  const result = await createReminder(db, userId, applicationId, {
    dueAt: new Date(Date.now() + 2 * DAY).toISOString(),
    message: "Send portfolio",
    ...input,
  });
  if (!result.ok) throw new Error(`reminder failed: ${JSON.stringify(result)}`);
  return result.reminder;
}

describe("automatic follow-ups", () => {
  it("creates one open follow-up, due 7 days after the creation transition, when created into an active stage", async () => {
    const userId = await newUser();
    const app = await newApplication(userId, { companyName: "Globex", role: "Data Engineer" });

    const [transition] = await transitionsOf(userId, app.id);
    expect(await followUps(userId, app.id)).toEqual([
      expect.objectContaining({
        applicationId: app.id,
        kind: "follow_up",
        message: "Follow up with Globex about Data Engineer",
        dueAt: new Date(transition.at.getTime() + 7 * DAY),
        transitionId: transition.id,
        sentAt: null,
        doneAt: null,
      }),
    ]);
  });

  it("replaces the follow-up on a move between columns: the old one is closed, the new one is due from the new transition", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const app = await newApplication(userId);
    const [old] = await followUps(userId, app.id);

    expect(await moveApplication(db, userId, app.id, { stageId: screening.id, index: 0 })).toEqual({ ok: true });

    const transitions = await transitionsOf(userId, app.id);
    const latest = transitions[transitions.length - 1];
    const after = await followUps(userId, app.id);
    expect(after).toHaveLength(2);
    const closed = after.find((r) => r.id === old.id);
    const open = after.find((r) => r.id !== old.id);
    expect(closed?.doneAt).toBeInstanceOf(Date);
    expect(closed?.dueAt).toEqual(old.dueAt);
    expect(open).toEqual(
      expect.objectContaining({
        transitionId: latest.id,
        dueAt: new Date(latest.at.getTime() + 7 * DAY),
        doneAt: null,
        message: "Follow up with Acme about Engineer",
      }),
    );
  });

  it.each(["Offer", "Rejected", "Accepted", "Withdrawn"])("creates none for a %s stage, and a move there closes the open one", async (name) => {
    const userId = await newUser();
    if (name === "Withdrawn") await createStage(db, userId, { name: "Withdrawn", category: "withdrawn" });
    const target = await stageNamed(userId, name);

    const direct = await newApplication(userId, { role: "Direct", stageId: target.id });
    expect(await followUps(userId, direct.id)).toEqual([]);

    const moved = await newApplication(userId, { role: "Moved" });
    await moveApplication(db, userId, moved.id, { stageId: target.id, index: 0 });
    const after = await followUps(userId, moved.id);
    expect(after).toHaveLength(1);
    expect(after[0].doneAt).toBeInstanceOf(Date);
  });

  it("creates none when the user turned follow-ups off, and uses the user's number of days otherwise", async () => {
    const userId = await newUser();
    expect(await setFollowUpDays(db, userId, { followUpDays: "off" })).toEqual({ ok: true, followUpDays: null });
    const off = await newApplication(userId, { role: "Off" });
    expect(await followUps(userId, off.id)).toEqual([]);

    expect(await setFollowUpDays(db, userId, { followUpDays: "3" })).toEqual({ ok: true, followUpDays: 3 });
    const screening = await stageNamed(userId, "Screening");
    await moveApplication(db, userId, off.id, { stageId: screening.id, index: 0 });
    const [transition] = (await transitionsOf(userId, off.id)).slice(-1);
    expect(await followUps(userId, off.id)).toEqual([
      expect.objectContaining({ dueAt: new Date(transition.at.getTime() + 3 * DAY), doneAt: null }),
    ]);
  });

  it("a reorder within a column writes no transition and leaves reminders untouched", async () => {
    const userId = await newUser();
    const first = await newApplication(userId, { role: "First" });
    await newApplication(userId, { role: "Second" });
    const before = await snapshot();
    const remindersBefore = JSON.stringify(await listApplicationReminders(db, userId, first.id));

    expect(await moveApplication(db, userId, first.id, { stageId: first.stageId, index: 1 })).toEqual({ ok: true });

    expect(JSON.stringify(await listApplicationReminders(db, userId, first.id))).toBe(remindersBefore);
    expect(await transitionsOf(userId, first.id)).toHaveLength(1);
    expect(before).not.toBe(await snapshot()); // the order key did change
  });

  it("archiving closes the open follow-up and unarchiving does not create one", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);
    await newReminder(userId, app.id);

    await setApplicationArchived(db, userId, app.id, true);
    const archived = await listApplicationReminders(db, userId, app.id);
    expect(archived?.find((r) => r.kind === "follow_up")?.doneAt).toBeInstanceOf(Date);
    // Manual reminders are left alone.
    expect(archived?.find((r) => r.kind === "manual")?.doneAt).toBeNull();

    await setApplicationArchived(db, userId, app.id, false);
    const restored = await followUps(userId, app.id);
    expect(restored).toHaveLength(1);
    expect(restored[0].doneAt).toBeInstanceOf(Date);
  });

  it("a stage change from the edit form behaves like a move, with the edited company and role", async () => {
    const userId = await newUser();
    const interviewStage = await stageNamed(userId, "Interview");
    const app = await newApplication(userId);
    const [old] = await followUps(userId, app.id);

    // Same stage: nothing changes.
    await updateApplication(db, userId, app.id, { companyName: "Acme", role: "Engineer II" });
    expect(await followUps(userId, app.id)).toEqual([{ ...old, role: "Engineer II" }]);

    await updateApplication(db, userId, app.id, { companyName: "Initech", role: "Lead", stageId: interviewStage.id });
    const [latest] = (await transitionsOf(userId, app.id)).slice(-1);
    const after = await followUps(userId, app.id);
    expect(after.find((r) => r.id === old.id)?.doneAt).toBeInstanceOf(Date);
    expect(after.find((r) => r.id !== old.id)).toEqual(
      expect.objectContaining({
        transitionId: latest.id,
        dueAt: new Date(latest.at.getTime() + 7 * DAY),
        doneAt: null,
        message: "Follow up with Initech about Lead",
      }),
    );
  });

  it("an edit-form stage change of an archived application creates no follow-up", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const app = await newApplication(userId);
    await setApplicationArchived(db, userId, app.id, true);

    await updateApplication(db, userId, app.id, { companyName: "Acme", role: "Engineer", stageId: screening.id });

    expect((await followUps(userId, app.id)).every((r) => r.doneAt !== null)).toBe(true);
  });
});

describe("due reminders", () => {
  it("counts reminders due now, excluding done, future and archived applications", async () => {
    const userId = await newUser();
    await setFollowUpDays(db, userId, { followUpDays: "off" });
    const app = await newApplication(userId);
    const other = await newApplication(userId, { role: "Other" });
    const past = new Date(Date.now() - DAY).toISOString();
    expect(await countDueReminders(db, userId)).toBe(0);

    await newReminder(userId, app.id, { dueAt: past, message: "Due" });
    const done = await newReminder(userId, app.id, { dueAt: past, message: "Done" });
    await setReminderDone(db, userId, done.id, true);
    await newReminder(userId, app.id, { message: "Future" });
    await newReminder(userId, other.id, { dueAt: past, message: "Archived" });
    await setApplicationArchived(db, userId, other.id, true);

    expect(await countDueReminders(db, userId)).toBe(1);
    const lists = await listReminders(db, userId);
    expect(lists.due.map((r) => r.message)).toEqual(["Due"]);
    expect(lists.upcoming.map((r) => r.message)).toEqual(["Future"]);
    expect(lists.done.map((r) => r.message)).toEqual(["Done"]);
    expect(lists.due[0]).toEqual(expect.objectContaining({ applicationId: app.id, companyName: "Acme", role: "Engineer" }));
  });

  it("counts an automatic follow-up once it is due", async () => {
    const userId = await newUser();
    await setFollowUpDays(db, userId, { followUpDays: "1" });
    await newApplication(userId);
    expect(await countDueReminders(db, userId)).toBe(0);
    expect((await listReminders(db, userId)).upcoming).toHaveLength(1);
  });
});

describe("manual reminders", () => {
  it("creates, edits, marks done and undone, snoozes and deletes", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);

    const created = await createReminder(db, userId, app.id, {
      dueAt: "2030-03-12T09:30:00-03:00",
      message: "  Ask about the timeline  ",
    });
    expect(created).toEqual({
      ok: true,
      reminder: expect.objectContaining({
        applicationId: app.id,
        kind: "manual",
        dueAt: new Date("2030-03-12T12:30:00.000Z"),
        message: "Ask about the timeline",
        transitionId: null,
        doneAt: null,
        sentAt: null,
      }),
    });
    const id = created.ok ? created.reminder.id : "";

    expect(await updateReminder(db, userId, id, { dueAt: "2030-04-01T10:00:00Z", message: "Call Ana" })).toEqual({
      ok: true,
      reminder: expect.objectContaining({ id, dueAt: new Date("2030-04-01T10:00:00Z"), message: "Call Ana" }),
    });

    const done = await setReminderDone(db, userId, id, true);
    expect(done).toEqual({ ok: true, reminder: expect.objectContaining({ id, doneAt: expect.any(Date) }) });
    expect(await setReminderDone(db, userId, id, false)).toEqual({
      ok: true,
      reminder: expect.objectContaining({ id, doneAt: null }),
    });

    for (const days of [1, 3, 7] as const) {
      const before = Date.now();
      const snoozed = await snoozeReminder(db, userId, id, String(days));
      expect(snoozed.ok).toBe(true);
      const due = snoozed.ok ? snoozed.reminder.dueAt.getTime() : 0;
      expect(due).toBeGreaterThanOrEqual(before + days * DAY - 5_000);
      expect(due).toBeLessThanOrEqual(Date.now() + days * DAY + 5_000);
    }

    expect(await deleteReminder(db, userId, id)).toEqual({ ok: true });
    expect((await listApplicationReminders(db, userId, app.id))?.filter((r) => r.kind === "manual")).toEqual([]);
    expect(await deleteReminder(db, userId, id)).toEqual({ ok: false, reason: "not_found" });
  });

  it.each([
    [{ dueAt: "", message: "Hi" }, { dueAt: ["Due date and time is required."] }],
    [{ dueAt: "tomorrow", message: "Hi" }, { dueAt: ["Enter a valid date and time."] }],
    [{ dueAt: "2030-01-01T10:00", message: "Hi" }, { dueAt: ["Enter a valid date and time."] }],
    [{ dueAt: "2100-01-01T00:00:00Z", message: "Hi" }, { dueAt: ["Enter a date between 1970 and 2099."] }],
    [{ dueAt: "2030-01-01T10:00:00Z", message: "   " }, { message: ["Message is required."] }],
    [{ dueAt: "2030-01-01T10:00:00Z" }, { message: ["Message is required."] }],
    [{ dueAt: "2030-01-01T10:00:00Z", message: "x".repeat(501) }, { message: ["Message must be at most 500 characters."] }],
  ])("refuses invalid input %j and changes nothing", async (input, fieldErrors) => {
    const userId = await newUser();
    const app = await newApplication(userId);
    const existing = await newReminder(userId, app.id);
    const before = await snapshot();

    expect(await createReminder(db, userId, app.id, input)).toEqual({ ok: false, reason: "invalid", fieldErrors });
    expect(await updateReminder(db, userId, existing.id, input)).toEqual({ ok: false, reason: "invalid", fieldErrors });

    expect(await snapshot()).toBe(before);
  });

  it("accepts a 500-character message", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);
    expect((await newReminder(userId, app.id, { message: "x".repeat(500) })).message).toHaveLength(500);
  });

  it("refuses snooze lengths other than 1, 3 or 7 days, snoozing a done reminder, and bad done values", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);
    const open = await newReminder(userId, app.id);
    const done = await newReminder(userId, app.id);
    await setReminderDone(db, userId, done.id, true);
    const before = await snapshot();

    for (const days of [0, 2, "5", 30, -1, "1.5", null, undefined, "x"]) {
      expect(await snoozeReminder(db, userId, open.id, days)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(await snoozeReminder(db, userId, done.id, 1)).toEqual({ ok: false, reason: "done" });
    for (const value of ["true", 1, null, undefined]) {
      expect(await setReminderDone(db, userId, open.id, value)).toEqual({ ok: false, reason: "invalid" });
    }

    expect(await snapshot()).toBe(before);
  });

  it("snoozing or rescheduling clears sent_at so the new due time is emailed again", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);
    const r = await newReminder(userId, app.id);
    const { eq } = await import("drizzle-orm");
    await db.update(reminder).set({ sentAt: new Date() }).where(eq(reminder.id, r.id));

    const renamed = await updateReminder(db, userId, r.id, { dueAt: r.dueAt.toISOString(), message: "Renamed" });
    expect(renamed.ok && renamed.reminder.sentAt).toBeInstanceOf(Date);
    const moved = await updateReminder(db, userId, r.id, { dueAt: "2031-01-01T00:00:00Z", message: "Renamed" });
    expect(moved.ok && moved.reminder.sentAt).toBeNull();

    await db.update(reminder).set({ sentAt: new Date() }).where(eq(reminder.id, r.id));
    const snoozed = await snoozeReminder(db, userId, r.id, 1);
    expect(snoozed.ok && snoozed.reminder.sentAt).toBeNull();
  });

  it("reopens a closed follow-up only while it belongs to the application's current stage", async () => {
    const userId = await newUser();
    const screening = await stageNamed(userId, "Screening");
    const app = await newApplication(userId);
    const [first] = await followUps(userId, app.id);

    expect(await setReminderDone(db, userId, first.id, true)).toMatchObject({ ok: true });
    expect(await setReminderDone(db, userId, first.id, false)).toMatchObject({ ok: true, reminder: { doneAt: null } });

    await moveApplication(db, userId, app.id, { stageId: screening.id, index: 0 });
    const before = await snapshot();
    expect(await setReminderDone(db, userId, first.id, false)).toEqual({ ok: false, reason: "closed" });
    expect(await snapshot()).toBe(before);
  });
});

describe("follow-up settings", () => {
  it("defaults to 7 days, accepts 1-60 or off, and refuses anything else unchanged", async () => {
    const userId = await newUser();
    expect(await getFollowUpDays(db, userId)).toBe(7);

    expect(await setFollowUpDays(db, userId, { followUpDays: "1" })).toEqual({ ok: true, followUpDays: 1 });
    expect(await setFollowUpDays(db, userId, { followUpDays: 60 })).toEqual({ ok: true, followUpDays: 60 });
    expect(await getFollowUpDays(db, userId)).toBe(60);
    expect(await setFollowUpDays(db, userId, { followUpDays: "off" })).toEqual({ ok: true, followUpDays: null });
    expect(await getFollowUpDays(db, userId)).toBeNull();
    expect(await setFollowUpDays(db, userId, { followUpDays: "14" })).toEqual({ ok: true, followUpDays: 14 });

    const before = await snapshot();
    for (const value of ["0", "61", 0, 61, "2.5", 2.5, "", "seven", undefined, true, -3]) {
      expect(await setFollowUpDays(db, userId, { followUpDays: value })).toEqual({
        ok: false,
        reason: "invalid",
        fieldErrors: { followUpDays: ["Choose off or a number of days from 1 to 60."] },
      });
    }
    expect(await snapshot()).toBe(before);
    expect(await getFollowUpDays(db, userId)).toBe(14);
  });
});

describe("isolation", () => {
  it("every operation on another user's reminder or application is not_found and changes nothing", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const app = await newApplication(alice);
    const manual = await newReminder(alice, app.id);
    const [followUp] = await followUps(alice, app.id);
    await setFollowUpDays(db, alice, { followUpDays: "5" });
    const valid = { dueAt: "2030-01-01T10:00:00Z", message: "Hi" };
    const before = await snapshot();

    expect(await listApplicationReminders(db, bob, app.id)).toBeNull();
    expect(await createReminder(db, bob, app.id, valid)).toEqual({ ok: false, reason: "not_found" });
    expect(await createReminder(db, bob, app.id, {})).toEqual({ ok: false, reason: "not_found" });
    for (const id of [manual.id, followUp.id, "missing", "", "a\0b", "x".repeat(200)]) {
      expect(await updateReminder(db, bob, id, valid)).toEqual({ ok: false, reason: "not_found" });
      expect(await updateReminder(db, bob, id, {})).toEqual({ ok: false, reason: "not_found" });
      expect(await setReminderDone(db, bob, id, true)).toEqual({ ok: false, reason: "not_found" });
      expect(await setReminderDone(db, bob, id, "bad")).toEqual({ ok: false, reason: "not_found" });
      expect(await snoozeReminder(db, bob, id, 1)).toEqual({ ok: false, reason: "not_found" });
      expect(await snoozeReminder(db, bob, id, 2)).toEqual({ ok: false, reason: "not_found" });
      expect(await deleteReminder(db, bob, id)).toEqual({ ok: false, reason: "not_found" });
    }
    for (const id of ["", "a\0b"]) {
      expect(await createReminder(db, alice, id, valid)).toEqual({ ok: false, reason: "not_found" });
      expect(await listApplicationReminders(db, alice, id)).toBeNull();
    }
    expect(await countDueReminders(db, bob)).toBe(0);
    expect(await listReminders(db, bob)).toEqual({ due: [], upcoming: [], done: [] });
    expect(await getFollowUpDays(db, bob)).toBe(7);

    expect(await snapshot()).toBe(before);

    // Bob's own setting and moves never touch Alice's reminders.
    await setFollowUpDays(db, bob, { followUpDays: "off" });
    const screening = await stageNamed(alice, "Screening");
    expect(await moveApplication(db, bob, app.id, { stageId: screening.id, index: 0 })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await setApplicationArchived(db, bob, app.id, true)).toEqual({ ok: false, reason: "not_found" });
    expect(await getFollowUpDays(db, alice)).toBe(5);
    expect(await listApplicationReminders(db, alice, app.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: followUp.id, doneAt: null })]),
    );
  });

  it("deleting the user deletes their reminders and settings", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);
    await newReminder(userId, app.id);
    await setFollowUpDays(db, userId, { followUpDays: "3" });
    const { eq } = await import("drizzle-orm");

    await db.delete(user).where(eq(user.id, userId));

    expect(await db.select().from(reminder).where(eq(reminder.userId, userId))).toEqual([]);
    expect(await db.select().from(userSettings).where(eq(userSettings.userId, userId))).toEqual([]);
  });
});
