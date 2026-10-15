/**
 * Sales-history filter (pure): query-string parameters -> a validated filter.
 * Dates are calendar days in the shop's timezone (Asia/Ulaanbaatar), turned
 * into a half-open UTC instant range; nothing here touches I/O or the clock.
 */
import { DEFAULT_TIME_ZONE } from "@/i18n/config";
import { parseMoney, type Money } from "./money";
import { isSaleStatus, type SaleStatus } from "./sale-status";
import { RECEIPT_PAYMENT_METHODS, type ReceiptPaymentMethod } from "./receipt";

export const SALES_PAGE_SIZE = 25;
/** Longest receipt-number search we run (receipt numbers are short codes). */
export const MAX_SEARCH_LENGTH = 40;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Offset (ms) of `timeZone` from UTC at an instant. */
function zoneOffsetMs(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** Valid `YYYY-MM-DD` calendar day -> [y, m, d], else null. */
export function parseDay(value: string | undefined): [number, number, number] | null {
  const match = value ? DAY.exec(value) : null;
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return [y, m, d];
}

/** The instant a calendar day starts in `timeZone`, or null for a bad day. */
export function zonedDayStart(day: string, timeZone: string = DEFAULT_TIME_ZONE): Date | null {
  const ymd = parseDay(day);
  if (!ymd) return null;
  const guess = Date.UTC(ymd[0], ymd[1] - 1, ymd[2]);
  try {
    // Two passes settle the offset across a DST jump.
    const first = guess - zoneOffsetMs(guess, timeZone);
    return new Date(guess - zoneOffsetMs(first, timeZone));
  } catch {
    return zonedDayStart(day, DEFAULT_TIME_ZONE);
  }
}

/** The day after `day` as `YYYY-MM-DD`. */
export function nextDay(day: string): string | null {
  const ymd = parseDay(day);
  if (!ymd) return null;
  return new Date(Date.UTC(ymd[0], ymd[1] - 1, ymd[2] + 1)).toISOString().slice(0, 10);
}

export interface SalesFilter {
  /** Inclusive start / exclusive end instant. */
  from: Date | null;
  to: Date | null;
  /** The days as typed (`YYYY-MM-DD`), to refill the form. */
  fromDay: string | null;
  toDay: string | null;
  locationId: string | null;
  registerId: string | null;
  cashierId: string | null;
  method: ReceiptPaymentMethod | null;
  status: SaleStatus | null;
  /** Receipt-number search text (substring, case-insensitive). */
  q: string | null;
  minAmount: Money | null;
  maxAmount: Money | null;
  page: number;
  /** Parameters that were present but unusable (shown as a hint, never fatal). */
  invalid: string[];
}

type Params = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined): string | undefined => {
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = v?.trim();
  return trimmed ? trimmed : undefined;
};

export function parseSalesFilter(
  params: Params,
  timeZone: string = DEFAULT_TIME_ZONE,
): SalesFilter {
  const invalid: string[] = [];
  const uuid = (key: string): string | null => {
    const v = first(params[key]);
    if (!v) return null;
    if (!UUID.test(v)) {
      invalid.push(key);
      return null;
    }
    return v.toLowerCase();
  };

  let fromDay: string | null = null;
  let from: Date | null = null;
  const fromRaw = first(params.from);
  if (fromRaw) {
    from = zonedDayStart(fromRaw, timeZone);
    if (from) fromDay = fromRaw;
    else invalid.push("from");
  }
  let toDay: string | null = null;
  let to: Date | null = null;
  const toRaw = first(params.to);
  if (toRaw) {
    const after = nextDay(toRaw);
    to = after ? zonedDayStart(after, timeZone) : null;
    if (to) toDay = toRaw;
    else invalid.push("to");
  }
  if (from && to && from >= to) {
    // An inverted range would silently match nothing; drop the end and say so.
    to = null;
    toDay = null;
    invalid.push("to");
  }

  const methodRaw = first(params.method);
  const method = (RECEIPT_PAYMENT_METHODS as readonly string[]).includes(methodRaw ?? "")
    ? (methodRaw as ReceiptPaymentMethod)
    : null;
  if (methodRaw && !method) invalid.push("method");

  const statusRaw = first(params.status);
  const status = isSaleStatus(statusRaw) ? statusRaw : null;
  if (statusRaw && !status) invalid.push("status");

  const amount = (key: string): Money | null => {
    const v = first(params[key]);
    if (!v) return null;
    const parsed = parseMoney(v);
    if (parsed === null) invalid.push(key);
    return parsed;
  };
  let minAmount = amount("min");
  let maxAmount = amount("max");
  if (minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
    [minAmount, maxAmount] = [maxAmount, minAmount];
  }

  const q = first(params.q)?.slice(0, MAX_SEARCH_LENGTH) ?? null;
  const pageRaw = Number(first(params.page));
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 && pageRaw <= 100_000 ? pageRaw : 1;

  return {
    from,
    to,
    fromDay,
    toDay,
    locationId: uuid("location"),
    registerId: uuid("register"),
    cashierId: uuid("cashier"),
    method,
    status,
    q,
    minAmount,
    maxAmount,
    page,
    invalid,
  };
}

/** The filter as query parameters (for pager and export links); empty values dropped. */
export function salesFilterParams(filter: SalesFilter): Record<string, string | undefined> {
  const major = (v: Money | null) =>
    v === null
      ? undefined
      : `${v / 100n}${v % 100n === 0n ? "" : "." + String(v % 100n).padStart(2, "0")}`;
  return {
    from: filter.fromDay ?? undefined,
    to: filter.toDay ?? undefined,
    location: filter.locationId ?? undefined,
    register: filter.registerId ?? undefined,
    cashier: filter.cashierId ?? undefined,
    method: filter.method ?? undefined,
    status: filter.status ?? undefined,
    q: filter.q ?? undefined,
    min: major(filter.minAmount),
    max: major(filter.maxAmount),
  };
}

/** Escapes `\`, `%` and `_` so user text is matched literally by LIKE/ILIKE. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
