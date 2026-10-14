# Checkout domain (Phase 2, pure layer)

All code lives in `src/domain/` and is shared by the browser (instant totals) and the server (authoritative recomputation). Money is `bigint` möngö (1₮ = 100), quantities are `qtyMilli` ints, rates are bps. No I/O, no clock, no randomness.

## Order of operations (`cart.computeTotals`)

1. **Base** per line: `labelTotal ?? extend(priceOverride ?? unitPrice, qtyMilli)`. `extend` rounds once (half-up). `labelTotal` is the exact price of a price-embedded scale label.
2. **Line discounts**, in array order, each on what the previous left (10% then 5% = 14.5%).
3. **Cart discounts**, in array order, each resolved against the pool left across lines, then allocated to lines pro-rata to their remaining amounts by largest remainder (`money.allocate`). Allocations sum exactly to the discount; a discount never exceeds what remains; no line goes negative.
4. **Tax per line** on the remainder (`tax.computeLineTax`), using the catalog's tax terms.
5. **Total** = Σ line gross. **Payable** = `roundTotal(total, totalRoundingUnit)`; `roundingAmount = payable − total` (signed). Tax is never recomputed from the rounded figure.

Discount amounts are in the line's pricing mode (the gross for tax-inclusive lines, the net for exclusive ones), as in `SaleLine.discountAmount`. `subtotal`/`discountTotal` mix modes only if a cart mixes inclusive and exclusive products; `total`, `netTotal`, `vatTotal`, `cityTotal` are always exact sums of line values. Voided lines stay in `lines` (flagged, all zeros).

## Tax (`tax.ts`)

With `D = 10000`, `v` = VAT bps (0 unless `treatment = STANDARD`), `c` = city tax bps:

| mode      | formulas                                                                                    |
| --------- | ------------------------------------------------------------------------------------------- |
| inclusive | `vat = round(gross·v/(D+v+c))`, `city = round(gross·c/(D+v+c))`, `net = gross − vat − city` |
| exclusive | `vat = round(net·v/D)`, `city = round(net·c/D)`, `gross = net + vat + city`                 |

Half away from zero. Invariants: `net + vat + city = gross`; all parts ≥ 0. ZERO_RATED and EXEMPT carry no VAT; city tax follows `cityTaxRateBps` whatever the treatment. Prices are tax-inclusive by default (`Product.pricesIncludeTax`), VAT 10%, city tax 0–2%.

## Rounding (`rounding.ts`)

`roundTotal(total, unit)` rounds half-up to a multiple of `BusinessSettings.totalRoundingUnit` (100 = 1₮ default; 500 = 5₮; 1000 = 10₮; 1 = exact). Only the payable is rounded.

## Approvals (`discounts.ts`, `cart.requiredApprovals`)

A cart needs a manager approval for every price override (price ≠ listed) and every discount whose effective rate exceeds `maxDiscountBpsWithoutApproval` (default 1000 = 10%; fixed amounts are compared as `amount/base`). Voided lines need none. Each requirement has a stable key used in `CheckoutInput.approvals`: `line:<lineId>:price`, `line:<lineId>:discount:<i>`, `cart:discount:<i>`; permissions are `pos.price_override` / `pos.discount.manual`.

## Cart reducer (`cart.ts`)

