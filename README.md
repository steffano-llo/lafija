# laFija

Job application tracker: register applications, move them through configurable stages on a kanban board, log interviews and contacts, get follow-up reminders by email, and see statistics about your search.

> Work in progress. Specification and task list: [`odd/tasks/lafija.md`](odd/tasks/lafija.md).

## Stack

Next.js (App Router, Cache Components) + TypeScript · PostgreSQL on Neon · Drizzle ORM · Zod · Better Auth · Tailwind CSS + shadcn/ui · dnd-kit · fractional-indexing · Vitest · Playwright.
Planned: Recharts, Resend, Upstash QStash, deploy on Vercel.

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

The app validates these variables on first use and fails with `Invalid environment variables: <names>`, listing only the variable names, never their values.

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
| `application` | `id`, `user_id`, `company_id`, `stage_id`, `role`, `url`, `source`, `salary_range`, `applied_at` (date), `notes` (free text, nullable), `archived`, `position` (board order key, `collate "C"`), `created_at`, `updated_at` | Indexed by `user_id` and `stage_id`. `(company_id, user_id)` references `company(id, user_id)` and `(stage_id, user_id)` references `stage(id, user_id)`, so an application can only point to its owner's company and stage. `stage_id` is required. |
| `stage_transition` | `id`, `user_id`, `application_id`, `from_stage_id` (null = created), `to_stage_id`, `at` | Append-only: app code inserts rows and never updates or deletes them; they go away only with their application or user (cascade). `(application_id, user_id)`, `(from_stage_id, user_id)` and `(to_stage_id, user_id)` reference rows of the same user. Indexed by `(user_id, at)`, `(application_id, at)`, `from_stage_id` and `to_stage_id`. |

| `interview` | `id`, `user_id`, `application_id`, `scheduled_at` (timestamptz), `type` (enum `phone`, `video`, `onsite`, `technical`, `other`), `notes`, `outcome` (enum `pending`, `passed`, `failed`, `cancelled`; default `pending`), `created_at`, `updated_at` | `(application_id, user_id)` references `application(id, user_id)` with cascade: deleted with its application. Indexed by `(application_id, scheduled_at)` and `user_id`. |
| `contact` | `id`, `user_id`, `company_id`, `name`, `role`, `email`, `linkedin`, `notes`, `created_at`, `updated_at` | `(company_id, user_id)` references `company(id, user_id)` with cascade: a contact belongs to a company, not to one application. |
| `application_contact` | `application_id`, `contact_id`, `user_id`, `company_id`, `created_at` | Primary key `(application_id, contact_id)`. `(application_id, company_id, user_id)` references `application` and `(contact_id, company_id, user_id)` references `contact`, both with cascade, so the database only accepts a link between an application and a contact of the **same company and user**, and deleting either side removes the link. |
| `reminder` | `id`, `user_id`, `application_id`, `kind` (enum `manual`, `follow_up`), `due_at` (timestamptz), `message` (1-500 characters), `transition_id` (follow-ups only), `sent_at` (set by the email job, T8), `done_at`, `created_at`, `updated_at` | `(application_id, user_id)` references `application` and `(transition_id, user_id)` references `stage_transition(id, user_id)`, both with cascade. A follow-up always has a transition and a manual reminder never does (check). Unique `transition_id` among follow-ups, and at most **one open follow-up per application** (partial unique index). Partial indexes `(user_id, due_at) where done_at is null` (due reminders per user) and `(due_at) where sent_at is null and done_at is null` (email job). |
| `user_settings` | `user_id` (primary key), `follow_up_days` (integer 1-60, default 7, null = automatic follow-ups off), `created_at`, `updated_at` | A missing row means the defaults (7 days). |

Data access lives in `src/server/` as plain functions taking `(db, userId, ...)`; every query filters by `userId`. Server Actions call `requireUser()` first and pass its `id`. Input is validated with the Zod schemas in `src/lib/validation/` (role and company required, `url` must be http(s), `applied_at` a real date not in the future in any time zone). Creating or editing an application takes a company name and finds or creates that user's company with `insert ... on conflict do nothing` followed by a select, because the Neon HTTP driver has no interactive transactions.

