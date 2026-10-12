-- =============================================================================
-- Integrity guards that Prisma cannot express in schema.prisma.
--   1. Append-only tables: financial records and ledgers can never be UPDATEd
--      or DELETEd. Corrections are new rows (voids, refunds, reversal entries).
--   2. CHECK constraints: last line of defence for invariants the services
--      already enforce (positive quantities, non-negative balances, rates).
-- Prisma Migrate does not drop triggers or CHECK constraints it doesn't know.
-- =============================================================================

-- 1. Append-only ---------------------------------------------------------------

CREATE OR REPLACE FUNCTION pos_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on "%" is not allowed: table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation',
          HINT = 'Record a correction (void, refund or reversal entry) instead.';
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Sale', 'SaleLine', 'SaleLineModifier', 'SaleDiscount', 'SalePayment', 'SaleVoid',
    'Refund', 'RefundLine', 'RefundPayment',
    'StockMovement', 'LoyaltyEntry', 'StoreCreditEntry', 'GiftCardEntry',
    'CashMovement', 'ZReport', 'AuditLog'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION pos_forbid_mutation()',
      t || '_append_only', t
    );
  END LOOP;
END;
$$;

-- 2. CHECK constraints -----------------------------------------------------------

ALTER TABLE "BusinessSettings"
  ADD CONSTRAINT "BusinessSettings_singleton" CHECK ("id" = 1),
  ADD CONSTRAINT "BusinessSettings_rounding_positive" CHECK ("totalRoundingUnit" > 0),
  ADD CONSTRAINT "BusinessSettings_loyalty_positive" CHECK ("loyaltyEarnPer" > 0 AND "loyaltyPointValue" >= 0);

ALTER TABLE "TaxClass"
  ADD CONSTRAINT "TaxClass_rates_range" CHECK (
    "vatRateBps" BETWEEN 0 AND 10000 AND "cityTaxRateBps" BETWEEN 0 AND 10000
  );

ALTER TABLE "ProductVariant"
  ADD CONSTRAINT "ProductVariant_price_nonneg" CHECK ("price" >= 0 AND "cost" >= 0);

ALTER TABLE "Modifier"
  ADD CONSTRAINT "Modifier_price_nonneg" CHECK ("priceDelta" >= 0);

ALTER TABLE "ModifierGroup"
  ADD CONSTRAINT "ModifierGroup_select_range" CHECK (
    "minSelect" >= 0 AND ("maxSelect" IS NULL OR "maxSelect" >= "minSelect")
  );

ALTER TABLE "Device"
  ADD CONSTRAINT "Device_failed_pins_nonneg" CHECK ("failedPinAttempts" >= 0);

ALTER TABLE "User"
  ADD CONSTRAINT "User_failed_logins_nonneg" CHECK ("failedLogins" >= 0);

ALTER TABLE "StockMovement"
  ADD CONSTRAINT "StockMovement_qty_nonzero" CHECK ("qtyDeltaMilli" <> 0);

ALTER TABLE "PurchaseOrderLine"
  ADD CONSTRAINT "PurchaseOrderLine_qty_positive" CHECK (
    "qtyOrderedMilli" > 0 AND "qtyReceivedMilli" >= 0 AND "unitCost" >= 0
  );

ALTER TABLE "GoodsReceiptLine"
  ADD CONSTRAINT "GoodsReceiptLine_qty_positive" CHECK ("qtyMilli" > 0 AND "unitCost" >= 0);

ALTER TABLE "StocktakeLine"
  ADD CONSTRAINT "StocktakeLine_counted_nonneg" CHECK ("countedMilli" >= 0);

ALTER TABLE "Customer"
  ADD CONSTRAINT "Customer_balances_nonneg" CHECK ("loyaltyPoints" >= 0 AND "storeCreditBalance" >= 0);

ALTER TABLE "GiftCard"
  ADD CONSTRAINT "GiftCard_balance_nonneg" CHECK ("balance" >= 0 AND "initialBalance" >= 0);

ALTER TABLE "Discount"
  ADD CONSTRAINT "Discount_value_valid" CHECK (
    ("kind" = 'PERCENT' AND "percentBps" BETWEEN 1 AND 10000 AND "amount" IS NULL)
    OR ("kind" = 'FIXED' AND "amount" > 0 AND "percentBps" IS NULL)
  );

ALTER TABLE "Shift"
  ADD CONSTRAINT "Shift_float_nonneg" CHECK ("openingFloat" >= 0);

ALTER TABLE "CashMovement"
  ADD CONSTRAINT "CashMovement_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "SaleLine"
  ADD CONSTRAINT "SaleLine_qty_positive" CHECK ("qtyMilli" > 0),
  ADD CONSTRAINT "SaleLine_amounts_valid" CHECK (
    "unitPrice" >= 0 AND "catalogUnitPrice" >= 0 AND "grossAmount" >= 0
    AND "discountAmount" >= 0 AND "netAmount" >= 0 AND "vatAmount" >= 0
    AND "cityTaxAmount" >= 0 AND "totalAmount" = "netAmount" + "vatAmount" + "cityTaxAmount"
  );

ALTER TABLE "SaleLineModifier"
  ADD CONSTRAINT "SaleLineModifier_price_nonneg" CHECK ("priceDelta" >= 0);

ALTER TABLE "SaleDiscount"
  ADD CONSTRAINT "SaleDiscount_amount_nonneg" CHECK ("amount" >= 0);

ALTER TABLE "Sale"
  ADD CONSTRAINT "Sale_amounts_valid" CHECK (
    "netAmount" >= 0 AND "vatAmount" >= 0 AND "cityTaxAmount" >= 0
    AND "discountAmount" >= 0 AND "itemsAmount" >= 0 AND "tipAmount" >= 0
    AND "totalAmount" >= 0
    AND "totalAmount" = "itemsAmount" + "tipAmount" + "roundingAmount"
  );

ALTER TABLE "SalePayment"
  ADD CONSTRAINT "SalePayment_amounts_valid" CHECK (
    "amount" > 0 AND "change" >= 0
    AND ("change" = 0 OR "method" = 'CASH')
    AND ("tendered" IS NULL OR "tendered" = "amount" + "change")
  );

ALTER TABLE "Refund"
  ADD CONSTRAINT "Refund_amounts_valid" CHECK (
    "netAmount" >= 0 AND "vatAmount" >= 0 AND "cityTaxAmount" >= 0 AND "totalAmount" >= 0
  );

ALTER TABLE "RefundLine"
  ADD CONSTRAINT "RefundLine_qty_positive" CHECK ("qtyMilli" > 0),
  ADD CONSTRAINT "RefundLine_amounts_valid" CHECK (
    "netAmount" >= 0 AND "vatAmount" >= 0 AND "cityTaxAmount" >= 0
    AND "totalAmount" = "netAmount" + "vatAmount" + "cityTaxAmount"
  );

ALTER TABLE "RefundPayment"
  ADD CONSTRAINT "RefundPayment_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "PaymentIntent"
  ADD CONSTRAINT "PaymentIntent_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "Sequence"
  ADD CONSTRAINT "Sequence_value_nonneg" CHECK ("value" >= 0);
