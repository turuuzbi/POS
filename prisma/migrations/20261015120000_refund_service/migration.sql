-- Refund / void service (Phase 3): idempotency fingerprints, void reversal
-- record, per-line return reason and the refund window policy.
-- Only adds nullable columns: the append-only triggers guard rows, not DDL.
ALTER TABLE "BusinessSettings" ADD COLUMN "refundWindowDays" INTEGER;
ALTER TABLE "Refund" ADD COLUMN "fingerprint" TEXT;
ALTER TABLE "RefundLine" ADD COLUMN "reason" "ReturnReason";
ALTER TABLE "SaleVoid" ADD COLUMN "fingerprint" TEXT;
ALTER TABLE "SaleVoid" ADD COLUMN "reversals" JSONB;
