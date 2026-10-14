-- A runner claims a FiscalReceipt (PENDING/FAILED -> ISSUING) before calling the provider,
-- so concurrent runs cannot both issue. A claim older than the timeout is retried.
ALTER TYPE "FiscalStatus" ADD VALUE 'ISSUING';

ALTER TABLE "FiscalReceipt" ADD COLUMN "claimedAt" TIMESTAMP(3);
