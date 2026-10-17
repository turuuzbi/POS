import "server-only";

/** Attempts of a transaction that Postgres aborted as a deadlock / serialisation victim. */
export const TX_RETRY_ATTEMPTS = 3;

/**
 * 40P01 (deadlock_detected) / 40001 (serialization_failure), as a raw driver
 * error or as Prisma's P2034 ("write conflict or a deadlock"). Nothing was
 * committed, so the whole transaction can run again.
 */
export function isRetryableTxError(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 4) return false;
  const e = error as { code?: unknown; message?: unknown; cause?: unknown; meta?: unknown };
  if (e.code === "P2034" || e.code === "40P01" || e.code === "40001") return true;
  if (typeof e.message === "string" && /40P01|deadlock detected/i.test(e.message)) return true;
  return isRetryableTxError(e.cause, depth + 1) || isRetryableTxError(e.meta, depth + 1);
}

/** Run `attempt` again (up to `attempts` times) while it fails with a retryable error. */
export async function withTxRetry<T>(
  attempt: () => Promise<T>,
  attempts = TX_RETRY_ATTEMPTS,
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await attempt();
    } catch (error) {
      if (i >= attempts || !isRetryableTxError(error)) throw error;
    }
  }
}
