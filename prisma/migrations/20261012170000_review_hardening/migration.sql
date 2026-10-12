-- DropForeignKey
ALTER TABLE "GoodsReceipt" DROP CONSTRAINT "GoodsReceipt_purchaseOrderId_fkey";

-- DropForeignKey
ALTER TABLE "GoodsReceipt" DROP CONSTRAINT "GoodsReceipt_supplierId_fkey";

-- DropForeignKey
ALTER TABLE "GoodsReceiptLine" DROP CONSTRAINT "GoodsReceiptLine_purchaseOrderLineId_fkey";

-- DropForeignKey
ALTER TABLE "Register" DROP CONSTRAINT "Register_openShiftId_fkey";

-- DropIndex
DROP INDEX "Register_openShiftId_key";

-- DropIndex
DROP INDEX "Sale_requiresReview_idx";

-- AlterTable
ALTER TABLE "Device" DROP COLUMN "failedPinAttempts",
DROP COLUMN "pinLockedUntil";

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "roundingAmount" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "tipAmount" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Register" DROP COLUMN "openShiftId";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "failedLogins",
DROP COLUMN "lockedUntil";

-- CreateTable
CREATE TABLE "SaleReview" (
    "saleId" UUID NOT NULL,
    "reviewedById" UUID NOT NULL,
    "note" TEXT,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaleReview_pkey" PRIMARY KEY ("saleId")
);

-- CreateTable
CREATE TABLE "AuthThrottle" (
    "key" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "lastFailureAt" TIMESTAMP(3) NOT NULL,
    "lockedUntil" TIMESTAMP(3),

    CONSTRAINT "AuthThrottle_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "RevokedSession" (
    "sid" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevokedSession_pkey" PRIMARY KEY ("sid")
);

-- CreateIndex
CREATE INDEX "AuthThrottle_lastFailureAt_idx" ON "AuthThrottle"("lastFailureAt");

-- CreateIndex
CREATE INDEX "RevokedSession_expiresAt_idx" ON "RevokedSession"("expiresAt");

-- CreateIndex
CREATE INDEX "Sale_review_queue_idx" ON "Sale"("createdAt") WHERE ("requiresReview");

-- CreateIndex
CREATE UNIQUE INDEX "Shift_one_open_per_register" ON "Shift"("registerId") WHERE (status = 'OPEN');

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_purchaseOrderLineId_fkey" FOREIGN KEY ("purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleReview" ADD CONSTRAINT "SaleReview_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleReview" ADD CONSTRAINT "SaleReview_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written guards (not expressible in schema.prisma)
-- ---------------------------------------------------------------------------

-- Review decisions are part of the audit trail.
CREATE TRIGGER "SaleReview_append_only" BEFORE UPDATE OR DELETE ON "SaleReview"
  FOR EACH ROW EXECUTE FUNCTION pos_forbid_mutation();

-- Refund totals reconcile like sale totals (tip returned + cash rounding).
ALTER TABLE "Refund" DROP CONSTRAINT "Refund_amounts_valid";
ALTER TABLE "Refund"
  ADD CONSTRAINT "Refund_amounts_valid" CHECK (
    "netAmount" >= 0 AND "vatAmount" >= 0 AND "cityTaxAmount" >= 0 AND "tipAmount" >= 0
    AND "totalAmount" >= 0
    AND "totalAmount" = "netAmount" + "vatAmount" + "cityTaxAmount" + "tipAmount" + "roundingAmount"
  );

ALTER TABLE "AuthThrottle"
  ADD CONSTRAINT "AuthThrottle_failures_nonneg" CHECK ("failures" >= 0);
