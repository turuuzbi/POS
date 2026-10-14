-- Insertion order for the stock ledger (see StockMovement.seq). Existing rows
-- are numbered in storage order; ALTER TABLE does not fire the append-only
-- triggers.

-- DropIndex
DROP INDEX "StockMovement_variantId_locationId_createdAt_idx";

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "seq" BIGSERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_seq_key" ON "StockMovement"("seq");

-- CreateIndex
CREATE INDEX "StockMovement_variantId_locationId_seq_idx" ON "StockMovement"("variantId", "locationId", "seq");

