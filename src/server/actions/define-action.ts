import "server-only";
import { unstable_rethrow } from "next/navigation";
import type { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import type { Permission } from "@/domain/permissions";
import { can, getCurrentUser, type CurrentUser } from "../auth/session";
import { requestMeta, type RequestMeta } from "../request";

/**
 * The ONLY way to expose a mutation to the client. Every server action:
 *   1. validates its input with Zod (never trusts the client),
 *   2. authenticates and authorises server-side,
 *   3. maps failures to stable error codes (the UI translates them),
 *   4. never leaks internal errors.
 * A unit test fails the build if a "use server" module exports anything else.
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
  "INTERNAL",
] as const;
export type ActionErrorCode = (typeof ACTION_ERROR_CODES)[number];

export interface ActionFailure {
  code: ActionErrorCode;
  /** Zod field errors for VALIDATION, keyed by dotted path. */
  fieldErrors?: Record<string, string[]>;
}

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ActionFailure };

/** Throw from inside `run` to return a typed failure. */
export class ActionError extends Error {
  constructor(
    readonly code: ActionErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ActionError";
  }
}

export interface ActionContext<I, U> {
  input: I;
  user: U;
  meta: RequestMeta;
}

type Access = "public" | "authenticated" | Permission;

interface ActionDefinition<S extends z.ZodType, R, U> {
  /** Stable name, used in logs. */
  name: string;
  input: S;
  run: (ctx: ActionContext<z.output<S>, U>) => Promise<R>;
}

function fieldErrors(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

function toFailure(name: string, error: unknown): ActionFailure {
  if (error instanceof ActionError) return { code: error.code };
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") return { code: "CONFLICT" };
    if (error.code === "P2025") return { code: "NOT_FOUND" };
  }
  console.error(`[action:${name}] unexpected error`, error);
  return { code: "INTERNAL" };
}

function normalizeInput(raw: unknown): unknown {
  return raw instanceof FormData ? Object.fromEntries(raw) : raw;
}

function build<S extends z.ZodType, R, U>(
  access: Access,
  definition: ActionDefinition<S, R, U>,
): (raw: z.input<S> | FormData) => Promise<ActionResult<R>> {
  return async function action(raw) {
    try {
      const parsed = definition.input.safeParse(normalizeInput(raw));
      let user: CurrentUser | null = null;
      if (access !== "public") {
        user = await getCurrentUser();
        if (!user) return { ok: false, error: { code: "UNAUTHENTICATED" } };
        if (access !== "authenticated" && !can(user, access)) {
          return { ok: false, error: { code: "FORBIDDEN" } };
        }
      } else {
        user = await getCurrentUser();
      }
      if (!parsed.success) {
        return { ok: false, error: { code: "VALIDATION", fieldErrors: fieldErrors(parsed.error) } };
      }
      const data = await definition.run({
        input: parsed.data,
        user: user as U,
        meta: await requestMeta(),
      });
      return { ok: true, data };
    } catch (error) {
      unstable_rethrow(error); // let redirect()/notFound() propagate
      return { ok: false, error: toFailure(definition.name, error) };
    }
  };
}

/** Action requiring a signed-in user and, unless "authenticated", a permission. */
export function defineAction<S extends z.ZodType, R>(
  definition: ActionDefinition<S, R, CurrentUser> & { access: Exclude<Access, "public"> },
) {
  return build(definition.access, definition);
}

/** Action callable without a session (sign-in, locale switch). `user` may be null. */
export function definePublicAction<S extends z.ZodType, R>(
  definition: ActionDefinition<S, R, CurrentUser | null>,
) {
  return build("public", definition);
}

/** Inside `run`: assert a permission at a specific location. */
export function assertCan(user: CurrentUser, permission: Permission, locationId?: string): void {
  if (!can(user, permission, locationId)) throw new ActionError("FORBIDDEN");
}