Pages: `/dashboard/board` (main view), `/dashboard/applications` (active list, `?view=archived` for archived), `/dashboard/applications/new`, `/dashboard/applications/<id>` (detail), `/dashboard/applications/<id>/edit`, `/dashboard/stages`, `/dashboard/reminders`.

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

- **Manual reminders** live on the application page (**Reminders** section): add, edit (due date and time, message of 1-500 characters), **Done** / **Reopen**, **Snooze** 1, 3 or 7 days from now (open reminders only) and **Delete**. Due times are entered in the browser's time zone and sent as an ISO instant with offset, like interviews. Invalid input is refused with field errors and nothing changes.
- **Automatic follow-ups**: every time an application enters a stage of category `active` (created there, moved there on the board, or moved there by the edit form), a `follow_up` reminder "Follow up with <company> about <role>" is created, due the user's follow-up days after the transition (default 7). Any later stage change closes it (`done_at`), so moving to Offer, Rejected, Accepted or a withdrawn stage simply ends the follow-up; a move into another active stage closes the old one and starts a new one from the new transition. Archiving an application closes its open follow-up; unarchiving creates none. Reordering within a column, edits that keep the stage and refused writes record no transition and touch no reminder.
- Every create, edit, board move and archive runs **two statements in one transaction** (`runAtomic` in `src/server/atomic.ts`: one `db.batch` request on Neon HTTP, which has no interactive transactions; `db.transaction` on PGlite in tests): (a) the application write with its row lock and transition, unchanged, then (b) the follow-up step (`src/server/reminders.ts`). For create, move and edit it is `syncFollowUpSql`, which acts only on a transition of this application written in this transaction (`stage_transition.at` defaults to `now()`, fixed for the whole transaction, so it matches `at = now()`); without one (refused write, reorder, same-stage edit) it changes nothing. With one, the wanted state is one open follow-up for that transition when the application is not archived, the stage's category is `active` and follow-ups are on; (b) closes every other open follow-up of the application and inserts the wanted one unless a follow-up for that transition already exists (one marked done stays done). For archive it is `closeArchivedFollowUpSql`, which closes the open follow-up only if the application is archived, so a refused archive changes nothing. Under READ COMMITTED, (b) reads a snapshot taken after (a) got the row lock, so two concurrent writers of the same card cannot leave two open follow-ups, one in a non-active stage, or a unique-index error. The sync is idempotent.
- A follow-up marked done can be reopened only while it belongs to the application's latest transition into its current stage and the application is not archived; otherwise **Reopen** says "This follow-up belongs to an earlier stage and cannot be reopened." Reopen locks the application row first (same transaction), and if another follow-up of the application is open anyway it gets the same answer instead of an error. Editing the due time to another minute or snoozing clears `sent_at`, so the new time is emailed again (T8); a due time in the same minute as the stored one (the form submits whole minutes) keeps the stored time and `sent_at`, so editing only the message never re-sends.
- **In-app notifications**: every dashboard page has a header with **Reminders** and the number of due reminders (due now or earlier, not done, application not archived), linking to `/dashboard/reminders`. That page lists **Due**, **Upcoming** and **Done (last 30 days)**, each with Done / Reopen, Snooze and a link to the application, plus the setting **Follow up automatically after** *N days* (1-60) or *Off*. Changing the setting applies to later transitions only: it never touches an existing reminder (turning it off leaves open follow-ups open; a new number of days keeps their due time), and it only decides whether, and when due, a follow-up is created for the next transition into an active stage.
- Migration `0005_reminders` adds the tables, the enum and a unique `(id, user_id)` on `stage_transition`, then backfills one open follow-up for every non-archived application whose current stage is `active`, due 7 days after its latest transition and linked to it (so long-running applications may show as due right away). It runs inside the single transaction `drizzle-kit migrate` uses; apply it with `npm run db:migrate` before using this version. Nothing is emailed yet: `sent_at` is only filled once T8 adds the scheduler.

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
