/**
 * Checkout wire contract: what the client sends (CheckoutInput), what the
 * server answers (CheckoutResult / CheckoutError), the stable error codes and
 * the canonical fingerprint used to detect an idempotent replay whose
 * CONTENT differs from the sale already committed under the same saleId.
 *
 * registerId / shiftId / cashierId / locationId are NOT in the input: the
 * server derives them from the session and the open shift.
 *
 * Money crosses JSON as decimal strings of möngö (BigInt is not JSON). Zod
 * parses them to bigint; `toWire` serializes bigint → string.
 */
import { z } from "zod";
import {
  MAX_CART_DISCOUNTS,
  MAX_CART_LINES,
  MAX_LINE_DISCOUNTS,
  MAX_NOTE_LENGTH,
  reduceCart,
  type Cart,
  type CartError,
  type CatalogSnapshot,
} from "./cart";
import { MAX_MONEY } from "./catalog";
import { MAX_QTY_MILLI } from "./qty";
import type { ScaleBarcodeRule } from "./scale-barcode";
import { MAX_TENDERS, TENDER_METHODS, type TenderIssue } from "./tender";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** möngö as a non-negative integer string (or safe integer) → bigint. */
export const moneyWire = z
  .union([z.string().regex(/^\d{1,15}$/), z.number().int().nonnegative().safe()])
  .transform((v) => BigInt(v))
  .refine((v) => v <= MAX_MONEY, "too large");

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** UUIDs are lowercased on parse so fingerprints do not depend on input case. */
export const uuidV7 = z
  .string()
  .regex(UUID_V7, "invalid uuid v7")
  .transform((v) => v.toLowerCase());
export const uuid = z.uuid().transform((v) => v.toLowerCase());

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/**
 * Optional trimmed text: no lone surrogates (TextEncoder would silently
 * replace them, making different strings hash alike) and "" ≡ absent.
 */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => !LONE_SURROGATE.test(v), "invalid text")
    .optional()
    .transform((v) => (v === "" ? undefined : v));

/** Upper bound on approval entries: one per line price/discount + cart discounts. */
export const MAX_APPROVALS = MAX_CART_LINES * (1 + MAX_LINE_DISCOUNTS) + MAX_CART_DISCOUNTS;

export const discountRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("PERCENT"),
    percentBps: z.number().int().min(1).max(10_000),
    reason: optionalText(120),
  }),
  z.object({
    kind: z.literal("FIXED"),
    amount: moneyWire.refine((v) => v > 0n, "must be positive"),
    reason: optionalText(120),
  }),
]);

export const lineIntentSchema = z
  .object({
    /** Client-generated; echoed back; approval keys refer to it. */
    lineId: uuid,
    variantId: uuid.optional(),
    /** Scale label (13 digits). Quantity/price come from the label. */
    scaleBarcode: z
      .string()
      .regex(/^\d{13}$/)
      .optional(),
    /** Required with variantId; for a scale label it must match the label if given. */
    qtyMilli: z.number().int().positive().max(MAX_QTY_MILLI).optional(),
    /** Price the client displayed, to detect STALE_PRICE. */
    listedUnitPrice: moneyWire.optional(),
    /** Requested price override (needs approval). */
    priceOverride: moneyWire.optional(),
    discounts: z.array(discountRequestSchema).max(MAX_LINE_DISCOUNTS).default([]),
    note: optionalText(MAX_NOTE_LENGTH),
  })
  .refine((l) => (l.variantId === undefined) !== (l.scaleBarcode === undefined), {
    message: "exactly one of variantId / scaleBarcode",
  })
  .refine((l) => l.scaleBarcode !== undefined || l.qtyMilli !== undefined, {
    message: "qtyMilli is required with variantId",
  });

export const tenderIntentSchema = z.object({
  method: z.enum(TENDER_METHODS),
  amount: moneyWire.refine((v) => v > 0n, "must be positive"),
  /** Cash only. */
  tendered: moneyWire.optional(),
  reference: optionalText(100),
  /** QPAY: a PaymentIntent the server must find PAID. */
  paymentIntentId: uuid.optional(),
  /** GIFT_CARD: code typed/scanned; the server resolves and row-locks it. */
  giftCardCode: optionalText(64),
  /** CARD: terminal-reported brand and last four digits (receipt only). */
  cardBrand: optionalText(20),
  cardLast4: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
});

