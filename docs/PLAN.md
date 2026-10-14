# POS: plan

Status: **approved 2026-10-12. Phase 0 is done.** The data model is in [`prisma/schema.prisma`](../prisma/schema.prisma).

---

## 1. Stack (pinned at scaffold time)

| Concern    | Choice                                                                                                                              | Note                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Framework  | Next.js 16 (App Router), React 19, TypeScript `strict`                                                                              | pnpm                                                                                                      |
| UI         | Tailwind CSS 4, shadcn/ui, next-themes (dark mode), lucide icons                                                                    |                                                                                                           |
| DB         | PostgreSQL 16 locally, Neon in prod; Prisma **7.10** (`prisma-client` generator, `@prisma/adapter-pg`, or `adapter-neon` on Vercel) | npm's `prisma@latest` currently points at an 8.0 RC, so 7.10 is pinned explicitly                         |
| Auth       | Auth.js v5 (`next-auth@5.0.0-beta.32`), Credentials provider, JWT sessions                                                          | v5 never left the beta tag. The auth surface is isolated in `src/server/auth/` so it can be swapped later |
| Validation | Zod 4 on every server action and route handler                                                                                      |                                                                                                           |
| i18n       | next-intl 4, cookie/user-based locale (no URL prefix), `mn` default, `en`                                                           |                                                                                                           |
| Tests      | Vitest (unit + DB integration), Playwright (e2e)                                                                                    |                                                                                                           |
| PWA        | Serwist (service worker), Dexie (IndexedDB)                                                                                         |                                                                                                           |
| Hosting    | Vercel + Neon, `.env.example`                                                                                                       |                                                                                                           |

## 2. Architecture

```
src/
  app/
    (auth)/login, (auth)/pin          password login · PIN switch on a paired device
    (pos)/register/…                  full-screen, touch-first checkout
    (admin)/…                         catalog, inventory, customers, reports, settings
    r/[token]/                        public receipt share page
    api/                              QPay webhook, offline sync, receipt PDF
  domain/                             PURE TS shared by client and server (no I/O)
    money.ts qty.ts tax.ts discounts.ts cart.ts tender.ts rounding.ts
  server/
    db.ts                             Prisma client + driver adapter
    auth/                             Auth.js config, permissions.ts, authorize()
    actions/                          server actions: zod → authorize → service → audit
    services/                         transactional business services (the only DB writers)
      stock.ts checkout.ts refunds.ts shifts.ts giftcards.ts loyalty.ts …
    adapters/
      payments/  (PaymentProvider: qpay-mock, …)
      fiscal/    (FiscalProvider:  ebarimt-mock)
      messaging/ (SMS/email: console-mock)
      storage/   (images: Vercel Blob / local)
  offline/                            Dexie schema, outbox, sync, SW registration
  components/ui (shadcn) · components/pos · components/admin
messages/mn.json · messages/en.json
prisma/schema.prisma · migrations/ · seed.ts
tests/e2e/
```

**Request pipeline:** every mutation goes through one wrapper:
`defineAction({ input: zodSchema, permission: "sale.void", run })`. The wrapper parses input, loads the session, checks role permissions and, where an action needs one, a manager approval token. It then calls the service and writes the audit log. A unit test enumerates the exported actions and fails if any of them bypasses the wrapper.

**Permissions** are a static role-to-permission map in code (Owner ⊃ Manager ⊃ Cashier). Gated actions include price override, discounts above a threshold, voids, refunds, cash out and stock adjustments. A cashier can get a manager to approve on the spot: the manager enters a PIN, and the server returns a short-lived signed **approval token** scoped to that action and sale. The server verifies the token, and the approver is recorded on the row.

**Shared-device auth:** owners and managers sign in with email and password. A manager pairs a tablet to a register, which stores an httpOnly device secret (hashed in `Device`). On a paired device, staff switch users with a PIN. PINs are stored as HMAC with a server pepper, so lookup is O(1) and nothing reversible is stored.

