import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { application, reminder, stageTransition, user, userSettings } from "@/db/schema";
import { createTestDb } from "@/test/db";
import { followUpDue, localDateIn } from "./test-zones";

vi.mock("server-only", () => ({}));

const { createApplication } = await import("./applications");
const { listStages } = await import("./stages");
const { moveApplication, listStageTransitions } = await import("./board");
const { listApplicationReminders, snoozeReminder, updateReminder, setReminderDone, setFollowUpDays } = await import(
  "./reminders"
);
const { getUserSettings, saveDetectedTimeZone, setTimeZone, listTimeZones } = await import("./settings");

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
  const id = `tz-user-${counter}`;
  await db.insert(user).values({ id, name: `User ${counter}`, email: `tz${counter}@example.com` });
  return id;
}

async function stageNamed(userId: string, name: string) {
  const found = (await listStages(db, userId)).find((s) => s.name === name);
  if (!found) throw new Error(`no stage ${name}`);
  return found;
}

async function newApplication(userId: string, input: Record<string, unknown> = {}) {
  const result = await createApplication(db, userId, { companyName: "Acme", role: "Engineer", ...input });
  if (!result.ok) throw new Error(`create failed: ${JSON.stringify(result)}`);
  return result.application;
}

async function openFollowUp(userId: string, applicationId: string) {
  const all = (await listApplicationReminders(db, userId, applicationId)) ?? [];
  return all.find((r) => r.kind === "follow_up" && r.doneAt === null);
}

async function latestTransition(userId: string, applicationId: string) {
  const all = (await listStageTransitions(db, userId)).filter((t) => t.applicationId === applicationId);
  return all[all.length - 1];
}

/** Raw rows of the tables these functions may touch. */
async function snapshot() {
  return JSON.stringify([
    await db.select().from(application).orderBy(application.id),
    await db.select().from(stageTransition).orderBy(stageTransition.id),
    await db.select().from(reminder).orderBy(reminder.id),
    await db.select().from(userSettings).orderBy(userSettings.userId),
  ]);
}

/**
 * An application of the user with a past transition at `at` and an open follow-up for it, due
 * `due` (written directly, like migration 0005 rows or follow-ups made under an earlier zone).
 */
async function seededFollowUp(
  userId: string,
  at: string,
  due: string,
  extra: { sentAt?: Date; doneAt?: Date; dueCustomized?: boolean } = {},
) {
  const app = await newApplication(userId, { role: `Seed ${at}` });
  // Close the follow-up its creation made, so the seeded one is the open one.
  const created = await openFollowUp(userId, app.id);
  if (created) await setReminderDone(db, userId, created.id, true);
  const [t] = await db
    .insert(stageTransition)
    .values({ userId, applicationId: app.id, fromStageId: app.stageId, toStageId: app.stageId, at: new Date(at) })
    .returning();
  const [r] = await db
    .insert(reminder)
    .values({
      userId,
      applicationId: app.id,
      kind: "follow_up",
      dueAt: new Date(due),
      message: "Follow up",
      transitionId: t.id,
      sentAt: extra.sentAt,
      doneAt: extra.doneAt,
      dueCustomized: extra.dueCustomized ?? false,
    })
    .returning();
  return r;
}

async function reminderRow(id: string) {
  const [row] = await db.select().from(reminder).where(eq(reminder.id, id));
  return row;
}

describe("follow-ups are due at 09:00 in the user's time zone", () => {
  it("uses UTC while no zone was detected", async () => {
    const userId = await newUser();
    expect(await getUserSettings(db, userId)).toEqual({ followUpDays: 7, timeZone: null, defaultCurrency: "USD" });
    const app = await newApplication(userId);
    const t = await latestTransition(userId, app.id);
    const due = (await openFollowUp(userId, app.id))?.dueAt;
    expect(due).toEqual(followUpDue(t.at, 7, "UTC"));
    expect(due?.toISOString()).toMatch(/T09:00:00\.000Z$/);
  });

  it.each(["America/Argentina/Buenos_Aires", "Asia/Tokyo", "Europe/Madrid"])(
    "creates and moves follow-ups due 09:00 %s on the local date plus N days",
    async (zone) => {
      const userId = await newUser();
      expect(await setTimeZone(db, userId, { timeZone: zone })).toEqual({ ok: true, timeZone: zone });
      expect(await setFollowUpDays(db, userId, { followUpDays: "3" })).toEqual({ ok: true, followUpDays: 3 });
      const app = await newApplication(userId);
      const created = await latestTransition(userId, app.id);
      expect((await openFollowUp(userId, app.id))?.dueAt).toEqual(followUpDue(created.at, 3, zone));

      const screening = await stageNamed(userId, "Screening");
      expect(await moveApplication(db, userId, app.id, { stageId: screening.id, index: 0 })).toEqual({ ok: true });
      const moved = await latestTransition(userId, app.id);
      const due = (await openFollowUp(userId, app.id))?.dueAt;
      expect(due).toEqual(followUpDue(moved.at, 3, zone));
      expect(
        new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(due),
      ).toBe("09:00");
    },
  );
});