`reduceCart(cart, action, catalog)` returns `{ok, cart} | {ok:false, error}`; `cartReducer` is the `useReducer` form (invalid actions are ignored). Line ids come from the caller. Piece items merge into an existing plain line of the same variant and price (`merge:false` disables); weighed/measured items always add a new line. Scale labels (`ADD_SCALE`) resolve the variant by PLU: WEIGHT labels set the quantity; PRICE labels keep the exact label price (`labelTotal`) and derive the quantity from the catalog price. Changing the quantity (`SET_QTY`) drops both `labelTotal` and `scaleBarcode`, and a piece item never merges into a scale line: the line is then sent as `variantId` + `qtyMilli`, so the server prices exactly what the cashier saw (a label that no longer describes the line would make the server re-derive the label's quantity and fail with TOTAL_MISMATCH).

## Tenders (`tender.ts`)

`amount` is what is applied to the sale; for CASH `tendered ≥ amount` and `change = tendered − amount`. `validateTenders(payable, tenders, {cashUnit})` enforces: amounts > 0, at most 6 tenders, `tendered` only for cash, Σ applied = payable, no tender pushing the running sum past the payable (`OVERPAID` for cash, `NON_CASH_EXCEEDS_BALANCE` otherwise), cash amounts in multiples of `cashUnit`. Helpers: `remainingBalance`, `cashTenderFor`, `computeChange`, `quickCashAmounts` (exact, then the balance rounded up to 1 000 / 5 000 / 10 000 / 20 000 ₮, deduped).

## Contract (`checkout-contract.ts`)

- `checkoutInputSchema`: `saleId` (UUIDv7), `lines[]` (`lineId`, `variantId` + `qtyMilli` **or** `scaleBarcode`, `listedUnitPrice?`, `priceOverride?`, `discounts[]`, `note?`), `cartDiscounts[]`, `customerId?`, `tenders[]`, `expectedPayable`, `approvals{key→token}`, `note?`, `createdAtClient`. Money is a decimal string on the wire (parsed to bigint). registerId, shiftId, cashier and location are derived server-side.
- `cartFromCheckoutInput(input, catalog)` rebuilds the cart from DB prices (intents map 1:1 to sale lines) and reports `STALE_PRICE` when `listedUnitPrice` differs from the catalog.
- Server flow: rebuild → `computeTotals` → compare with `expectedPayable` (`TOTAL_MISMATCH`) → `requiredApprovals` vs `approvals` → `validateTenders` (`TENDER_MISMATCH`).
- `CheckoutResult`: `saleId`, `receiptNumber`, `status` (`COMPLETED`, `COMPLETED_NEEDS_REVIEW`), `totals`, `payments`, `change`, `shareToken`, `replayed`. `toWire` makes it JSON-safe; `checkoutResultSchema` parses it back.
- Error codes (`CHECKOUT_ERROR_CODES`, message key `checkout.errors.<CODE>`): INVALID_INPUT, EMPTY_CART, SHIFT_REQUIRED, PERMISSION_DENIED, APPROVAL_REQUIRED, APPROVAL_INVALID, VARIANT_NOT_FOUND, VARIANT_INACTIVE, INVALID_QUANTITY, INVALID_SCALE_BARCODE, INVALID_DISCOUNT, STALE_PRICE, TOTAL_MISMATCH, TENDER_MISMATCH, PAYMENT_NOT_CONFIRMED, GIFT_CARD_INSUFFICIENT, INSUFFICIENT_STOCK, CUSTOMER_NOT_FOUND, IDEMPOTENCY_CONFLICT.
- **Fingerprint**: `checkoutFingerprint(input)` = SHA-256 of a canonical string (sorted keys, bigint as decimal, line/tender order significant). `approvals` and `createdAtClient` are excluded so a retry with fresh tokens or a new clock still matches. Store it on the sale; on a replay of the same `saleId` return the stored sale if `isSameCheckout`, otherwise answer `IDEMPOTENCY_CONFLICT`.

## Providers, fiscal claim and the QPay callback (server hardening)

- **Mock providers fail closed.** `getFiscalProvider()` / `getPaymentProvider()` throw a
  `ProviderConfigurationError` when `NODE_ENV=production` unless `ALLOW_MOCK_PROVIDERS=1`
  (staging and the Playwright production-build server set it; never set it in real
  production). `MOCK_QPAY_AUTOPAY_SECONDS`, `markMockInvoicePaid` and the `mock-pay` route are
  honoured only when mocks are allowed. The mock's "paid" flag lives in process memory, so on
  multi-instance / serverless staging use `MOCK_QPAY_AUTOPAY_SECONDS` (stateless) instead of
  the mock-pay route.
- **Fiscal issuance is claimed.** `FiscalReceipt` goes `PENDING|FAILED -> ISSUING -> ISSUED|FAILED`
  via a compare-and-set before the provider is called, so concurrent runs (replayed checkout,
  reconcile sweeps) issue once. A claim older than `FISCAL_CLAIM_TIMEOUT_MS` (5 min, crashed
  runner) is retried; the sale id is the provider idempotency key. A replayed checkout does not
  schedule `runPostSale` again.
- **QPay callback** (`/api/payments/qpay/webhook`) needs `QPAY_WEBHOOK_SECRET` (header
  `x-webhook-secret`, `Authorization: Bearer`, or `?token=`); unset means every call gets 401.
  Authenticated calls always get an empty 200; only refs of PENDING intents reach the provider;
  an in-process throttle limits hits per invoice id and per IP.
- Catalog actions (`register.ts`) resolve the device through `requireRegisterContext`, like
  checkout.
