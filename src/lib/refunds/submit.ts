/**
 * Send a refund / void and interpret the answer. A thrown error (network),
 * an unreadable answer or an INTERNAL / CONCURRENT_DUPLICATE failure is
 * retried with the IDENTICAL input: the refund id (void: the sale id) is the
 * idempotency key, so a retry can never refund twice. When the retries run
 * out the outcome is UNKNOWN and the screen keeps the input frozen until the
 * cashier resends it (or the server finally answers).
 */
import type { ZodType } from "zod";
import {
  refundResultSchema,
  type RefundInputWire,
  type RefundResult,
} from "@/domain/refund-contract";
import { voidResultSchema, type VoidResult } from "@/domain/void-contract";
import type { ActionResult } from "@/server/actions/define-action";
import { failureView, isTransient, type FailureSource, type FailureView } from "./errors";
import type { VoidInputWire } from "./void";

export type SubmitOutcome<R> =
  | { ok: true; result: R; attempts: number }
  | { ok: false; kind: "failure"; view: FailureView }
  | { ok: false; kind: "unknown" };

export interface SubmitOptions {
  maxAttempts?: number;
  delays?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function submitWithRetry<I, R>(
  call: (input: I) => Promise<ActionResult<unknown>>,
  input: I,
  parse: (data: unknown) => { success: true; data: R } | { success: false },
  source: FailureSource,
  options: SubmitOptions = {},
): Promise<SubmitOutcome<R>> {
  const { maxAttempts = 3, delays = [500, 1500], sleep = defaultSleep } = options;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: ActionResult<unknown> | undefined;
    try {
      response = await call(input);
    } catch {
      response = undefined;
    }
    if (response?.ok) {
      const parsed = parse(response.data);
      if (parsed.success) return { ok: true, result: parsed.data, attempts: attempt };
      // A success we cannot read: it may well have committed.
    } else if (response) {
      const view = failureView(response.error, source);
      if (!isTransient(view)) return { ok: false, kind: "failure", view };
    }
    if (attempt < maxAttempts) await sleep(delays[Math.min(attempt - 1, delays.length - 1)] ?? 500);
  }
  return { ok: false, kind: "unknown" };
}

function parserOf<R>(schema: ZodType<R>) {
  return (data: unknown) => {
    const parsed = schema.safeParse(data);
    return parsed.success
      ? ({ success: true, data: parsed.data } as const)
      : ({ success: false } as const);
  };
}

const parseRefund = parserOf(refundResultSchema as unknown as ZodType<RefundResult>);
const parseVoid = parserOf(voidResultSchema as unknown as ZodType<VoidResult>);

export function submitRefund(
  call: (input: RefundInputWire) => Promise<ActionResult<unknown>>,
  input: RefundInputWire,
  options?: SubmitOptions,
) {
  return submitWithRetry<RefundInputWire, RefundResult>(
    call,
    input,
    parseRefund,
    "refund",
    options,
  );
}

export function submitVoid(
  call: (input: VoidInputWire) => Promise<ActionResult<unknown>>,
  input: VoidInputWire,
  options?: SubmitOptions,
) {
  return submitWithRetry<VoidInputWire, VoidResult>(call, input, parseVoid, "void", options);
}
