# laFija

Job application tracker: register applications, move them through configurable stages on a kanban board, log interviews and contacts, get follow-up reminders by email, and see statistics about your search.

> Work in progress. Specification and task list: [`odd/tasks/lafija.md`](odd/tasks/lafija.md).

## Stack

Next.js (App Router) + TypeScript · PostgreSQL on Neon · Drizzle ORM · Zod · Tailwind CSS + shadcn/ui · Vitest · Playwright.
Planned: Better Auth, dnd-kit, Recharts, Resend, Upstash QStash, deploy on Vercel.

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

The app validates these variables on first use and fails with `Invalid environment variables: <names>`, listing only the variable names, never their values.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server on http://localhost:3000 |
| `npm run build` / `npm start` | Production build and server |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript without emitting |
| `npm test` | Unit tests (Vitest) |
| `npm run test:e2e` | End-to-end tests (Playwright, starts its own server on port 3100) |
| `npm run db:generate` | Generate a SQL migration from `src/db/schema.ts` into `drizzle/` |
| `npm run db:migrate` | Apply pending migrations to `DATABASE_URL` |
| `npm run db:studio` | Browse the database with Drizzle Studio |
