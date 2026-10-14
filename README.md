# POS

A point-of-sale system for small and mid-size retail and food businesses in
Mongolia. It defaults to Mongolian, also runs in English, and handles weighed
goods.

**Stack:** Next.js 16 (App Router) · TypeScript (strict) · Tailwind 4 + shadcn/ui · Prisma 7 +
PostgreSQL (Neon in production) · Auth.js v5 · next-intl · Zod · Vitest · Playwright.

The plan, data model and phase breakdown are in [`docs/PLAN.md`](docs/PLAN.md).
The schema is in [`prisma/schema.prisma`](prisma/schema.prisma).

## Status

| Phase | Scope                                                  | State   |
| ----- | ------------------------------------------------------ | ------- |
| 0     | Scaffolding, schema, auth and roles, i18n, seed data   | ✅      |
| 1     | Catalog and inventory ledger                           | next    |
| 2–7   | Checkout, registers, customers, reports, offline, docs | planned |

## Local setup

Requirements: Node 22+, pnpm 10, PostgreSQL 16.

```bash
cp .env.example .env               # then fill the three secrets: openssl rand -base64 32
pnpm install                       # also generates the Prisma client
createdb pos_dev && createdb pos_test
pnpm db:deploy                     # apply migrations to pos_dev
pnpm db:seed                       # demo shop, staff, catalog, opening stock (idempotent)
pnpm dev                           # http://localhost:3000
```

On Neon, `DATABASE_URL` is the pooled connection string (host contains `-pooler`), which the app uses.
`DIRECT_DATABASE_URL` is the direct one, which Prisma Migrate uses.

### Demo accounts (seed data, development only)

| Role    | Name       | Email / password                           | PIN    |
| ------- | ---------- | ------------------------------------------ | ------ |
| Owner   | Бат-Эрдэнэ | `owner@pos.local` / `demo-password-2026`   | 905174 |
| Manager | Сарантуяа  | `manager@pos.local` / `demo-password-2026` | 583920 |
| Cashier | Болор      | (PIN only)                                 | 482109 |

PIN sign-in works only on a **paired device**. Sign in as a manager, open
**Төхөөрөмж / Devices** and pair the browser. After that, signing out goes
to the PIN pad.

## Staging (Vercel + Neon)

The `pos-staging` Vercel project deploys every push to the repository's default branch.

- **Build Command:** `pnpm vercel-build` (`scripts/vercel-build.sh`). It applies migrations and,
  when `SEED_ON_DEPLOY=1` is set, seeds the demo data (idempotent). Then it builds.
- **Database:** a Neon database connected through the project's Storage tab, in the Singapore
  region, next to the `sin1` functions. The integration sets `DATABASE_URL` (pooled, used by the
  app) and `DATABASE_URL_UNPOOLED` (direct, used by migrations).
- **Secrets:** `AUTH_SECRET`, `PIN_PEPPER` and `GIFT_CARD_PEPPER` are set in the project's
  environment variables. They are never committed.

## Scripts

| Command                                  | What it does                                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js                                                                                                                      |
| `pnpm typecheck`                         | Route typegen + `tsc --noEmit`                                                                                               |
| `pnpm lint`                              | ESLint (zero warnings; flags hardcoded UI strings)                                                                           |
| `pnpm format` / `pnpm format:check`      | Prettier                                                                                                                     |
| `pnpm test:unit`                         | Pure logic: money, quantities, scale barcodes, permissions, tokens, i18n parity                                              |
| `pnpm test:integration`                  | Against `pos_test`: Auth.js sign-in flow, session revocation, throttling, approvals, append-only triggers, CHECK constraints |
| `pnpm test:e2e`                          | Playwright against a production build and the seeded dev database                                                            |
| `pnpm db:migrate`                        | Create and apply a migration (development)                                                                                   |
| `pnpm db:deploy`                         | Apply pending migrations (CI and production)                                                                                 |
| `pnpm db:seed`                           | Idempotent demo data                                                                                                         |
| `pnpm auth:unlock <email>`               | Clear every password sign-in lock on one account (recovery after an attack)                                                  |
| `pnpm stock:verify [--rebuild]`          | Check every StockLevel against the movement ledger; `--rebuild` rewrites drifted caches from the ledger                      |
| `pnpm check`                             | typecheck, lint, all Vitest tests, build                                                                                     |

Integration tests refuse to run unless the database name ends in `_test`.
They use `TEST_DATABASE_URL`, or `DATABASE_URL` with `_dev` replaced by `_test`.

E2E needs a browser once: `pnpm exec playwright install chromium`. Alternatively, point it at an installed
one with `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome`. Locally, `pnpm test:e2e` builds the app
first unless a server is already running on the port. It runs against your seeded dev database
and resets only what the tests depend on: seed users' language, lockouts, and devices paired by
earlier runs. To test a deployed instance, set `E2E_BASE_URL`, and set `E2E_DATABASE_URL` if its
database should be reset too.

## Ground rules

- **Money** is `bigint` möngö (1₮ = 100) everywhere. See `src/domain/money.ts`.
- **Quantities** are integer thousandths of the unit (`qtyMilli`: 1.250 kg = 1250).
- **Sales and ledgers are append-only.** Postgres triggers reject `UPDATE` and `DELETE`;
  corrections are new records.
- **Every mutation** is a `defineAction` with Zod input, a server-side permission check
  and stable error codes. A test fails the build if a server action bypasses it.
- **No hardcoded UI strings.** All copy lives in `messages/{mn,en}.json`, and the two
  files are kept in sync by a test.
