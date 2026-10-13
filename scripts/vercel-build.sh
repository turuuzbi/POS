#!/usr/bin/env bash
# Vercel build: migrate, (optionally) seed demo data, then build.
# Set as the project's Build Command: `pnpm vercel-build`.
set -euo pipefail

# Vercel's storage integrations may add a prefix to the variables they inject
# (e.g. STRG_DATABASE_URL). DATABASE_ENV_PREFIX names it; map to the
# unprefixed names that Prisma and the app read.
prefix="${DATABASE_ENV_PREFIX:-}"
if [[ -n "$prefix" ]]; then
  pooled="${prefix}DATABASE_URL"; direct="${prefix}DATABASE_URL_UNPOOLED"
  export DATABASE_URL="${DATABASE_URL:-${!pooled:-}}"
  export DIRECT_DATABASE_URL="${DIRECT_DATABASE_URL:-${!direct:-}}"
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set. Connect a Neon database to this Vercel project" \
       "(Storage → Neon) or add DATABASE_URL/DIRECT_DATABASE_URL manually." >&2
  exit 1
fi

# Migrations must use the direct (non-pooled) URL; see prisma.config.ts.
if [[ -z "${DIRECT_DATABASE_URL:-}${DATABASE_URL_UNPOOLED:-}" ]]; then
  echo "Warning: no direct database URL; migrating through DATABASE_URL." >&2
fi
pnpm exec prisma migrate deploy

# Staging only: idempotent demo data (never overwrites existing rows). Like
# migrations it's an admin task, so it goes over the direct URL too, and is
# bounded so a stuck connection fails the build instead of hanging it (a
# first seed from a distant build region takes several minutes).
if [[ "${SEED_ON_DEPLOY:-}" == "1" ]]; then
  DATABASE_URL="${DIRECT_DATABASE_URL:-${DATABASE_URL_UNPOOLED:-$DATABASE_URL}}" \
    SEED_ALLOW_PRODUCTION=1 timeout 900 pnpm exec prisma db seed
fi

pnpm exec next build