type TenderShape = z.output<typeof tenderIntentSchema>;

/** Per-method required (R) / forbidden (F) fields. */
const TENDER_FIELD_RULES: Record<
  (typeof TENDER_METHODS)[number],
  { required: (keyof TenderShape)[]; forbidden: (keyof TenderShape)[] }
> = {
  CASH: { required: [], forbidden: ["paymentIntentId", "giftCardCode", "cardBrand", "cardLast4"] },
  CARD: { required: [], forbidden: ["tendered", "paymentIntentId", "giftCardCode"] },
  BANK_TRANSFER: {
    required: [],
    forbidden: ["tendered", "paymentIntentId", "giftCardCode", "cardBrand", "cardLast4"],
  },
  QPAY: {
    required: ["paymentIntentId"],
    forbidden: ["tendered", "giftCardCode", "cardBrand", "cardLast4"],
  },
  GIFT_CARD: {
    required: ["giftCardCode"],
    forbidden: ["tendered", "paymentIntentId", "cardBrand", "cardLast4"],
  },
  STORE_CREDIT: {
    required: [],
    forbidden: ["tendered", "paymentIntentId", "giftCardCode", "cardBrand", "cardLast4"],
  },
};

export const checkoutInputSchema = z
  .object({
    saleId: uuidV7,
    lines: z.array(lineIntentSchema).min(1).max(MAX_CART_LINES),
    cartDiscounts: z.array(discountRequestSchema).max(MAX_CART_DISCOUNTS).default([]),
    /** Phase 4 fills this in. */
    customerId: uuid.optional(),
    tenders: z.array(tenderIntentSchema).max(MAX_TENDERS),
    /** Payable the client showed; a mismatch with the server's total is TOTAL_MISMATCH. */
    expectedPayable: moneyWire,
    /** approval key (discounts.ts `approvalKeys`) → approval token. */
    approvals: z
      .record(z.string().max(100), z.string().min(1).max(512))
      .refine((r) => Object.keys(r).length <= MAX_APPROVALS, "too many approvals")
      .default({}),
    note: optionalText(500),
    buyerTaxId: optionalText(20),
    /** Device clock, ISO-8601 with offset. Informational (Sale.occurredAt). */
    createdAtClient: z.iso.datetime({ offset: true }),
  })
  .superRefine((input, ctx) => {
    const seenLines = new Set<string>();
    input.lines.forEach((line, i) => {
      if (seenLines.has(line.lineId)) {
        ctx.addIssue({ code: "custom", path: ["lines", i, "lineId"], message: "duplicate lineId" });
      }
      seenLines.add(line.lineId);
    });
    const seenIntents = new Set<string>();
    const seenCodes = new Set<string>();
    input.tenders.forEach((t, i) => {
      const rule = TENDER_FIELD_RULES[t.method];
      for (const field of rule.required) {
        if (t[field] === undefined) {
          ctx.addIssue({ code: "custom", path: ["tenders", i, field], message: "required" });
        }
      }
      for (const field of rule.forbidden) {
        if (t[field] !== undefined) {
          ctx.addIssue({ code: "custom", path: ["tenders", i, field], message: "not allowed" });
        }
      }
      if (t.method === "STORE_CREDIT" && input.customerId === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["customerId"],
          message: "required for store credit",
        });
      }
      if (t.paymentIntentId !== undefined) {
        if (seenIntents.has(t.paymentIntentId)) {
          ctx.addIssue({
            code: "custom",
            path: ["tenders", i, "paymentIntentId"],
            message: "duplicate",
          });
        }
        seenIntents.add(t.paymentIntentId);
      }
      if (t.giftCardCode !== undefined) {
        const code = t.giftCardCode.toUpperCase();
        if (seenCodes.has(code)) {
          ctx.addIssue({
            code: "custom",
            path: ["tenders", i, "giftCardCode"],
            message: "duplicate",
          });
        }
        seenCodes.add(code);
      }
    });
  });