Brute-force throttling (`AuthThrottle`) works in fixed windows over these buckets: account + source, account across all sources, source (IPv4 address or IPv6 /64), IPv6 /48, and, for PINs, the device per hour and per day. Every attempt is **counted before the credential is checked**, in one transaction that locks the bucket rows, so a burst of parallel requests gets at most `freeAttempts + 1` checks. A correct credential then refunds only its own attempt: it never erases failures someone else caused, so guessing a manager's PIN between sign-ins with your own gets you nowhere. A PIN whose owner lacks the permission being approved counts and answers exactly like a wrong one. Account buckets are keyed by a hash of the email, so unknown emails get exactly the same queries and answers as real ones; the throttle can't reveal which accounts exist. Sources are validated IP literals.

Lockout attacks are contained in three ways. A browser that has signed in to an account before carries a signed "known browser" cookie and is throttled in a bucket of its own, so nobody else on the shop's network can lock it out. The account-wide lock never applies to a network the account has signed in from before (`TrustedSignInSource`). And `pnpm auth:unlock <email>` clears an account's locks. A manager can clear a device's PIN lock. Stale throttle rows, trusted sources and revoked sessions are pruned as failures come in, so the tables stay bounded.

Every request re-validates the session against the database: the user must be active, `tokenVersion` must match (it is bumped on role change or deactivation), the session must not be signed out (`RevokedSession`), and a PIN session must come from its own device. A sign-in counts only when our own `authorize()` verified the user. Auth.js can return without throwing on failure, so "no exception" is never treated as success.

## 3. Correctness design (the non-negotiables)

**Money.** `bigint` MNT minor units (möngö, 1₮ = 100) in the DB (`BigInt`) and in all domain code, so floats can't creep in. One `domain/money.ts`:

- `mulRound(amount, num, den, mode)`: exact integer rational math, rounding half away from zero.
- Inclusive tax: `vat = round(gross × vatBps / (10000 + vatBps + cityBps))`, `net = gross − vat − city`.
- Exclusive tax: `vat = round(net × vatBps / 10000)`, `gross = net + vat + city`.
- Tax is computed per line, after that line's discounts. Sale totals are sums of the lines, never recomputed from rounded totals.
- Cart discounts are allocated pro-rata to lines by the **largest-remainder** method, so the allocations add up exactly to the discount.
- The sale total is rounded to `totalRoundingUnit` (default 1₮), and the signed difference is stored in `roundingAmount`.
- Display: `12,345₮`. Input is in ₮ and parsed to möngö by Zod.

**Quantity.** `Int` thousandths (`qtyMilli`), so 1.250 kg is 1250. This keeps weighed goods integer-only. (See question 2.)

**Split tender.** A non-cash tender can never exceed the remaining balance. Change comes only from cash. `Σ applied = total`. Gift card and store-credit balances are row-locked during checkout.

**Sales are immutable.** Postgres triggers reject `UPDATE`/`DELETE` on sales, sale lines and payments, refunds, voids, every ledger, cash movements, Z-reports and the audit log. I prototyped this here and confirmed it blocks writes. Corrections are new rows: `SaleVoid` (same open shift only) or `Refund` (always against the original sale).

**Stock.** `StockMovement` is the append-only source of truth. `StockLevel.onHandMilli` is a cache that `services/stock.ts` updates in the same transaction. That service locks the affected rows with `SELECT … FOR UPDATE`, in a fixed order so concurrent checkouts can't deadlock. A `stock:verify` script and an integration test check `Σ movements == StockLevel` and can rebuild the cache. Average cost is updated on receiving, and each sale line snapshots its COGS.

**Checkout transaction.**

1. The client builds the cart with the same `domain/` code, so totals are instant and updates are optimistic.
2. On _Charge_, the client sends the sale UUIDv7, which it generated when the cart opened, plus line intents (variant, qty, requested overrides and discounts with approval tokens) and tenders.
3. Inside one DB transaction the server:
   - returns the existing sale if this ID was already committed (idempotent replay);
   - reloads prices, tax classes and promotions from the DB and **recomputes everything**;
   - checks permissions, validates tenders, allocates the receipt number from `Sequence`, then inserts the sale, lines, discounts and payments, stock movements, ledger rows and audit rows.
4. A concurrent duplicate request hits the primary-key conflict and is answered with the existing sale.
5. Fiscal receipt and SMS/email go out after commit, as retryable records (`FiscalReceipt`, `ReceiptDelivery`).

