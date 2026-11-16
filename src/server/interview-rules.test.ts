import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { interview, user } from "@/db/schema";
import { createTestDb } from "@/test/db";
import { INTERVIEW_PENDING_PAST_MESSAGE, isMoreThanAYearAgo } from "@/lib/validation/interview";

vi.mock("server-only", () => ({}));

const { createApplication } = await import("./applications");
const { createInterview, updateInterview, setInterviewOutcome, listInterviews } = await import("./interviews");

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

const PAST = "2025-03-10T15:00:00.000Z";
const FUTURE = "2035-03-10T15:00:00.000Z";
const refused = { ok: false, reason: "invalid", fieldErrors: { outcome: [INTERVIEW_PENDING_PAST_MESSAGE] } };

async function newUser() {
  counter += 1;
  const id = `interview-rule-user-${counter}`;
  await db.insert(user).values({ id, name: `User ${counter}`, email: `irule${counter}@example.com` });
  return id;
}

async function newApplication(userId: string) {
  const result = await createApplication(db, userId, { companyName: "Acme", role: "Engineer" });
  if (!result.ok) throw new Error("create failed");
  return result.application;
}

async function snapshot() {
  return JSON.stringify(await db.select().from(interview).orderBy(interview.id));
}

describe("pending interviews must be in the future", () => {
  it("states the rule in English and suggests recording the outcome", () => {
    expect(INTERVIEW_PENDING_PAST_MESSAGE).toBe("This interview already happened. Record its outcome instead of Pending.");
  });

  it("refuses creating a past interview as pending (explicit or default) and stores nothing", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);
    const before = await snapshot();
    expect(await createInterview(db, userId, app.id, { scheduledAt: PAST, type: "video" })).toEqual(refused);
    expect(await createInterview(db, userId, app.id, { scheduledAt: PAST, type: "video", outcome: "pending" })).toEqual(
      refused,
    );
    expect(await snapshot()).toBe(before);
  });

  it("accepts a past interview with an outcome and a future one as pending", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);
    expect(await createInterview(db, userId, app.id, { scheduledAt: PAST, type: "video", outcome: "passed" })).toMatchObject({
      ok: true,
      interview: { outcome: "passed" },
    });
    expect(await createInterview(db, userId, app.id, { scheduledAt: FUTURE, type: "video" })).toMatchObject({
      ok: true,
      interview: { outcome: "pending" },
    });
  });

  it("refuses an edit that leaves or makes a past interview pending, with no change", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);
    const created = await createInterview(db, userId, app.id, { scheduledAt: FUTURE, type: "video" });
    if (!created.ok) throw new Error("create failed");
    const before = await snapshot();
    expect(await updateInterview(db, userId, created.interview.id, { scheduledAt: PAST, type: "video" })).toEqual(refused);
    expect(
      await updateInterview(db, userId, created.interview.id, { scheduledAt: PAST, type: "phone", outcome: "pending", notes: "x" }),
    ).toEqual(refused);
    expect(await snapshot()).toBe(before);
    expect(
      await updateInterview(db, userId, created.interview.id, { scheduledAt: PAST, type: "phone", outcome: "failed" }),
    ).toMatchObject({ ok: true, interview: { outcome: "failed" } });
  });

  it("refuses setting a past interview's outcome back to pending, with no change; a future one may", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);
    const past = await createInterview(db, userId, app.id, { scheduledAt: PAST, type: "video", outcome: "passed" });
    const future = await createInterview(db, userId, app.id, { scheduledAt: FUTURE, type: "video", outcome: "cancelled" });
    if (!past.ok || !future.ok) throw new Error("create failed");
    const before = await snapshot();
    expect(await setInterviewOutcome(db, userId, past.interview.id, "pending")).toEqual({ ok: false, reason: "pending_past" });
    expect(await snapshot()).toBe(before);
    expect(await setInterviewOutcome(db, userId, future.interview.id, "pending")).toMatchObject({
      ok: true,
      interview: { outcome: "pending" },
    });
    expect(await setInterviewOutcome(db, userId, past.interview.id, "failed")).toMatchObject({
      ok: true,
      interview: { outcome: "failed" },
    });
  });

  it("flags existing past interviews still pending, so the page can ask for the outcome", async () => {
    const userId = await newUser();
    const app = await newApplication(userId);
    // Stored before the rule existed.
    await db.insert(interview).values({ userId, applicationId: app.id, scheduledAt: new Date(PAST), type: "phone" });
    await createInterview(db, userId, app.id, { scheduledAt: FUTURE, type: "video" });
    await createInterview(db, userId, app.id, { scheduledAt: PAST, type: "onsite", outcome: "passed" });
    expect((await listInterviews(db, userId, app.id))?.map((i) => [i.type, i.needsOutcome])).toEqual([
      ["phone", true],
      ["onsite", false],
      ["video", false],
    ]);
  });

  it("other users cannot change or probe the outcome", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const app = await newApplication(alice);
    const created = await createInterview(db, alice, app.id, { scheduledAt: PAST, type: "video", outcome: "passed" });
    if (!created.ok) throw new Error("create failed");
    const before = await snapshot();
    expect(await setInterviewOutcome(db, bob, created.interview.id, "pending")).toEqual({ ok: false, reason: "not_found" });
    expect(await updateInterview(db, bob, created.interview.id, { scheduledAt: PAST, type: "video" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await createInterview(db, bob, app.id, { scheduledAt: PAST, type: "video" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await snapshot()).toBe(before);
  });
});

describe("isMoreThanAYearAgo (client warning)", () => {
  const now = new Date("2026-11-16T12:00:00Z");
  it.each([
    ["2025-11-16T11:59:00Z", true],
    ["2025-11-16T12:01:00Z", false],
    ["2026-01-01T00:00:00Z", false],
    ["2030-01-01T00:00:00Z", false],
  ])("%s → %s", (value, expected) => {
    expect(isMoreThanAYearAgo(new Date(value), now)).toBe(expected);
  });
  it("is false for an invalid date", () => {
    expect(isMoreThanAYearAgo(new Date("nope"), now)).toBe(false);
  });
});