export type LineIntent = z.output<typeof lineIntentSchema>;
export type TenderIntent = z.output<typeof tenderIntentSchema>;
export type CheckoutInput = z.output<typeof checkoutInputSchema>;
/** What a JSON client puts on the wire (money as strings). */
export type CheckoutInputWire = z.input<typeof checkoutInputSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const CHECKOUT_ERROR_CODES = [
  "INVALID_INPUT",
  "EMPTY_CART",
  "SHIFT_REQUIRED",
  "PERMISSION_DENIED",
  "APPROVAL_REQUIRED",
  "APPROVAL_INVALID",
  "VARIANT_NOT_FOUND",
  "VARIANT_INACTIVE",
  "INVALID_QUANTITY",
  "INVALID_SCALE_BARCODE",
  "INVALID_DISCOUNT",
  "STALE_PRICE",
  "TOTAL_MISMATCH",
  "TENDER_MISMATCH",
  "PAYMENT_NOT_CONFIRMED",
  "GIFT_CARD_INSUFFICIENT",
  "INSUFFICIENT_STOCK",
  "CUSTOMER_NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "DUPLICATE_LINE_ID",
  "DUPLICATE_TENDER_REFERENCE",
  "INVALID_PRICE",
  "TENDER_OVERPAID",
  "TENDER_UNDERPAID",
  "TENDER_CASH_NOT_IN_UNITS",
  "CHANGE_TOO_LARGE",
  "GIFT_CARD_NOT_FOUND",
  "GIFT_CARD_INACTIVE",
  "STORE_CREDIT_INSUFFICIENT",
  "SALE_OWNERSHIP_MISMATCH",
  "CONCURRENT_DUPLICATE",
  "INTERNAL",
] as const;
export type CheckoutErrorCode = (typeof CHECKOUT_ERROR_CODES)[number];

/** i18n key (messages namespace `checkout.errors`) for each code. */
export const CHECKOUT_ERROR_MESSAGE_KEYS: Record<CheckoutErrorCode, string> = Object.fromEntries(
  CHECKOUT_ERROR_CODES.map((code) => [code, `checkout.errors.${code}`]),
) as Record<CheckoutErrorCode, string>;

export interface CheckoutError {
  code: CheckoutErrorCode;
  messageKey: string;
  /** Machine-readable context (line ids, expected/actual amounts as strings). */
  details?: Record<string, unknown>;
}

export function checkoutError(
  code: CheckoutErrorCode,
  details?: Record<string, unknown>,
): CheckoutError {
  return {
    code,
    messageKey: CHECKOUT_ERROR_MESSAGE_KEYS[code],
    ...(details ? { details } : {}),
  };
}

/** Map the first tender-validation issue to its checkout code (all issues in details). */
export function checkoutErrorFromTender(issues: readonly TenderIssue[]): CheckoutError {
  const map: Partial<Record<TenderIssue["code"], CheckoutErrorCode>> = {
    OVERPAID: "TENDER_OVERPAID",
    NON_CASH_EXCEEDS_BALANCE: "TENDER_OVERPAID",
    UNDERPAID: "TENDER_UNDERPAID",
    CASH_NOT_IN_UNITS: "TENDER_CASH_NOT_IN_UNITS",
    CHANGE_TOO_LARGE: "CHANGE_TOO_LARGE",
  };
  const first = issues[0];
  return checkoutError((first && map[first.code]) ?? "TENDER_MISMATCH", {
    issues: issues.map((i) => ({
      code: i.code,
      ...(i.index !== undefined ? { index: i.index } : {}),
    })),
  });
}

