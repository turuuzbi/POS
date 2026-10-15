# Returns, exchanges and voids at the register (Phase 3 UI)

The cashier-facing side of `docs/shifts-refunds-domain.md`. The UI never decides money: it runs the same pure `planRefund` / `planVoid` the server runs, so the preview equals what the server computes, and `expectedTotal` pins it (a difference is `TOTAL_MISMATCH`, not a silent change).

| Where                                  | What                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/refunds/` (pure, unit-tested) | sale wire parsing, `previewRefund`, approvals held per exact scope, request builders, error mapping, retry, void checks     |
| `src/server/queries/register-sales.ts` | sale lookup (number / share token / id) and recent sales, scoped to the paired device's location; no costs leave the server |
| `src/server/actions/refund-lookup.ts`  | `findReturnSaleAction`, `listRecentSalesAction` (read-only, `pos.sell`, device derived server-side)                         |
| `src/components/refunds/`              | Returns dialog (full screen on a phone), sale panel, void panel, payout editor, exchange bar and finish flow                |
| `register-app.tsx`                     | header "Returns" button (F9), `ExchangeBar`, exchange routing of the charge button (F2)                                     |

## Flow

1. **Find**: receipt number typed or scanned (USB scanner = typing + Enter into the focused box; camera fallback), a receipt link/QR text, or the recent-sales list (this shift / whole register, searchable by number).
2. **Return**: +/- per line (weighed goods: decimal keypad), "all", restock switch (default = product stock tracking), reason (+ note for `OTHER`), payout (original tenders by default; all cash / all bank / manual split need `refund:method` approval). Approvals are computed from the plan with `refundApprovalRequirements`; a token is kept only while its scope (sale, lines, total / payout digest) still matches, so any change re-asks for the PIN.
3. **Submit**: one idempotent `refundAction` call. `refundId` (UUIDv7) is created when the sale opens; INTERNAL / network errors are retried with the identical input; if the outcome stays unknown the form freezes until the same request is resent or the sale is re-read (a stored refund with that id turns into the success screen).
4. **Void**: reason (+ note), PIN for cashiers (`<saleId>:void:<total>`), only for the open shift's sales; otherwise the exact reason is shown (other shift, has returns, already voided, unsupported tender).
5. **Exchange**: pick the lines to take back, the register cart becomes the replacement. The bar shows credit / replacement / net due or net refund. Finish = review + approvals, then (net due > 0) the tender dialog only COLLECTS the customer's tenders for the net due, then ONE `refundAction` call carries `exchange: { saleId, expectedPayable }` plus `exchangeCheckout` (the cart's checkout input, tenders = net due only). The service books the replacement sale (adds the `EXCHANGE_CREDIT` payment) and the refund in one transaction, idempotent on `refundId`; a lost answer is resent verbatim. The done screen links both receipts. The context survives a reload (`localStorage`).

## Open points for other slices

- Checkout must accept an `EXCHANGE_CREDIT` tender (amount = credit applied) for an exchange's replacement sale; the current `TENDER_METHODS` does not.
- Error texts: the UI looks up `refundErrors.<messageKey>` (e.g. `refundErrors.refund.errors.OVER_REFUND`), then `refundErrors.<CODE>`, then its own `refunds.issues.<CODE>`.
- The refund window has no settings column; `POS_REFUND_WINDOW_DAYS` (positive integer) switches the warning/approval on until it does.
- The refund receipt link is `/receipt/refund/<refundId>`.
