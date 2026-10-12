#!/usr/bin/env bash
# Vercel build: migrate, (optionally) seed demo data, then build.
# Set as the project's Build Command: `pnpm vercel-build`.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set. Connect a Neon database to this Vercel project" \
       "(Storage → Neon) or add DATABASE_URL/DIRECT_DATABASE_URL manually." >&2
  exit 1
fi

# Migrations use the direct (non-pooled) URL; see prisma.config.ts.
pnpm exec prisma migrate deploy

# Staging only: idempotent demo data (never overwrites existing rows).
if [[ "${SEED_ON_DEPLOY:-}" == "1" ]]; then
  SEED_ALLOW_PRODUCTION=1 pnpm exec prisma db seed
fi

pnpm exec next build