**QPay** is a `PaymentProvider` interface (`createInvoice`, `checkPayment`, `refund`) with a mock implementation. A `PaymentIntent` tracks the invoice. The webhook only _triggers_ a server-side status check and is never trusted by itself. Checkout accepts only intents the server has verified as `PAID`.

**eBarimt** is a `FiscalProvider` interface (`issue(sale)`, `issueReturn(refund)`, `status(id)`) with a mock. Nothing about the real PosAPI is guessed; the open points are marked `TODO(ebarimt)` (branch config, item classification codes, payload mapping).

## 4. Offline (Phase 6, designed now so the schema supports it)

- Dexie holds a catalog snapshot (variants, barcodes, prices, tax classes, promotions, quick keys), held carts and an **outbox** of completed sales. Scan and search run locally, which is how interactions stay under 100 ms.
- Serwist precaches the POS shell. Sync uses Background Sync where the browser supports it (Chromium). Everywhere else, including iOS Safari, it retries on `online`, on focus and on an interval.
- Offline you can take cash, card with a manual terminal reference, and bank transfer. QPay, gift cards and store credit need a live server balance, so they are disabled offline.
- Replayed sales are idempotent (client ID as primary key) and keep their device `occurredAt`. If the server's price view differs from what the client charged, the sale is still recorded with the amounts actually collected, but flagged `requiresReview` for a manager. The server never silently rewrites it.

## 5. Data model overview

| Area         | Models                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup        | `BusinessSettings` (singleton), `Location`, `Register`, `Device`                                                                                                                |
| Access       | `User` (role, password, PIN lookup, tokenVersion), `UserLocation`, `AuthThrottle`, `RevokedSession`                                                                             |
| Catalog      | `TaxClass` (VAT bps, city-tax bps, treatment), `Category` (tree), `Product`, `ProductOption`, `ProductVariant` (SKU, price, avg cost), `Barcode` (many per variant), `QuickKey` |
| Restaurant   | `ModifierGroup`, `Modifier`, `ProductModifierGroup`, `DiningTable`, `OpenTicket` (also retail hold/resume), `KitchenTicket`                                                     |
| Purchasing   | `Supplier`, `SupplierItem`, `PurchaseOrder`(+`Line`), `GoodsReceipt`(+`Line`)                                                                                                   |
| Inventory    | `StockMovement` (ledger), `StockLevel` (cache + reorder point/qty), `StockAdjustment`, `Stocktake`(+`Line`)                                                                     |
| Sales        | `Sale` (client UUID, receipt no., share token), `SaleLine` (full price/tax/cost snapshot), `SaleLineModifier`, `SaleDiscount`, `SalePayment`, `PaymentIntent`, `SaleVoid`       |
| Returns      | `Refund` (incl. exchange link, tip and rounding), `RefundLine` (restock flag), `RefundPayment` (link to original tender)                                                        |
| Shifts       | `Shift` (float, expected/counted/variance, denominations; a partial unique index allows one OPEN shift per register), `CashMovement`, `ZReport` (frozen snapshot)               |
| Customers    | `Customer`, `LoyaltyEntry`, `StoreCreditEntry`, `GiftCard` (HMAC code hash + last4), `GiftCardEntry`                                                                            |
| Promotions   | `Discount` (automatic or code; % or fixed; order or products/categories), `DiscountProduct`, `DiscountCategory`                                                                 |
| Integrations | `FiscalReceipt`, `ReceiptDelivery`                                                                                                                                              |
| Infra        | `Sequence` (gap-free numbering), `AuditLog`                                                                                                                                     |

Indexes for speed: `Barcode.code` and `ProductVariant.sku` are unique btree (a scan is one index hit). `Product.name` and `Customer.name` have trigram GIN indexes (`pg_trgm`) for search-as-you-type `ILIKE`. `Customer.phone` is unique. Reports use `(locationId, occurredAt)` and `(cashierId, occurredAt)`.

## 6. Phases and done-gates

Each phase is finished only when all of these pass: `pnpm typecheck`, `pnpm lint`, `pnpm test` (unit and DB integration), `pnpm test:e2e`, `pnpm build`. The migration must apply to a fresh DB, `pnpm db:seed` must run, and the app must boot. Every phase ends in its own commit with a note on what was built, what's mocked and what's next.

