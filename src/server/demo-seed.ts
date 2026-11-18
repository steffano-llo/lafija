import "server-only";

import {
  application,
  applicationContact,
  company,
  contact,
  interview,
  reminder,
  stage,
  stageTransition,
} from "@/db/schema";
import type { InterviewOutcome, InterviewType } from "@/lib/validation/interview";
import { FOLLOW_UP_DAYS_DEFAULT } from "@/lib/validation/reminder";
import type { SOURCE_PRESETS } from "@/lib/validation/source";
import type { StageCategory } from "@/lib/validation/stage";
import type { Db } from "./applications";
import { runAtomic } from "./atomic";
import { keyAfter } from "./ordering";
import { DEFAULT_STAGES } from "./stages";

/**
 * Sample search for a demo account (S6): the default stages plus a Wishlist stage (first) and a
 * Withdrawn stage (last), 20 applications over the last ~10 weeks with their full stage history,
 * interviews (past ones with an outcome, two upcoming pending), five linked contacts, open
 * follow-ups for applications in active stages (six of them already due) and three manual
 * reminders (one due, one upcoming, one done). The content is fixed; every date is relative to
 * `now`, so two demo accounts created at the same instant get identical data (except ids).
 */

type StageKey = "wishlist" | "applied" | "screening" | "interview" | "offer" | "rejected" | "accepted" | "withdrawn";

const STAGES: readonly { key: StageKey; name: string; category: StageCategory }[] = [
  { key: "wishlist", name: "Wishlist", category: "wishlist" },
  ...DEFAULT_STAGES.map(({ name, category }) => ({ key: name.toLowerCase() as StageKey, name, category })),
  { key: "withdrawn", name: "Withdrawn", category: "withdrawn" },
];

type Source = (typeof SOURCE_PRESETS)[number];

type SeedInterview = { daysAgo: number; type: InterviewType; outcome: InterviewOutcome; notes?: string };

type SeedApplication = {
  company: string;
  website?: string;
  role: string;
  source: Source;
  salary?: [string, string];
  notes?: string;
  /** Stage history, oldest first: [stage, days ago]. The first entry is the creation. */
  steps: [StageKey, number][];
  /** Negative `daysAgo` = upcoming. */
  interviews?: SeedInterview[];
  contact?: { name: string; role: string; email: string; linkedin?: string };
};