describe("time zone detection", () => {
  it("saves the browser's zone only while none is stored", async () => {
    const userId = await newUser();
    expect(await saveDetectedTimeZone(db, userId, "Asia/Tokyo")).toEqual({ ok: true, saved: true });
    expect((await getUserSettings(db, userId)).timeZone).toBe("Asia/Tokyo");

    const before = await snapshot();
    expect(await saveDetectedTimeZone(db, userId, "Europe/Madrid")).toEqual({ ok: true, saved: false });
    expect((await getUserSettings(db, userId)).timeZone).toBe("Asia/Tokyo");
    expect(await snapshot()).toBe(before);
  });

  it("never overwrites a zone the user chose", async () => {
    const userId = await newUser();
    await setTimeZone(db, userId, { timeZone: "America/Argentina/Buenos_Aires" });
    expect(await saveDetectedTimeZone(db, userId, "Asia/Tokyo")).toEqual({ ok: true, saved: false });
    expect((await getUserSettings(db, userId)).timeZone).toBe("America/Argentina/Buenos_Aires");
  });

  it.each(["Mars/Olympus_Mons", "", "america/new_york", "UTC; drop table reminder", "x".repeat(200), 42, null, undefined])(
    "refuses the invalid zone %j and changes nothing",
    async (zone) => {
      const userId = await newUser();
      await newApplication(userId);
      const before = await snapshot();
      expect(await saveDetectedTimeZone(db, userId, zone)).toEqual({ ok: false, reason: "invalid" });
      expect(await setTimeZone(db, userId, { timeZone: zone })).toEqual({
        ok: false,
        reason: "invalid",
        fieldErrors: { timeZone: ["Choose a valid time zone."] },
      });
      expect(await snapshot()).toBe(before);
      expect((await getUserSettings(db, userId)).timeZone).toBeNull();
    },
  );

  it("lists the zones Postgres knows, including UTC and the browser's names", async () => {
    const zones = await listTimeZones(db);
    expect(zones).toEqual(expect.arrayContaining(["UTC", "Asia/Tokyo", "America/Argentina/Buenos_Aires", "Europe/Madrid"]));
    expect(zones).toEqual([...zones].sort());
  });
});

describe("saving a time zone realigns open, unsent, non-customized follow-ups", () => {
  it("moves them to 09:00 in the new zone, keeping their number of days, late-evening and DST transitions included", async () => {
    const userId = await newUser();
    // Undetected (UTC): rows made by the old rule, due exactly 7 days after the transition.
    const ba = await seededFollowUp(userId, "2026-03-10T02:30:00Z", "2026-03-17T02:30:00Z"); // 23:30 on 03-09 in Buenos Aires
    const tokyo = await seededFollowUp(userId, "2026-03-09T14:45:00Z", "2026-03-16T14:45:00Z"); // 23:45 on 03-09 in Tokyo
    const madrid = await seededFollowUp(userId, "2026-03-24T23:30:00Z", "2026-03-31T23:30:00Z"); // 00:30 on 03-25 (CET) in Madrid

    expect(await saveDetectedTimeZone(db, userId, "America/Argentina/Buenos_Aires")).toEqual({ ok: true, saved: true });
    expect((await reminderRow(ba.id)).dueAt).toEqual(new Date("2026-03-16T12:00:00Z"));
    expect((await reminderRow(tokyo.id)).dueAt).toEqual(new Date("2026-03-16T12:00:00Z"));

    await setTimeZone(db, userId, { timeZone: "Asia/Tokyo" });
    expect((await reminderRow(ba.id)).dueAt).toEqual(new Date("2026-03-17T00:00:00Z")); // 03-10 in Tokyo + 7
    expect((await reminderRow(tokyo.id)).dueAt).toEqual(new Date("2026-03-16T00:00:00Z")); // 03-09 in Tokyo + 7

    // Madrid switches to CEST on 2026-03-29: 09:00 on 04-01 is 07:00 UTC.
    await setTimeZone(db, userId, { timeZone: "Europe/Madrid" });
    expect((await reminderRow(madrid.id)).dueAt).toEqual(new Date("2026-04-01T07:00:00Z"));
    expect(localDateIn(new Date("2026-03-24T23:30:00Z"), "Europe/Madrid")).toBe("2026-03-25");

    const row = await reminderRow(madrid.id);
    expect(row).toEqual(expect.objectContaining({ sentAt: null, doneAt: null, dueCustomized: false }));
  });

  it("leaves customized, sent, done and manual reminders and other users' follow-ups untouched", async () => {
    const userId = await newUser();
    const other = await newUser();
    const at = "2026-03-10T02:30:00Z";
    const due = "2026-03-17T02:30:00Z";
    const customized = await seededFollowUp(userId, at, due, { dueCustomized: true });
    const sent = await seededFollowUp(userId, at, due, { sentAt: new Date("2026-03-17T02:31:00Z") });
    const done = await seededFollowUp(userId, at, due, { doneAt: new Date("2026-03-11T00:00:00Z") });
    const plain = await seededFollowUp(userId, at, due);
    const foreign = await seededFollowUp(other, at, due);
    const app = await newApplication(userId, { role: "Manual" });
    // Its own automatic follow-up would move too; only the manual reminder matters here.
    const auto = await openFollowUp(userId, app.id);
    if (auto) await setReminderDone(db, userId, auto.id, true);
    const [manual] = await db
      .insert(reminder)
      .values({ userId, applicationId: app.id, kind: "manual", dueAt: new Date(due), message: "Call" })
      .returning();
    // Every reminder row except the one that must move, byte for byte.
    const untouched = async () =>
      JSON.stringify(
        (await db.select().from(reminder).orderBy(reminder.id)).filter((r) => r.id !== plain.id),
      );
    const before = await untouched();

    expect(await setTimeZone(db, userId, { timeZone: "Asia/Tokyo" })).toEqual({ ok: true, timeZone: "Asia/Tokyo" });

    expect((await reminderRow(plain.id)).dueAt).toEqual(new Date("2026-03-17T00:00:00Z"));
    expect(await untouched()).toBe(before);
    for (const r of [customized, sent, done, manual, foreign]) expect((await reminderRow(r.id)).dueAt).toEqual(new Date(due));
    expect((await getUserSettings(db, other)).timeZone).toBeNull();
  });

  it("does not realign when a detection is ignored because a zone is stored", async () => {
    const userId = await newUser();
    await setTimeZone(db, userId, { timeZone: "Asia/Tokyo" });
    const seeded = await seededFollowUp(userId, "2026-03-10T02:30:00Z", "2026-03-20T05:00:00Z");
    expect(await saveDetectedTimeZone(db, userId, "Europe/Madrid")).toEqual({ ok: true, saved: false });
    expect((await reminderRow(seeded.id)).dueAt).toEqual(new Date("2026-03-20T05:00:00Z"));
  });
});

