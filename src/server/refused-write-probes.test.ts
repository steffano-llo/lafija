/* eslint-disable @typescript-eslint/no-unused-vars -- shares the helper header of reminders.test.ts verbatim */
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


const reminderRows = async () => JSON.stringify(await db.select().from(reminder).orderBy(reminder.id));

describe("refused writes and reorders never touch reminders, whatever the setting (L21 follow-up)", () => {
  it("follow-ups off, then a refused move: every table byte-identical", async () => {
    const u = await newUser();
    const other = await newUser();
    const app = await newApplication(u);
    const foreign = (await stageNamed(other, "Screening")).id;
    await setFollowUpDays(db, u, { followUpDays: "off" });
    const before = await snapshot();
    expect((await moveApplication(db, u, app.id, { stageId: foreign, index: 0 })).ok).toBe(false);
    expect(await snapshot()).toBe(before);
  });

  it("follow-ups off, then a reorder or a same-stage edit: reminders byte-identical", async () => {
    const u = await newUser();
    const app = await newApplication(u);
    await setFollowUpDays(db, u, { followUpDays: "off" });
    const before = await reminderRows();
    expect((await moveApplication(db, u, app.id, { stageId: app.stageId, index: 0 })).ok).toBe(true);
    expect((await updateApplication(db, u, app.id, { companyName: "Acme", role: "Engineer", stageId: app.stageId })).ok).toBe(true);
    expect(await reminderRows()).toBe(before);
    expect(await followUps(u, app.id)).toHaveLength(1);
  });

  it("follow-ups back on, then a refused edit, refused move and reorder: reminders byte-identical, none created", async () => {
    const u = await newUser();
    const other = await newUser();
    await setFollowUpDays(db, u, { followUpDays: "off" });
    const app = await newApplication(u);
    await setFollowUpDays(db, u, { followUpDays: "7" });
    const foreign = (await stageNamed(other, "Screening")).id;
    const before = await snapshot();
    expect((await updateApplication(db, u, app.id, { companyName: "Acme", role: "Engineer", stageId: foreign })).ok).toBe(false);
    expect((await moveApplication(db, u, app.id, { stageId: foreign, index: 0 })).ok).toBe(false);
    expect(await snapshot()).toBe(before);
    expect((await moveApplication(db, u, app.id, { stageId: app.stageId, index: 0 })).ok).toBe(true);
    expect(await followUps(u, app.id)).toHaveLength(0);
  });

  it("refused archive (foreign id) changes nothing; a stage change with follow-ups off still closes the old one", async () => {
    const u = await newUser();
    const intruder = await newUser();
    const app = await newApplication(u);
    const before = await snapshot();
    expect((await setApplicationArchived(db, intruder, app.id, true)).ok).toBe(false);
    expect(await snapshot()).toBe(before);
    await setFollowUpDays(db, u, { followUpDays: "off" });
    expect((await moveApplication(db, u, app.id, { stageId: (await stageNamed(u, "Screening")).id, index: 0 })).ok).toBe(true);
    const all = await followUps(u, app.id);
    expect(all).toHaveLength(1);
    expect(all[0].doneAt).not.toBeNull();
  });
});
