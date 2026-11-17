# laFija

Job application tracker: register applications, move them through configurable stages on a kanban board, log interviews and contacts, get follow-up reminders by email, and see statistics about your search.

> Work in progress. Specification and task list: [`odd/tasks/lafija.md`](odd/tasks/lafija.md).

## Stack

Next.js (App Router, Cache Components) + TypeScript · PostgreSQL on Neon · Drizzle ORM · Zod · Better Auth · Tailwind CSS + shadcn/ui · dnd-kit · fractional-indexing · Resend · Upstash QStash · Vitest · Playwright.
Planned: Recharts, deploy on Vercel.

## Requirements

- Node.js 24
- A PostgreSQL database (a free [Neon](https://neon.tech) project works)

## Setup

```bash
npm install
npx playwright install chromium
```

Create a `.env.local` file in the project root (it is git-ignored) with:

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string, `postgres://` or `postgresql://` (Neon: *Connection string*, pooled). |
| `BETTER_AUTH_SECRET` | yes | Random string of at least 32 characters used to sign sessions. Generate one with `openssl rand -base64 32`. |
| `BETTER_AUTH_URL` | yes | Public base URL of the app, e.g. `http://localhost:3000` locally. |
| `GOOGLE_CLIENT_ID` | yes | OAuth client ID from Google Cloud (see below). |
| `GOOGLE_CLIENT_SECRET` | yes | OAuth client secret from Google Cloud. |
| `QSTASH_CURRENT_SIGNING_KEY` | no (email) | QStash current signing key (Upstash console → QStash → *Signing keys*). |
| `QSTASH_NEXT_SIGNING_KEY` | no (email) | QStash next signing key (same page); both are needed so key rotation keeps working. |
| `RESEND_API_KEY` | no (email) | Resend API key, starts with `re_`. |
| `EMAIL_FROM` | no (email) | Sender, `address` or `Name <address>`, e.g. `laFija <onboarding@resend.dev>` (works without a domain). |
| `EMAIL_ALLOWED_RECIPIENTS` | no | Comma-separated addresses that may receive reminder and verification emails, compared ignoring case, e.g. `you@example.com`. Unset or empty: **nobody** gets email. `*` allows every address; use it only with a verified sending domain. Listing an address never bypasses email verification. |

The app validates the required variables on first use and fails with `Invalid environment variables: <names>`, listing only the variable names, never their values. The email variables are optional and parsed separately: an empty value counts as unset, and without the first four the app works normally, reminders stay in-app and the cron endpoint answers 503. A **malformed** email variable disables only email: the server logs `Email delivery is disabled: invalid environment variables: <names>` once (names only), the cron endpoint answers 503, `npm run reminders:send` exits with `Email is misconfigured. Invalid: <names>`, and Settings and the verification banner say email is unavailable. Sign-in and every other page keep working.

### Reminder emails (Resend + QStash)

**Who gets reminder emails** (S17): a user is emailed only when (1) email delivery is configured, (2) their address is verified, (3) their **Email me due reminders** switch is on, and (4) `EMAIL_ALLOWED_RECIPIENTS` is `*` or lists their address. Being listed does not bypass verification. **Settings → Email** lists whichever of these conditions fails for the signed-in user (never variable names, values or the list itself).

**Email verification**: email/password sign-up sends a verification link (Better Auth `emailVerification`, same Resend sender and `EMAIL_FROM` as reminders; the link works for 24 hours). Sign-in is never blocked. While the address is unverified, every dashboard page shows a banner with **Resend verification email** (the signed-in user's own address only, at most once a minute); the link lands on `/verify-email`, which confirms success or explains an expired or invalid link. A verification email is sent only when email is configured and the address passes the allowlist; otherwise nothing is sent and the banner says why (e.g. "Email delivery is limited while laFija has no domain, so the verification email cannot be sent to your address."). Google sign-in counts as verified when Google reports the address as verified (`email_verified` in its id token); a Google account whose claim is false stays unverified and gets a verification link like a password sign-up. Better Auth's public `POST /api/auth/send-verification-email` is disabled (404), so nobody can trigger a send to another address.

Due reminders are emailed as **one digest per user per run** ("3 reminders due on laFija"), with a plain text and an HTML part, a link to each application (`<BETTER_AUTH_URL>/dashboard/applications/<id>`) and to `/dashboard/reminders`. Company, role and message are HTML-escaped.

1. **Resend**: create an API key at [resend.com](https://resend.com) → `RESEND_API_KEY`. Without a verified domain, use the test sender `EMAIL_FROM="laFija <onboarding@resend.dev>"`; Resend then only delivers to the address of your Resend account, so set `EMAIL_ALLOWED_RECIPIENTS` to that address (and verify it in laFija: open the link, or sign in with Google). Other users keep their reminders in-app: they are never claimed and stay unsent.
2. **Emailing everyone later**: verify a domain in Resend, set `EMAIL_FROM` to an address on it, and set `EMAIL_ALLOWED_RECIPIENTS=*` (or a full list). Configuration only, no code change. Every user with a verified address and the switch on then gets email, so nobody can sign up with someone else's address and send them digests.
3. **QStash schedule** (Upstash console → QStash → *Schedules*): destination `https://<deployed-url>/api/cron/reminders`, method **POST**, cron `*/15 * * * *`, empty body. The URL must be exactly `BETTER_AUTH_URL` + `/api/cron/reminders`: the signature's subject is checked against it. Copy both signing keys into `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY` on the deployment.
4. **Locally**, QStash cannot reach `localhost`. Run the same job once with `npm run reminders:send -- --env-file <your local env file>` (or with the variables already exported in your shell). It uses `DATABASE_URL` and the real Resend key and prints only the summary, e.g. `{"claimed":2,"sent":2,"failed":0,"skipped":1}`.

How it works:

- `POST /api/cron/reminders` (`src/app/api/cron/reminders/route.ts`, logic in `src/server/reminder-cron.ts`) answers **503** when email is not configured, then verifies the `Upstash-Signature` JWT over the raw body with `Receiver` from `@upstash/qstash` (current or next key, issuer, expiry, body hash, URL); a missing or invalid signature is **401** and the database is not touched. Only POST is exported, so other methods get **405**. It is not under `src/proxy.ts` (that matcher is `/dashboard/*` only). A valid signature can be replayed for up to 5 minutes; that only triggers another run, which sends nothing twice.
- The job (`sendDueReminderEmails` in `src/server/reminder-emails.ts`) **leases** due reminders in **one statement**: due (`due_at <= now`), not done, not sent, application not archived, the S17 recipient rule, and not leased (or leased more than **30 minutes** ago). It sets `email_claimed_at = now` with `FOR UPDATE SKIP LOCKED`, oldest first, at most 200 per run, so overlapping runs never claim the same reminder. It then sends one digest per user. When the digest is accepted, that user's reminders still leased by this run (same claim time and ids) get `sent_at` and the lease is cleared; when it fails, only those leases are cleared and the next run retries them; other users are untouched. If the process dies mid-send, its leases expire after 30 minutes and a later run sends them (S19). Each send carries a Resend idempotency key derived from the user and the reminders with their due times, never the claim time, so a retry after a lost response, or a re-claim after a crash, is dropped by Resend within its idempotency window instead of delivered twice.
- The JSON summary counts reminders: `claimed`, `sent`, `failed` (released for retry) and `skipped` (due but the recipient rule fails: unverified address, switch off or address not allowed).
- Migration `0008_email_claim_lease` adds `reminder.email_claimed_at` and `user_settings.verification_email_sent_at` (both empty; existing `sent_at` values are unchanged). Apply it with `npm run db:migrate`.
- **Settings → Email → Email me due reminders** (`user_settings.email_reminders`, on by default) turns email off per user; reminders always show in-app.
- **Snoozing**, or editing the due time to another minute, clears `sent_at` and any lease (`email_claimed_at`), so the reminder is emailed again when it falls due at its new time. Marking a reminder done before it is due means it is never emailed.

Then create the tables: `npm run db:migrate`.

### Google sign-in

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an **OAuth client ID** of type **Web application**.
2. Authorized JavaScript origin: `http://localhost:3000` (add the production URL when deploying).
3. Authorized redirect URI: `http://localhost:3000/api/auth/callback/google` (and `https://<your-domain>/api/auth/callback/google` in production).
4. Copy the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

## Authentication model

- `src/proxy.ts` only checks that a session cookie exists on `/dashboard/*` and redirects to `/sign-in?next=...` otherwise. It is a convenience, not a security boundary.
- `requireUser()` in `src/lib/session.ts` verifies the session against the database. Every page, Server Action and query on user data must call it and filter by the returned user's `id`.
- `?next=` targets are sanitized by `safeNextPath()` so sign-in can only redirect within the app.
- Google sign-in never attaches to an existing account with the same email (Better Auth `account.accountLinking.disableImplicitLinking`). Better Auth redirects to `/sign-in?error=account_not_linked` and the page asks the user to sign in with email and password. Other OAuth errors land on `/sign-in` with a generic message (`onAPIError.errorURL`).
- Google access and refresh tokens are encrypted with `BETTER_AUTH_SECRET` before they are stored (`account.encryptOAuthTokens`). The Google id token is not stored, because Better Auth would keep it in plaintext and the app does not use it. Changing `BETTER_AUTH_SECRET` makes stored Google tokens unreadable; users only need to sign in with Google again.

## Data model

Better Auth owns `user`, `session`, `account` and `verification`. App tables (all deleted with their user):

| Table | Columns | Rules |
| --- | --- | --- |
| `company` | `id`, `user_id`, `name`, `website`, `notes`, `created_at`, `updated_at` | Unique per user on `lower(name)`: "Acme" and "ACME" are one company. |
| `stage` | `id`, `user_id`, `name`, `category` (enum `active`, `offer`, `rejected`, `accepted`, `withdrawn`), `position`, `archived`, `created_at`, `updated_at` | Unique per user on `lower(name)`. Listed by `position` ascending. |
| `application` | `id`, `user_id`, `company_id`, `stage_id`, `role`, `url`, `source`, `salary_range`, `salary_currency` (ISO 4217, set exactly when `salary_range` is), `applied_at` (date), `notes` (free text, nullable), `archived`, `position` (board order key, `collate "C"`), `created_at`, `updated_at` | Indexed by `user_id` and `stage_id`. `(company_id, user_id)` references `company(id, user_id)` and `(stage_id, user_id)` references `stage(id, user_id)`, so an application can only point to its owner's company and stage. `stage_id` is required. |
| `stage_transition` | `id`, `user_id`, `application_id`, `from_stage_id` (null = created), `to_stage_id`, `at` | Append-only: app code inserts rows and never updates or deletes them; they go away only with their application or user (cascade). `(application_id, user_id)`, `(from_stage_id, user_id)` and `(to_stage_id, user_id)` reference rows of the same user. Indexed by `(user_id, at)`, `(application_id, at)`, `from_stage_id` and `to_stage_id`. |

| `interview` | `id`, `user_id`, `application_id`, `scheduled_at` (timestamptz), `type` (enum `phone`, `video`, `onsite`, `technical`, `other`), `notes`, `outcome` (enum `pending`, `passed`, `failed`, `cancelled`; default `pending`), `created_at`, `updated_at` | `(application_id, user_id)` references `application(id, user_id)` with cascade: deleted with its application. Indexed by `(application_id, scheduled_at)` and `user_id`. |
| `contact` | `id`, `user_id`, `company_id`, `name`, `role`, `email`, `linkedin`, `notes`, `created_at`, `updated_at` | `(company_id, user_id)` references `company(id, user_id)` with cascade: a contact belongs to a company, not to one application. |
| `application_contact` | `application_id`, `contact_id`, `user_id`, `company_id`, `created_at` | Primary key `(application_id, contact_id)`. `(application_id, company_id, user_id)` references `application` and `(contact_id, company_id, user_id)` references `contact`, both with cascade, so the database only accepts a link between an application and a contact of the **same company and user**, and deleting either side removes the link. |
| `reminder` | `id`, `user_id`, `application_id`, `kind` (enum `manual`, `follow_up`), `due_at` (timestamptz), `message` (1-500 characters), `transition_id` (follow-ups only), `sent_at` (set when its email is accepted), `email_claimed_at` (lease of a running email job, expires after 30 minutes; cleared on success, failure, snooze or a new due time), `due_customized` (the user edited the due time or snoozed), `done_at`, `created_at`, `updated_at` | `(application_id, user_id)` references `application` and `(transition_id, user_id)` references `stage_transition(id, user_id)`, both with cascade. A follow-up always has a transition and a manual reminder never does (check). Unique `transition_id` among follow-ups, and at most **one open follow-up per application** (partial unique index). Partial indexes `(user_id, due_at) where done_at is null` (due reminders per user) and `(due_at) where sent_at is null and done_at is null` (email job). |
| `user_settings` | `user_id` (primary key), `follow_up_days` (integer 1-60, default 7, null = automatic follow-ups off), `time_zone` (IANA name, null = not detected yet, treated as UTC), `default_currency` (ISO 4217, default `USD`), `email_reminders` (boolean, default true), `verification_email_sent_at` (last verification email; resends wait 60 seconds after it), `created_at`, `updated_at` | A missing row means the defaults (7 days, no zone, USD, email on). |

Data access lives in `src/server/` as plain functions taking `(db, userId, ...)`; every query filters by `userId`. Server Actions call `requireUser()` first and pass its `id`. Input is validated with the Zod schemas in `src/lib/validation/` (role and company required, `url` must be http(s), `applied_at` a real date not in the future in any time zone). Creating or editing an application takes a company name and finds or creates that user's company with `insert ... on conflict do nothing` followed by a select, because the Neon HTTP driver has no interactive transactions.

Pages: `/dashboard/board` (main view), `/dashboard/applications` (active list, `?view=archived` for archived), `/dashboard/applications/new`, `/dashboard/applications/<id>` (detail), `/dashboard/applications/<id>/edit`, `/dashboard/stages`, `/dashboard/reminders`, `/dashboard/settings`.

### Stages

- Every user starts with Applied, Screening, Interview (all `active`), Offer (`offer`), Rejected (`rejected`) and Accepted (`accepted`). `ensureDefaultStages()` in `src/server/stages.ts` inserts them in one `insert ... where not exists ... on conflict do nothing` statement, only when the user has no stage at all (archived included), so concurrent calls still give six stages. It runs when stages are listed or an application is created; sign-up itself is unchanged.
- The category is what statistics will use; names are free to change.
- On `/dashboard/stages` the user can create (appended at the end), rename, change the category, move up or down, archive, unarchive and delete stages.
- Delete is refused (`in_use`) while any application, archived or not, uses the stage, or while the stage appears in any stage transition (as `from` or `to`): archive it instead. The foreign keys from `application` and `stage_transition` enforce the same rule in the database.
- Archive is refused (`has_applications`) while non-archived applications are in the stage; move them first. Archived applications may stay in an archived stage.
- The last non-archived stage can be neither archived nor deleted (`last_stage`).
- Archive and delete check their rules inside the same `update`/`delete` statement that writes, because Neon HTTP has no interactive transactions.
- Application forms offer the non-archived stages in order; a new application defaults to the first one. Editing keeps the current stage even if it was archived since; choosing another user's stage, an archived stage or an unknown id is refused with "Choose a valid stage." and nothing changes.
- Migration `0002_stages` also works on a database that already has data: it creates the default stages for every existing user and puts every existing application in that user's Applied stage before making `stage_id` required.

### Board and stage history

- `/dashboard/board` has one column per non-archived stage, in stage order, with a card (company, role, applied date) for each non-archived application. Cards move within and between columns by mouse, touch or keyboard (focus a card, Space/Enter to pick it up, arrow keys to move, Space/Enter to drop, Escape to cancel); screen readers hear where the card is and where it was dropped, in English.
- A move shows immediately. The server re-checks it (`moveApplication` in `src/server/board.ts`): the application must be the user's and not archived (`not_found` otherwise) and the target stage must be the user's and not archived (`invalid` otherwise). On refusal or a network error the card goes back and the board shows why; nothing is stored.
- **Transitions** are recorded when an application is created (`null` → stage, at its `created_at`), when the edit form changes its stage, and when a card is moved to another column. Reordering within a column and edits that keep the stage record nothing. Each write and its transition are **one SQL statement** (`with moved as (update ... returning ...) insert into stage_transition ...`), because Neon HTTP has no interactive transactions: either both happen or neither does.
- **Order within a column** uses [`fractional-indexing`](https://github.com/rocicorp/fractional-indexing) string keys in `application.position`. A key between any two keys always exists, so a move rewrites only the moved row and never needs a rebalancing pass (which a numeric midpoint would need once floats run out of precision, and which would be a multi-row write). Keys sort by code unit, so the column is `collate "C"` and every query orders by `position collate "C", id`. The server computes the key from the card's neighbours at the target index (`src/server/ordering.ts`); two concurrent moves into the same gap can produce equal keys, which only ties the order (broken by id) and later moves still find a key after the tied ones. New applications and applications whose stage changes in the edit form go to the bottom of the column.
- **Unarchiving an application whose stage is archived is refused** with "Its stage is archived. Unarchive the stage, or edit the application into another stage, then unarchive it." Moving it automatically would record a stage change the user never made and skew statistics; refusing keeps the rule "no active application in an archived stage" without inventing history. The check is part of the unarchive `update` statement.
- Migration `0003_board` works on a populated database, inside the single transaction `drizzle-kit migrate` uses: it gives existing applications keys `c000`, `c001`, … per user and stage by `created_at` (archived ones included), then records one `null` → current stage transition per existing application at its `created_at`, so statistics have a starting point. Earlier moves were never recorded and cannot be recovered.

### Application detail: interviews, contacts and notes

- `/dashboard/applications/<id>` opens from the role on a board card or the **View** button in the list. Unknown ids and other users' ids show the 404 page.
- It shows the application (current stage, applied date, source, salary range, job posting) with an **Edit** link, then:
  - **Notes**: free text saved with **Save notes** (at most 10,000 characters; a blank field clears them).
  - **Interviews**, soonest first: add, edit, delete and **Set outcome**. Date and time is required; the browser sends the instant its `datetime-local` input means in the user's time zone (ISO with offset), and dates are shown in the reader's time zone. Type and outcome must be one of the enum values; anything else is refused with a field error and nothing changes.
  - **Contacts** linked to this application: **New contact** creates a contact in the application's company and links it in one statement; **Link an existing contact** lists the company's contacts not linked yet; **Edit**, **Unlink** (the contact stays) and **Delete** (removes it from every application). Name is required, email must be a valid address and LinkedIn an http(s) URL.
  - **Stage history** from `stage_transition`, oldest first: "Created in Applied", then "Applied → Screening", and so on, with the current stage names.
- Data functions: `src/server/interviews.ts`, `src/server/contacts.ts`, `updateApplicationNotes` in `src/server/applications.ts` and `listApplicationHistory` in `src/server/board.ts`. Each takes `(db, userId, ...)`, filters by the user, and returns `not_found` for unknown or foreign ids without changing anything; ids that cannot be ids (empty, over 100 characters, NUL bytes) are refused before any query.
- Linking (`linkContact`) is one `insert ... select` that joins the application and the contact on the same company and user, with `on conflict do nothing`: linking twice is a no-op, and a contact of another company is refused (`other_company`). The composite foreign keys of `application_contact` enforce the same rule in the database.
- Changing an application's company in the edit form removes its links to the old company's contacts in the same statement as the update (the contacts stay with their company); otherwise the foreign key would refuse the change.
- Migration `0004_application_detail` only adds the three tables, the `application.notes` column and a unique `(id, company_id, user_id)` on `application`; no backfill. Apply it with `npm run db:migrate` before using this version: the application pages read `application.notes`.

### Reminders and follow-ups

- **Manual reminders** live on the application page (**Reminders** section): add, edit (due date and time, message of 1-500 characters), **Done** / **Reopen**, **Snooze** (open reminders only) and **Delete**. Due times are entered in the browser's time zone and sent as an ISO instant with offset, like interviews. Invalid input is refused with field errors and nothing changes.
- **Automatic follow-ups**: every time an application enters a stage of category `active` (created there, moved there on the board, or moved there by the edit form), a `follow_up` reminder "Follow up with <company> about <role>" is created, due at **9:00 a.m. in the user's time zone** on the local date of the transition plus the user's follow-up days (default 7): `(((at at time zone tz)::date + days) + time '09:00') at time zone tz`, so a move at 23:30 on Monday with 7 days is due the next Monday at 9:00, and Postgres applies daylight saving time of that date. Without a stored zone the rule uses UTC. Any later stage change closes it (`done_at`), so moving to Offer, Rejected, Accepted or a withdrawn stage simply ends the follow-up; a move into another active stage closes the old one and starts a new one from the new transition. Archiving an application closes its open follow-up; unarchiving creates none. Reordering within a column, edits that keep the stage and refused writes record no transition and touch no reminder.
- Every create, edit, board move and archive runs **two statements in one transaction** (`runAtomic` in `src/server/atomic.ts`: one `db.batch` request on Neon HTTP, which has no interactive transactions; `db.transaction` on PGlite in tests): (a) the application write with its row lock and transition, unchanged, then (b) the follow-up step (`src/server/reminders.ts`). For create, move and edit it is `syncFollowUpSql`, which acts only on a transition of this application written in this transaction (`stage_transition.at` defaults to `now()`, fixed for the whole transaction, so it matches `at = now()`); without one (refused write, reorder, same-stage edit) it changes nothing. With one, the wanted state is one open follow-up for that transition when the application is not archived, the stage's category is `active` and follow-ups are on; (b) closes every other open follow-up of the application and inserts the wanted one unless a follow-up for that transition already exists (one marked done stays done). For archive it is `closeArchivedFollowUpSql`, which closes the open follow-up only if the application is archived, so a refused archive changes nothing. Under READ COMMITTED, (b) reads a snapshot taken after (a) got the row lock, so two concurrent writers of the same card cannot leave two open follow-ups, one in a non-active stage, or a unique-index error. The sync is idempotent.
- A follow-up marked done can be reopened only while it belongs to the application's latest transition into its current stage and the application is not archived; otherwise **Reopen** says "This follow-up belongs to an earlier stage and cannot be reopened." Reopen locks the application row first (same transaction), and if another follow-up of the application is open anyway it gets the same answer instead of an error. Editing the due time to another minute or snoozing clears `sent_at` and the email lease, so the new time is emailed again (T8, S19); a due time in the same minute as the stored one (the form submits whole minutes) keeps the stored time, `sent_at` and the lease, so editing only the message never re-sends.
- **Snooze** sets the due time to **1, 3 or 7 days from now** (the moment you press it), not from the current due time: snoozing a reminder that was due last week by 1 day makes it due tomorrow at this same time of day, and snoozing one due next month by 1 day brings it forward to tomorrow. It is not rounded to 9:00. Like editing the due time to another minute, it clears `sent_at` and the email lease (the reminder is emailed again at the new time, T8, S19) and marks the reminder `due_customized`. Code: `snoozeReminder` in `src/server/reminders.ts` (`due_at = now() + N days`).
- **Time zone**: every dashboard page header mounts a small client component while the user has no stored zone; it reads `Intl.DateTimeFormat().resolvedOptions().timeZone` and sends it to a Server Action, which stores it only if the zone is still empty (a zone the user chose is never overwritten) and only if Postgres knows it (`pg_timezone_names`, the same list `at time zone` uses). `/dashboard/settings` (linked from the dashboard and the reminders page) shows a select with those zones. Settings is its own page because the zone and the default currency are not reminder settings; follow-up days stay on the reminders page. Saving a zone, detected or chosen, moves the user's **open, unsent, non-customized** follow-ups to 9:00 in the new zone in the same statement, keeping each one's number of days; follow-ups the user edited or snoozed, sent ones, done ones and manual reminders keep their time. The settings row is locked first in the same transaction, so two concurrent changes apply one after the other.
- **In-app notifications**: every dashboard page has a header with **Reminders** and the number of due reminders (due now or earlier, not done, application not archived), linking to `/dashboard/reminders`. That page lists **Due**, **Upcoming** and **Done (last 30 days)**, each with Done / Reopen, Snooze and a link to the application, plus the setting **Follow up automatically after** *N days* (1-60) or *Off*. Changing the setting applies to later transitions only: it never touches an existing reminder (turning it off leaves open follow-ups open; a new number of days keeps their due time), and it only decides whether, and when due, a follow-up is created for the next transition into an active stage.
- Migration `0005_reminders` adds the tables, the enum and a unique `(id, user_id)` on `stage_transition`, then backfills one open follow-up for every non-archived application whose current stage is `active`, due 7 days after its latest transition and linked to it (so long-running applications may show as due right away). It runs inside the single transaction `drizzle-kit migrate` uses; apply it with `npm run db:migrate` before using this version. Emailing due reminders is described in [Reminder emails](#reminder-emails-resend--qstash); migration `0007_email_reminders` adds `user_settings.email_reminders` (default true, nothing else changes). Apply it with `npm run db:migrate`.

### Applied date, interviews and salary currency

- **Applied date autofill**: when an application is created in, or moved to (board or edit form), a stage whose position is greater than the smallest position among the user's non-archived stages ("after the first stage", by default after Applied) and it has no applied date, the date of that transition in the user's time zone (UTC while none is stored) is stored. It is part of the same statement that writes the transition, so a refused write or a reorder within a column changes nothing. A date the user typed is never overwritten; edits that keep the stage never fill it.
- **Interviews**: an interview whose date has passed cannot be **Pending**. Creating or editing one that way, or setting its outcome back to Pending, is refused with "This interview already happened. Record its outcome instead of Pending." and nothing changes (the outcome check is part of the update). Interviews stored as Pending before this rule show "Record the outcome" on the application page. The form warns, without blocking, "This date is more than a year ago." when the date is over a year back (often a typo in the year).
- **Salary currency**: every salary has a currency (`application.salary_currency`, ISO 4217). The form offers USD, EUR, ARS, BRL, CLP, COP, MXN, PEN, UYU, GBP and CAD, preselecting the application's currency or the user's default (Settings, initially USD). A salary without a currency is refused with "Choose the currency of the salary.", an invalid code with "Choose a valid currency."; without a salary no currency is stored. A database check enforces "currency exactly when there is a salary". The salary is always shown with its currency ("50k-60k EUR") on the application page and in the applications list.
- Migration `0006_time_zone_currency_and_due_rules` adds `user_settings.time_zone` (null), `user_settings.default_currency` (`USD`), `application.salary_currency` and `reminder.due_customized` (false). It sets `USD` on existing applications that have a salary, and marks customized every open follow-up whose due time is not exactly its transition plus the user's follow-up days (7 when unset or off), so the first time zone detection realigns only untouched follow-ups. Nothing else changes. It runs inside the single transaction `drizzle-kit migrate` uses; apply it with `npm run db:migrate` before using this version.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server on http://localhost:3000 |
| `npm run build` / `npm start` | Production build and server |
| `npm run lint` | ESLint |
| `npm run typecheck` | Generate route types, then TypeScript without emitting |
| `npm test` | Unit and integration tests (Vitest; database tests run on in-memory PGlite, no setup needed) |
| `npm run test:e2e` | End-to-end tests (Playwright, starts its own server on port 3100) Next allows one `next dev` per folder: if yours is running, use `PLAYWRIGHT_BASE_URL=http://localhost:3000 npm run test:e2e`. |
| `npm run db:generate` | Generate a SQL migration from `src/db/schema.ts` into `drizzle/` |
| `npm run db:migrate` | Apply pending migrations to `DATABASE_URL` |
| `npm run db:studio` | Browse the database with Drizzle Studio |
| `npm run reminders:send` | Run the reminder email job once against `DATABASE_URL` with the real Resend key (add `-- --env-file <file>` to load variables from a file); prints the summary only |