/** Map a cart-level error to its checkout code. */
export function checkoutErrorFromCart(error: CartError): CheckoutError {
  const map: Partial<Record<CartError["code"], CheckoutErrorCode>> = {
    UNKNOWN_VARIANT: "VARIANT_NOT_FOUND",
    INVALID_QUANTITY: "INVALID_QUANTITY",
    INVALID_SCALE_BARCODE: "INVALID_SCALE_BARCODE",
    INVALID_DISCOUNT: "INVALID_DISCOUNT",
    INVALID_PRICE: "INVALID_PRICE",
    DUPLICATE_LINE_ID: "DUPLICATE_LINE_ID",
  };
  return checkoutError(map[error.code] ?? "INVALID_INPUT", { cart: error.code });
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export const CHECKOUT_STATUSES = ["COMPLETED", "COMPLETED_NEEDS_REVIEW"] as const;
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];

export interface CheckoutResultTotals {
  subtotal: bigint;
  discountTotal: bigint;
  netTotal: bigint;
  vatTotal: bigint;
  cityTotal: bigint;
  total: bigint;
  roundingAmount: bigint;
  payable: bigint;
}

export interface CheckoutResult {
  saleId: string;
  receiptNumber: string;
  status: CheckoutStatus;
  totals: CheckoutResultTotals;
  payments: {
    method: (typeof TENDER_METHODS)[number];
    amount: bigint;
    tendered: bigint | null;
    change: bigint;
    reference?: string;
  }[];
  /** Σ cash change to hand back. */
  change: bigint;
  /** Unguessable token for the receipt share link. */
  shareToken: string;
  /** True when the saleId was already committed and this is the stored sale. */
  replayed: boolean;
}

export const signedMoneyWire = z
  .union([z.string().regex(/^-?\d{1,15}$/), z.number().int().safe()])
  .transform((v) => BigInt(v));

export const checkoutResultSchema = z.object({
  saleId: uuidV7,
  receiptNumber: z.string().min(1),
  status: z.enum(CHECKOUT_STATUSES),
  totals: z.object({
    subtotal: signedMoneyWire,
    discountTotal: signedMoneyWire,
    netTotal: signedMoneyWire,
    vatTotal: signedMoneyWire,
    cityTotal: signedMoneyWire,
    total: signedMoneyWire,
    roundingAmount: signedMoneyWire,
    payable: signedMoneyWire,
  }),
  payments: z.array(
    z.object({
      method: z.enum(TENDER_METHODS),
      amount: signedMoneyWire,
      tendered: signedMoneyWire.nullable(),
      change: signedMoneyWire,
      reference: z.string().optional(),
    }),
  ),
  change: signedMoneyWire,
  shareToken: z.string().min(1),
  replayed: z.boolean(),
});