describe("due_customized", () => {
  it("is set by snooze and by a due-time edit to another minute, not by a message-only edit", async () => {
    const userId = await newUser();
    const a = await newApplication(userId, { role: "A" });
    const b = await newApplication(userId, { role: "B" });
    const fa = await openFollowUp(userId, a.id);
    const fb = await openFollowUp(userId, b.id);
    if (!fa || !fb) throw new Error("no follow-ups");
    expect(fa.dueCustomized).toBe(false);

    const renamed = await updateReminder(db, userId, fa.id, { dueAt: fa.dueAt.toISOString(), message: "Renamed" });
    expect(renamed).toEqual({ ok: true, reminder: expect.objectContaining({ dueCustomized: false, dueAt: fa.dueAt }) });

    const later = new Date(fa.dueAt.getTime() + 60 * 60 * 1000).toISOString();
    expect(await updateReminder(db, userId, fa.id, { dueAt: later, message: "Renamed" })).toEqual({
      ok: true,
      reminder: expect.objectContaining({ dueCustomized: true, dueAt: new Date(later) }),
    });
    expect(await snoozeReminder(db, userId, fb.id, 3)).toEqual({
      ok: true,
      reminder: expect.objectContaining({ dueCustomized: true }),
    });

    // A customized follow-up keeps its time when the zone changes.
    await setTimeZone(db, userId, { timeZone: "Asia/Tokyo" });
    expect((await reminderRow(fa.id)).dueAt).toEqual(new Date(later));
  });

  it("a refused snooze or edit leaves it unchanged", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);
    const f = await openFollowUp(userId, app.id);
    if (!f) throw new Error("no follow-up");
    const before = await snapshot();
    expect(await snoozeReminder(db, userId, f.id, 2)).toEqual({ ok: false, reason: "invalid" });
    expect(await updateReminder(db, userId, f.id, { dueAt: "nope", message: "x" })).toMatchObject({ ok: false });
    const other = await newUser();
    expect(await snoozeReminder(db, other, f.id, 1)).toEqual({ ok: false, reason: "not_found" });
    expect(await snapshot()).toBe(before);
  });
});

describe("isolation", () => {
  it("each user's zone only affects that user's follow-ups and settings", async () => {
    const alice = await newUser();
    const bob = await newUser();
    await setTimeZone(db, alice, { timeZone: "Asia/Tokyo" });
    const bobApp = await newApplication(bob);
    const t = await latestTransition(bob, bobApp.id);
    expect((await openFollowUp(bob, bobApp.id))?.dueAt).toEqual(followUpDue(t.at, 7, "UTC"));
    expect(await getUserSettings(db, bob)).toEqual({ followUpDays: 7, timeZone: null, defaultCurrency: "USD" });
    // Settings rows are per user: alice's has the zone, bob has none.
    const rows = await db.select().from(userSettings).where(eq(userSettings.userId, bob));
    expect(rows).toEqual([]);
  });
});
