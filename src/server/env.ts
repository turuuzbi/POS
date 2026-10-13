import "server-only";
import { z } from "zod";

const secret = z.string().min(32, "must be at least 32 characters (use: openssl rand -base64 32)");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a PostgreSQL connection string"),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  AUTH_SECRET: secret,
  PIN_PEPPER: secret,
  GIFT_CARD_PEPPER: secret,
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/**
 * Validated server environment. Parsed lazily on first use so that importing
 * a module never crashes a build step that doesn't touch the server.
 */
export function env(): Env {
  if (!cached) {
    // Vercel storage integrations may prefix injected variables (e.g.
    // STRG_DATABASE_URL); DATABASE_ENV_PREFIX names that prefix.
    const prefix = process.env.DATABASE_ENV_PREFIX ?? "";
    const parsed = schema.safeParse({
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL ?? process.env[`${prefix}DATABASE_URL`],
    });
    if (!parsed.success) {
      const problems = parsed.error.issues
        .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
        .join("\n");
      throw new Error(`Invalid environment variables:\n${problems}\nSee .env.example.`);
    }
    cached = parsed.data;
  }
  return cached;
}