/** Recursively turn bigint into decimal strings so the value is JSON-safe. */
export function toWire<T>(value: T): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toWire);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, toWire(v)]),
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Intent → Cart (shared by the server's recomputation and by tests)
// ---------------------------------------------------------------------------

export type IntentCartResult = { ok: true; cart: Cart } | { ok: false; error: CheckoutError };

/**
 * Rebuild the authoritative cart from the client's intents using DB prices
 * (`catalog`). STALE_PRICE is reported when `listedUnitPrice` differs from the
 * catalog price. A weighed/scale line with a PRICE label ignores qtyMilli.
 */
export function cartFromCheckoutInput(
  input: Pick<CheckoutInput, "lines" | "cartDiscounts">,
  catalog: CatalogSnapshot,
  rules?: readonly ScaleBarcodeRule[],
): IntentCartResult {
  let cart: Cart = { lines: [], discounts: [] };
  for (const intent of input.lines) {
    // Intents map 1:1 to sale lines, so piece items are NOT merged here.
    const added = intent.scaleBarcode
      ? reduceCart(
          cart,
          {
            type: "ADD_SCALE",
            lineId: intent.lineId,
            barcode: intent.scaleBarcode,
            ...(rules ? { rules } : {}),
          },
          catalog,
        )
      : reduceCart(
          cart,
          {
            type: "ADD_ITEM",
            lineId: intent.lineId,
            variantId: intent.variantId!,
            qtyMilli: intent.qtyMilli!,
            merge: false,
          },
          catalog,
        );
    if (!added.ok) return { ok: false, error: checkoutErrorFromCart(added.error) };
    cart = added.cart;
    const line = cart.lines.find((l) => l.lineId === intent.lineId)!;
    if (intent.listedUnitPrice !== undefined && intent.listedUnitPrice !== line.unitPrice) {
      return {
        ok: false,
        error: checkoutError("STALE_PRICE", {
          lineId: intent.lineId,
          listed: intent.listedUnitPrice.toString(),
          current: line.unitPrice.toString(),
        }),
      };
    }
    if (
      intent.scaleBarcode &&
      intent.qtyMilli !== undefined &&
      line.labelTotal === undefined &&
      intent.qtyMilli !== line.qtyMilli
    ) {
      return { ok: false, error: checkoutError("INVALID_QUANTITY", { lineId: intent.lineId }) };
    }
    const lineId = intent.lineId;
    const steps = [
      ...(intent.priceOverride !== undefined
        ? [{ type: "SET_PRICE_OVERRIDE", lineId, price: intent.priceOverride } as const]
        : []),
      ...intent.discounts.map(
        (discount) => ({ type: "ADD_LINE_DISCOUNT", lineId, discount }) as const,
      ),
      ...(intent.note ? [{ type: "SET_NOTE", lineId, note: intent.note } as const] : []),
    ];
    for (const step of steps) {
      const r = reduceCart(cart, step, catalog);
      if (!r.ok) return { ok: false, error: checkoutErrorFromCart(r.error) };
      cart = r.cart;
    }
  }
  for (const discount of input.cartDiscounts) {
    const r = reduceCart(cart, { type: "APPLY_CART_DISCOUNT", discount }, catalog);
    if (!r.ok) return { ok: false, error: checkoutErrorFromCart(r.error) };
    cart = r.cart;
  }
  return { ok: true, cart };
}

/** Client side: the line intents for a cart (voided lines are dropped). */
export function lineIntentsFromCart(cart: Cart): z.input<typeof lineIntentSchema>[] {
  return cart.lines
    .filter((l) => !l.voided)
    .map((l) => ({
      lineId: l.lineId,
      ...(l.scaleBarcode
        ? { scaleBarcode: l.scaleBarcode }
        : { variantId: l.variantId, qtyMilli: l.qtyMilli }),
      listedUnitPrice: l.unitPrice.toString(),
      ...(l.priceOverride !== undefined ? { priceOverride: l.priceOverride.toString() } : {}),
      discounts: l.discounts.map(discountToWire),
      ...(l.note ? { note: l.note } : {}),
    }));
}

export function discountToWire(
  d: Cart["discounts"][number],
): z.input<typeof discountRequestSchema> {
  return d.kind === "PERCENT"
    ? { kind: "PERCENT", percentBps: d.percentBps, ...(d.reason ? { reason: d.reason } : {}) }
    : { kind: "FIXED", amount: d.amount.toString(), ...(d.reason ? { reason: d.reason } : {}) };
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/**
 * Canonical string of the parts of a CheckoutInput that define WHAT is sold
 * and paid. Excluded on purpose: `approvals` (tokens are re-minted on retry),
 * `createdAtClient` (clock), and `expectedPayable` is kept (it pins the price
 * the customer agreed to). Keys sorted, bigint as decimal, undefined dropped;
 * array order is significant (line order, tender order).
 */
export function canonicalizeCheckoutInput(input: CheckoutInput): string {
  const { approvals: _approvals, createdAtClient: _created, ...content } = input;
  return stableStringify(content);
}

export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return `"${value.toString()}n"`;
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** SHA-256 hex of the canonical intent. Store it on the sale; compare on replay. */
export function checkoutFingerprint(input: CheckoutInput): string {
  return sha256Hex(canonicalizeCheckoutInput(input));
}

/** True when a replay carries the same content as the stored sale. */
export function isSameCheckout(storedFingerprint: string, input: CheckoutInput): boolean {
  return storedFingerprint === checkoutFingerprint(input);
}

// Minimal synchronous SHA-256 (FIPS 180-4) so client and server agree with no
// async WebCrypto / Node-only import. Input is hashed as UTF-8.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 2 ** 32));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[] as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}