| #      | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0**  | Scaffold (Next 16, TS strict, Tailwind 4, shadcn, ESLint/Prettier). Prisma 7 with the initial migration, including the append-only triggers. Auth.js: password login, device pairing, PIN switch. Roles, permissions and the action wrapper. next-intl `mn`/`en`, plus a test that both message files have the same keys. Theme and dark mode. Admin and POS shells with empty, loading and error states. `domain/money.ts` and `qty.ts` with tests. Seed data: business, 1 location, 2 registers, owner/manager/cashier, tax classes, Mongolian-named categories and about 40 products with variants, barcodes and opening stock. GitHub Actions CI. Login smoke e2e test. |
| **1**  | Catalog CRUD (products, variants/options, barcodes, categories, tax classes, images via storage adapter). CSV import and export. Stock service and ledger. Adjustments with reasons. Suppliers, POs, receiving (average cost). Stocktake. Low-stock list. Tests cover stock math, concurrency, cache-equals-ledger and CSV.                                                                                                                                                                                                                                                                                                                                                 |
| **2**  | Checkout UI: quick-key grid, `/` search, USB-wedge scanner and camera fallback (BarcodeDetector, then ZXing), cart (qty, override, line and cart discounts, notes), hold/resume. Tax, discount and tender domain code with tests. Checkout service (transactional, idempotent). Cash, card, bank, QPay mock and split tender. Receipts: 80 mm print CSS, PDF, share link. eBarimt mock. SMS/email mock. Playwright checkout happy path. _(A minimal "open shift with float" lands here, because a sale needs a shift.)_                                                                                                                                                     |
| **3**  | Shifts: open and close, cash in and out, expected vs counted by denomination, X- and Z-reports. Voids. Returns, refunds and exchanges against the original sale, with restock option, reason codes, manager approval and refund to the original method.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **4**  | Customers (profiles, checkout lookup, history). Automatic promotions and coupon codes. Loyalty earn and redeem. Store credit. Gift cards (sell, redeem, balance check). Tips.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **5**  | Reports: day, week and month; by product, category, staff and payment method; gross margin; top sellers; dead stock; tax report; end-of-day summary; CSV export. Audit-log viewer. Admin screens for users and roles, locations, registers and devices, tax settings and receipt template.                                                                                                                                                                                                                                                                                                                                                                                  |
| **5b** | Restaurant mode behind the per-location flag: tables and tabs, modifier picker, kitchen tickets. _(See question 4.)_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **6**  | Offline PWA and sync queue. Hardening: rate limits for gift-card lookup and other public endpoints (sign-in throttling is already in place since Phase 0); CSP and security headers; idempotency and concurrency tests; notes on Neon backups and point-in-time recovery.                                                                                                                                                                                                                                                                                                                                                                                                   |
| **7**  | Docs: README, architecture, setup, deploy (Vercel + Neon), adapter and API interfaces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Development and tests run against local PostgreSQL 16 in this environment, and against a Postgres service container in CI. I'll need a Neon `DATABASE_URL` only when you want a deployed preview.

## 7. Decisions (confirmed)

1. **Tenancy:** one business per deployment, with many locations. There is no tenant ID.
2. **Weighed goods are a primary use case.** Quantities are integer thousandths. Variants carry a scale PLU code. Scale-label barcodes are parsed by configurable rules (`BusinessSettings.scaleBarcodeRules`, `src/domain/scale-barcode.ts`). Exact barcode matches always win.
3. **Layaway and special orders are out of scope for now.** The product comes first.
4. **Restaurant extras are Phase 5b**, before offline, so the offline checkout handles modifiers from day one.
5. **Auth:** Auth.js v5, with JWT sessions re-validated against the database on every request. Pinned at `5.0.0-beta.32`.
6. **Selling into negative stock is allowed, with a warning.** This is a setting.
7. **Loyalty redemption is a discount**, so it reduces the VAT base. **Gift cards and store credit are tenders.**
8. **Sale totals round to whole ₮.** The unit is configurable. **City tax (НХАТ)** is a per-tax-class rate that defaults to 0%.
9. **Next.js `cacheComponents` is off.** Every POS screen is per-user and dynamic, and the checkout runs client-side.