const APPLICATIONS: readonly SeedApplication[] = [
  { company: "Globant", role: "Senior Frontend Engineer", source: "LinkedIn", steps: [["wishlist", 3]], notes: "Ask Martín for a referral first." },
  { company: "Mercado Libre", role: "Fullstack Developer", source: "Get on Board", steps: [["wishlist", 1]] },
  { company: "Despegar", role: "React Developer", source: "LinkedIn", salary: ["3,000–3,800 / month", "USD"], steps: [["applied", 5]] },
  { company: "Ualá", role: "Frontend Engineer", source: "Bumeran", steps: [["applied", 9]] },
  { company: "Rappi", role: "Software Engineer, Web", source: "Indeed", salary: ["2,800–3,500 / month", "USD"], steps: [["applied", 12]] },
  { company: "Belo", role: "Frontend Developer", source: "Computrabajo", steps: [["wishlist", 20], ["applied", 16]] },
  { company: "Platzi", role: "Frontend Engineer", source: "Referido", salary: ["3,200 / month", "USD"], steps: [["applied", 18], ["screening", 4]] },
  { company: "Auth0", role: "UI Engineer", source: "LinkedIn", salary: ["70,000–85,000 / year", "USD"], steps: [["applied", 25], ["screening", 11]] },
  {
    company: "Kavak",
    role: "Senior React Developer",
    source: "LinkedIn",
    salary: ["4,000–5,000 / month", "USD"],
    steps: [["applied", 30], ["screening", 22], ["interview", 8]],
    interviews: [
      { daysAgo: 20, type: "phone", outcome: "passed", notes: "Recruiter call: team, stack and salary range." },
      { daysAgo: 7, type: "technical", outcome: "passed", notes: "Live coding: a debounced search box." },
      { daysAgo: -3, type: "technical", outcome: "pending", notes: "System design with the frontend lead." },
    ],
    contact: { name: "Lucía Fernández", role: "Technical Recruiter", email: "lucia.fernandez@example.com" },
  },
  {
    company: "Nubank",
    role: "Frontend Engineer",
    source: "Get on Board",
    steps: [["applied", 28], ["screening", 20], ["interview", 2]],
    interviews: [
      { daysAgo: 18, type: "video", outcome: "passed" },
      { daysAgo: -6, type: "onsite", outcome: "pending", notes: "Half day at the office: pairing and culture interview." },
    ],
    contact: { name: "Diego Martínez", role: "Engineering Manager", email: "diego.martinez@example.com" },
  },
  {
    company: "Mural",
    role: "Frontend Engineer",
    source: "Referido",
    salary: ["5,000 / month", "USD"],
    steps: [["applied", 45], ["screening", 38], ["interview", 30], ["offer", 6]],
    interviews: [
      { daysAgo: 37, type: "video", outcome: "passed" },
      { daysAgo: 31, type: "technical", outcome: "passed", notes: "Take-home review: accessibility questions." },
    ],
    contact: { name: "Sofía Gómez", role: "Talent Partner", email: "sofia.gomez@example.com" },
  },
  {
    company: "Etermax",
    role: "Product Engineer",
    source: "LinkedIn",
    salary: ["3,600,000 / month", "ARS"],
    steps: [["applied", 66], ["screening", 58], ["interview", 50], ["offer", 40], ["accepted", 35]],
    interviews: [
      { daysAgo: 56, type: "video", outcome: "passed" },
      { daysAgo: 48, type: "onsite", outcome: "passed" },
    ],
    contact: { name: "Martín López", role: "Frontend Lead", email: "martin.lopez@example.com" },
  },
  { company: "Accenture", role: "Frontend Developer", source: "Indeed", steps: [["applied", 60], ["rejected", 48]] },
  { company: "Lemon", role: "React Native Developer", source: "LinkedIn", steps: [["applied", 55], ["screening", 47], ["rejected", 40]] },
  {
    company: "Tiendanube",
    role: "Frontend Engineer",
    source: "Bumeran",
    salary: ["2,500,000 / month", "ARS"],
    steps: [["applied", 50], ["screening", 44], ["interview", 36], ["rejected", 29]],
    interviews: [{ daysAgo: 35, type: "technical", outcome: "failed", notes: "Ran out of time on the state management part." }],
    contact: { name: "Valentina Ruiz", role: "Recruiter", email: "valentina.ruiz@example.com" },
  },
  { company: "Workana", role: "UI Developer", source: "Computrabajo", steps: [["applied", 40], ["rejected", 33]] },
  {
    company: "Pomelo",
    role: "Frontend Engineer",
    source: "Get on Board",
    salary: ["3,000–3,600 / month", "USD"],
    steps: [["applied", 35], ["screening", 27], ["interview", 21], ["rejected", 15]],
    interviews: [{ daysAgo: 20, type: "video", outcome: "failed" }],
  },
  {
    company: "Naranja X",
    role: "Frontend Developer",
    source: "Indeed",
    steps: [["applied", 42], ["screening", 34], ["withdrawn", 26]],
    interviews: [{ daysAgo: 33, type: "phone", outcome: "cancelled", notes: "Withdrew after accepting another process." }],
    notes: "Withdrew: the role was mostly back office.",
  },
  { company: "Wildlife Studios", role: "Web Developer", source: "Referido", salary: ["4,200 / month", "USD"], steps: [["applied", 3]] },
  { company: "Huenei", role: "Frontend Developer", source: "Computrabajo", steps: [["applied", 68]] },
];

/** Manual reminders: [company, message, due days ago (negative = upcoming), done days ago or null]. */
const MANUAL_REMINDERS: readonly [string, string, number, number | null][] = [
  ["Mural", "Answer the offer: ask about equity and the start date.", 1, null],
  ["Kavak", "Review system design notes before the interview.", -2, null],
  ["Mural", "Send the portfolio link to the recruiter.", 4, 3],
];

const DAY = 24 * 60 * 60 * 1000;

/**
 * Inserts the sample search for `userId` in one transaction (all rows or none). Stage changes are
 * backdated, which the app's own write functions cannot do (they stamp `now()`), so this writes the
 * same rows they would: applications with their history, applied date on the first non-wishlist
 * stage (UTC calendar, as for a user without a stored zone), one open follow-up per application
 * in an active stage due 7 days after its last move at 09:00 UTC.
 */
