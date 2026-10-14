import "server-only";

/**
 * Stable failure codes shared by services and server actions. The UI
 * translates them (messages/<locale>/errors.json); internals never leak.
 */
export const ACTION_ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "VALIDATION",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "INVALID_CREDENTIALS",
  "DEVICE_REQUIRED",
  /** Not enough stock and the operation may not go negative. */
  "INSUFFICIENT_STOCK",
  /** The record is in a state that doesn't allow this (e.g. a received PO). */
  "INVALID_STATE",
  /** Still referenced elsewhere; archive it instead. */
  "IN_USE",
  "INTERNAL",
] as const;
export type ActionErrorCode = (typeof ACTION_ERROR_CODES)[number];

export interface ActionFailure {
  code: ActionErrorCode;
  /** Zod field errors for VALIDATION, keyed by dotted path. */
  fieldErrors?: Record<string, string[]>;
}

/** Throw from a service or an action's `run` to return a typed failure. */
export class ActionError extends Error {
  constructor(
    readonly code: ActionErrorCode,
    message?: string,
    /** Optional field errors (VALIDATION only), keyed by dotted path. */
    readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message ?? code);
    this.name = "ActionError";
  }
}
