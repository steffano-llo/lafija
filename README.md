# laFija

Job application tracker: register applications, move them through configurable stages on a kanban board, log interviews and contacts, get follow-up reminders by email, and see statistics about your search.

> Work in progress. Specification and task list: [`odd/tasks/lafija.md`](odd/tasks/lafija.md).

## Stack

Next.js (App Router, Cache Components) + TypeScript · PostgreSQL on Neon · Drizzle ORM · Zod · Better Auth · Tailwind CSS + shadcn/ui · Vitest · Playwright.
Planned: dnd-kit, Recharts, Resend, Upstash QStash, deploy on Vercel.

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
| `application` | `id`, `user_id`, `company_id`, `stage_id`, `role`, `url`, `source`, `salary_range`, `applied_at` (date), `archived`, `created_at`, `updated_at` | Indexed by `user_id` and `stage_id`. `(company_id, user_id)` references `company(id, user_id)` and `(stage_id, user_id)` references `stage(id, user_id)`, so an application can only point to its owner's company and stage. `stage_id` is required. |

Data access lives in `src/server/` as plain functions taking `(db, userId, ...)`; every query filters by `userId`. Server Actions call `requireUser()` first and pass its `id`. Input is validated with the Zod schemas in `src/lib/validation/` (role and company required, `url` must be http(s), `applied_at` a real date not in the future in any time zone). Creating or editing an application takes a company name and finds or creates that user's company with `insert ... on conflict do nothing` followed by a select, because the Neon HTTP driver has no interactive transactions.

Pages: `/dashboard/applications` (active list, `?view=archived` for archived), `/dashboard/applications/new`, `/dashboard/applications/<id>/edit`, `/dashboard/stages`.

### Stages

- Every user starts with Applied, Screening, Interview (all `active`), Offer (`offer`), Rejected (`rejected`) and Accepted (`accepted`). `ensureDefaultStages()` in `src/server/stages.ts` inserts them in one `insert ... where not exists ... on conflict do nothing` statement, only when the user has no stage at all (archived included), so concurrent calls still give six stages. It runs when stages are listed or an application is created; sign-up itself is unchanged.
- The category is what statistics will use; names are free to change.
- On `/dashboard/stages` the user can create (appended at the end), rename, change the category, move up or down, archive, unarchive and delete stages.
- Delete is refused (`in_use`) while any application, archived or not, uses the stage: archive it instead. The foreign key from `application` enforces the same rule in the database. When stage history is added (kanban moves), a stage that appears in any application's history will count as used as well.
- Archive is refused (`has_applications`) while non-archived applications are in the stage; move them first. Archived applications may stay in an archived stage.
- The last non-archived stage can be neither archived nor deleted (`last_stage`).
- Archive and delete check their rules inside the same `update`/`delete` statement that writes, because Neon HTTP has no interactive transactions.
- Application forms offer the non-archived stages in order; a new application defaults to the first one. Editing keeps the current stage even if it was archived since; choosing another user's stage, an archived stage or an unknown id is refused with "Choose a valid stage." and nothing changes.
- Migration `0002_stages` also works on a database that already has data: it creates the default stages for every existing user and puts every existing application in that user's Applied stage before making `stage_id` required.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server on http://localhost:3000 |
| `npm run build` / `npm start` | Production build and server |
| `npm run lint` | ESLint |
| `npm run typecheck` | Generate route types, then TypeScript without emitting |
| `npm test` | Unit and integration tests (Vitest; database tests run on in-memory PGlite, no setup needed) |
| `npm run test:e2e` | End-to-end tests (Playwright, starts its own server on port 3100) |
| `npm run db:generate` | Generate a SQL migration from `src/db/schema.ts` into `drizzle/` |
| `npm run db:migrate` | Apply pending migrations to `DATABASE_URL` |
| `npm run db:studio` | Browse the database with Drizzle Studio |
