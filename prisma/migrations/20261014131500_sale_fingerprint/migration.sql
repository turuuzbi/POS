-- Idempotency: SHA-256 of the canonical checkout intent (see
-- src/domain/checkout-contract.ts). A replay of the same saleId with the same
-- fingerprint returns the stored sale; a different fingerprint is a conflict.
-- NULL only for sales written before this column existed. Adding a column
-- does not touch the append-only (UPDATE/DELETE) triggers.
ALTER TABLE "Sale" ADD COLUMN "fingerprint" TEXT;
