# Shifts, voids and refunds (Phase 3, pure layer)

All code is in `src/domain/` (no I/O, no clock; the caller passes `now`/`asOf`). Money is `bigint` möngö, quantities `qtyMilli` ints. Services (not written yet) load plain rows, call these functions inside one transaction and persist the plan.

| File                                                          | Purpose                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `shift.ts`                                                    | expected cash, denominations, variance, close-shift and cash-movement validation |
| `report.ts`                                                   | X/Z report builder, invariant checker, JSON freezing                             |
| `void.ts`                                                     | `planVoid`: rules + reversal plan                                                |
| `refund.ts`                                                   | `planRefund`: exact refund math, payout allocation, exchange                     |
| `shift-contract.ts`, `void-contract.ts`, `refund-contract.ts` | Zod inputs/results, error codes, fingerprints, approval scopes                   |

## Shift cash

`expected = openingFloat + cashSales − cashRefunds + cashIn − cashOut`. `cashSales` is the sum of CASH `SalePayment.amount` of non-voided sales; that column already excludes change, so change never needs a separate term. `variance = counted − expected` (negative = short). Counted cash comes only from the denomination breakdown (`MNT_DENOMINATIONS`: 20000 … 10 ₮; counts are ints in 0..100 000), so a closing count cannot be a free-typed number. A note is required when |variance| > `VARIANCE_NOTE_THRESHOLD` (1 000 ₮; `BusinessSettings` has no such column, pass `noteThreshold` once it does). A pay-out larger than the expected drawer cash is `PAYOUT_EXCEEDS_CASH` unless `overdrawApproved`.

## Reports