export async function seedDemoData(db: Db, userId: string, now: Date): Promise<void> {
  // Two hours back, so "0 days ago" is never in the future.
  const ago = (days: number) => new Date(now.getTime() - days * DAY - 2 * 60 * 60 * 1000);
  const id = () => crypto.randomUUID();

  const stageIds = new Map<StageKey, string>(STAGES.map(({ key }) => [key, id()]));
  const stageRows = STAGES.map(({ key, name, category }, position) => ({
    id: stageIds.get(key)!,
    userId,
    name,
    category,
    position,
    createdAt: ago(70),
    updatedAt: ago(70),
  }));

  const companyRows: (typeof company.$inferInsert)[] = [];
  const applicationRows: (typeof application.$inferInsert)[] = [];
  const transitionRows: (typeof stageTransition.$inferInsert)[] = [];
  const interviewRows: (typeof interview.$inferInsert)[] = [];
  const contactRows: (typeof contact.$inferInsert)[] = [];
  const linkRows: (typeof applicationContact.$inferInsert)[] = [];
  const reminderRows: (typeof reminder.$inferInsert)[] = [];
  const applicationIdByCompany = new Map<string, string>();
  const lastKey = new Map<StageKey, string | null>();

  for (const seed of APPLICATIONS) {
    const companyId = id();
    const applicationId = id();
    applicationIdByCompany.set(seed.company, applicationId);
    const created = ago(seed.steps[0][1]);
    companyRows.push({ id: companyId, userId, name: seed.company, createdAt: created, updatedAt: created });

    const transitions = seed.steps.map(([key, days], index) => ({
      id: id(),
      userId,
      applicationId,
      fromStageId: index === 0 ? null : stageIds.get(seed.steps[index - 1][0])!,
      toStageId: stageIds.get(key)!,
      at: ago(days),
    }));
    const firstApplied = seed.steps.find(([key]) => key !== "wishlist");
    const [currentKey, currentDays] = seed.steps[seed.steps.length - 1];
    const position = keyAfter(lastKey.get(currentKey) ?? null);
    lastKey.set(currentKey, position);

    applicationRows.push({
      id: applicationId,
      userId,
      companyId,
      stageId: stageIds.get(currentKey)!,
      role: seed.role,
      source: seed.source,
      salaryRange: seed.salary?.[0] ?? null,
      salaryCurrency: seed.salary?.[1] ?? null,
      appliedAt: firstApplied ? ago(firstApplied[1]).toISOString().slice(0, 10) : null,
      notes: seed.notes ?? null,
      position,
      createdAt: created,
      updatedAt: ago(currentDays),
    });
    transitionRows.push(...transitions);

    const currentCategory = STAGES.find(({ key }) => key === currentKey)!.category;
    if (currentCategory === "active") {
      const last = transitions[transitions.length - 1];
      const due = new Date(last.at.getTime() + FOLLOW_UP_DAYS_DEFAULT * DAY);
      due.setUTCHours(9, 0, 0, 0);
      reminderRows.push({
        id: id(),
        userId,
        applicationId,
        kind: "follow_up",
        dueAt: due,
        message: `Follow up on your application to ${seed.company}.`,
        transitionId: last.id,
        createdAt: last.at,
        updatedAt: last.at,
      });
    }

    for (const item of seed.interviews ?? []) {
      const scheduledAt = new Date(now.getTime() - item.daysAgo * DAY);
      scheduledAt.setUTCHours(15, 0, 0, 0);
      interviewRows.push({
        id: id(),
        userId,
        applicationId,
        scheduledAt,
        type: item.type,
        outcome: item.outcome,
        notes: item.notes ?? null,
        createdAt: created,
        updatedAt: created,
      });
    }

    if (seed.contact) {
      const contactId = id();
      contactRows.push({ id: contactId, userId, companyId, ...seed.contact, createdAt: created, updatedAt: created });
      linkRows.push({ applicationId, contactId, userId, companyId, createdAt: created });
    }
  }

  for (const [companyName, message, dueDaysAgo, doneDaysAgo] of MANUAL_REMINDERS) {
    const created = ago(Math.max(dueDaysAgo, 0) + 5);
    reminderRows.push({
      id: id(),
      userId,
      applicationId: applicationIdByCompany.get(companyName)!,
      kind: "manual",
      dueAt: ago(dueDaysAgo),
      message,
      doneAt: doneDaysAgo === null ? null : ago(doneDaysAgo),
      createdAt: created,
      updatedAt: created,
    });
  }

  await runAtomic(db, [
    db.insert(stage).values(stageRows).getSQL(),
    db.insert(company).values(companyRows).getSQL(),
    db.insert(application).values(applicationRows).getSQL(),
    db.insert(stageTransition).values(transitionRows).getSQL(),
    db.insert(interview).values(interviewRows).getSQL(),
    db.insert(contact).values(contactRows).getSQL(),
    db.insert(applicationContact).values(linkRows).getSQL(),
    db.insert(reminder).values(reminderRows).getSQL(),
  ]);
}
