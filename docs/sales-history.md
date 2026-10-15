# Sales history and credit notes

## Sales history (`/sales`, `reports.view`)

- Filters live in the query string (`q`, `from`, `to`, `status`, `location`, `register`, `cashier`, `method`, `min`, `max`, `page`); parsing is pure (`domain/sales-filter.ts`). Days are Asia/Ulaanbaatar calendar days, the end day is inclusive.
- **Status is derived, never stored** (`domain/sale-status.ts`): voided if a `SaleVoid` exists, else refunded when Σ refunds ≥ sale total, partially refunded when 0 < Σ < total, else completed. The list query (`server/queries/sales.ts`) computes the same rule in SQL; tests keep the two in step.
- Location scoping is applied in SQL to the rows, the totals strip, the CSV export and the detail page. A sale outside the user's locations looks exactly like a missing one.
- CSV: `/sales/export` streams in keyset batches, UTF-8 BOM, CRLF, formula-safe text cells (`csvText`). There is no `reports.export` permission, so it needs `reports.view`. Each export is audited (`sales.export`).

## Credit notes and void slips

| Page (staff, `pos.sell`, location-scoped) | Public share page   | PDF                                |
| ----------------------------------------- | ------------------- | ---------------------------------- |
| `/receipt/refund/[refundId]`              | `/r/refund/[token]` | `/api/receipts/refund/[token]/pdf` |
| `/receipt/void/[saleId]`                  | `/r/void/[token]`   | `/api/receipts/void/[token]/pdf`   |

Models are pure (`domain/receipt-credit.ts`), rows come from `domain/receipt-credit-layout.ts`, and the HTML slip and the PDF draw the same rows. The refund's free-text note is never on the slip. The original receipt shows a REFUNDED / PARTIALLY REFUNDED banner and one line per refund.

### Share tokens (no column needed)

`Refund` has no token column, so tokens are derived, not stored:

    token = base64url(16-byte id) "." base64url(HMAC-SHA256(key, kind ":" id))
    key   = deriveKey(AUTH_SECRET, "credit-note-token")

The signature covers the kind, so a refund token never opens a void slip and vice versa; a sale's stored `publicToken` has another shape and is rejected before any query. Verification: shape check, canonical-id check, constant-time compare, then lookup by id. Rotating `AUTH_SECRET` invalidates all issued credit-note links.

`TODO(ebarimt)`: the fiscal return document (number/QR) replaces the status placeholder once the real PosAPI is wired.