`buildXReport(rows)` / `buildZReport(rows, closing)`. Voided sales are listed (`voids`) but excluded from sales, tax, items and tenders. Refunds are counted once, from their own rows (a refund of an earlier shift's sale lands in the shift that paid it out). Tenders by method = sale payments − refund payments; `EXCHANGE_CREDIT` nets to zero between the refund and the exchange sale. Identities checked by `checkReportInvariants`: tenders = net takings = Σ tax-rate gross + tips + rounding (net of refunds).

## Void

`planVoid`: sale COMPLETED, same shift and that shift OPEN, no refunds, reason code (`OTHER` needs a note), `pos.void` or an approval. The plan lists payment reversals by kind (cash return, card reversal, QPay refund, bank reversal), stock restores at the sale's COGS snapshot and whether a fiscal return is due. Gift card / exchange-credit tenders return `NOT_SUPPORTED` (Phase 4).

## Refund math

For a line with final gross `T` (net + vat + city after all discounts) and quantity `Q`, the cumulative target after `c` units refunded is `F(c) = round_half_up(T·c/Q)`. A refund of `q` more units takes `F(c+q) − alreadyRefunded`; the step that reaches `c = Q` takes exactly what is left. The amounts telescope, so any partition of the quantity, in any order, sums exactly to `T`. VAT and city tax use the same rule independently, net is the remainder, and each part is clamped to what is left of the original, so `net + vat + city = gross` at every step. Weighed items may be refunded by any `qtyMilli`; pieces by whole units.

Refund total = Σ line gross, rounded (half-up) to `totalRoundingUnit` with a signed `roundingAmount` and capped by what the sale still holds. The refund that completes the sale returns everything still held (remaining tip and rounding included), so Σ refunds = sale total exactly even when earlier refunds rounded up.

Restock per line: `restock` puts the quantity back (`RETURN_RESTOCK`) and reverses COGS at the ORIGINAL `unitCost`; `restock=false` (or an untracked item) moves no stock and reverses no COGS.

## Payouts

Every `RefundPayment` row names the original sale payment whose value it consumes (`originalPaymentId`), so a tender can never give back more than it took (`paymentCapacities`). Default: the original methods, proportionally (or `LIFO`), cash in whole cash units, cash capped at what the till kept. Manager override (`paymentOverride`): any split within the original tenders needs no extra approval; paying out through a method that was not (or not enough) used originally is "cross-method", allowed only to CASH or BANK_TRANSFER and only with the `methodOverride` grant. CARD/QPAY can never exceed what that method paid, approved or not. `GIFT_CARD`, `STORE_CREDIT`, `EXCHANGE_CREDIT` tenders and gift-card lines return `NOT_SUPPORTED` (Phase 4).

Exchange: refund total `R`, replacement payable `S`: `creditApplied = min(R,S)` (rows with method `EXCHANGE_CREDIT`), `netDue = S − credit` is tendered on the new sale (which also records an `EXCHANGE_CREDIT` payment), `netRefund = R − credit` is paid out as above. The credit consumes tenders that cannot be paid back first.

Policy hook: `policy.maxRefundWindowDays` (default none); beyond it `REFUND_WINDOW_EXCEEDED` + `APPROVAL_REQUIRED` unless the `outsideWindow` grant is given.

## Contracts

Inputs carry a client UUIDv7 (`refundId`, `movementId`; a void is keyed by `saleId`). Fingerprints (`refundFingerprint`, `cashMovementFingerprint`, `voidFingerprint`) hash the canonical content and exclude approvals and the client clock; refund lines are sorted so tap order does not matter. Error codes have message keys `refund.errors.*`, `shift.errors.*`, `void.errors.*` (the messages still have to be added to `messages/{mn,en}.json` with the UI). Approval scopes are bound to the exact value: `<refundId>:refund:<saleId>:<total>:<linesDigest>`, `<refundId>:refund:method:<total>:<payoutDigest>`, `<refundId>:refund:window:<saleId>`, `<saleId>:void:<total>`, `<movementId>:cash:<key>:<type>:<amount>`; scopes are at most 200 chars (the token limit).

## Open points

- `Refund` has no `fingerprint` column (sales do); the service needs one, or must compare stored rows, to answer `IDEMPOTENCY_CONFLICT`.
- Tips are returned only by the refund that completes the sale.
- COGS reversal of a weighed partial restock rounds once per refund (≤ 0.5 möngö per refund), unlike money, which is exact.
- The exchange flow (refund + replacement checkout in one transaction, `exchange.saleId` link) is a service concern; the contract only carries the reference and expected payable.

## Service layer (refund / void / exchange)

`src/server/services/{refunds,voids,post-refund,approval-check}.ts`, actions `refundAction` / `voidSaleAction`.

- **Voided** = a `SaleVoid` row exists (append-only). `SaleVoid.reversals` records the reversal per tender; a QPay payment is refunded through the provider and its `PaymentIntent` goes `REFUNDED`. Fiscal: a never-issued receipt becomes `CANCELLED`, an issued one is returned (`runVoidFiscal`, after commit).
- **Refund** = `planRefund` on the state read under `SELECT ... FOR UPDATE` of the original sale (voids take the same lock), keyed by `refundId` (advisory lock + stored `Refund.fingerprint`). Booked on the register's current open shift. Restock = `RETURN_RESTOCK` at the sale's `unitCost`; receipt number `<location>-R-000001` from `Sequence refund:<location>`. Approvals are resolved by the scopes of `refundApprovalRequirements`; the missing ones are listed in the error details (`required: [{key, scope, value}]`).
- **Exchange**: the action takes `exchangeCheckout` (the replacement sale's ordinary checkout input; tenders = net due only). The checkout core runs in the refund transaction (`checkoutInTransaction`), adds the `EXCHANGE_CREDIT` payment (reference = refund id) and its stock guard waits until the returned goods are restocked.
- **Errors** travel as `fieldErrors.refund|void|shift = [CODE]` (+ `.details` JSON); read with `refundCodeFromFailure` etc. (`domain/refund-failure.ts`). Messages: namespace `refundErrors`, keys `refund.errors.*`, `void.errors.*`, `shift.errors.*`.
- `BusinessSettings.refundWindowDays` (null = no limit) feeds the window policy.
- Known limits: a provider refund succeeds before the commit (a crash in between needs manual reconciliation; the provider call carries an idempotency key); `completesSale` of a replayed refund is exact only when refunds were not concurrent.
