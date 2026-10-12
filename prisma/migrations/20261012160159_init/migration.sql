-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'MANAGER', 'CASHIER');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('STANDARD', 'SERVICE', 'GIFT_CARD');

-- CreateEnum
CREATE TYPE "UnitOfMeasure" AS ENUM ('PIECE', 'KG', 'LITER', 'METER');

-- CreateEnum
CREATE TYPE "TaxTreatment" AS ENUM ('STANDARD', 'ZERO_RATED', 'EXEMPT');

-- CreateEnum
CREATE TYPE "DiscountKind" AS ENUM ('PERCENT', 'FIXED');

-- CreateEnum
CREATE TYPE "DiscountTarget" AS ENUM ('ORDER', 'PRODUCTS');

-- CreateEnum
CREATE TYPE "DiscountScope" AS ENUM ('LINE', 'CART');

-- CreateEnum
CREATE TYPE "DiscountSource" AS ENUM ('MANUAL', 'AUTOMATIC', 'CODE', 'LOYALTY');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'QPAY', 'BANK_TRANSFER', 'GIFT_CARD', 'STORE_CREDIT', 'EXCHANGE_CREDIT');

-- CreateEnum
CREATE TYPE "PaymentIntentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "SaleOrigin" AS ENUM ('ONLINE', 'OFFLINE_SYNC');

-- CreateEnum
CREATE TYPE "VoidReason" AS ENUM ('ENTRY_ERROR', 'CUSTOMER_CANCELLED', 'PAYMENT_PROBLEM', 'OTHER');

-- CreateEnum
CREATE TYPE "ReturnReason" AS ENUM ('DEFECTIVE', 'DAMAGED', 'WRONG_ITEM', 'NOT_AS_DESCRIBED', 'CHANGED_MIND', 'OTHER');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('OPENING', 'SALE', 'SALE_VOID', 'RETURN_RESTOCK', 'PURCHASE_RECEIPT', 'ADJUSTMENT', 'STOCKTAKE');

-- CreateEnum
CREATE TYPE "AdjustmentReason" AS ENUM ('DAMAGED', 'EXPIRED', 'LOST_STOLEN', 'FOUND', 'INTERNAL_USE', 'CORRECTION', 'OTHER');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StocktakeStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "CashMovementType" AS ENUM ('CASH_IN', 'CASH_OUT');

-- CreateEnum
CREATE TYPE "LoyaltyEntryType" AS ENUM ('EARN', 'REDEEM', 'REVERSAL', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "StoreCreditEntryType" AS ENUM ('ISSUE', 'REDEEM', 'REVERSAL', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "GiftCardStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "GiftCardEntryType" AS ENUM ('ISSUE', 'REDEEM', 'REFUND', 'REVERSAL', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "FiscalStatus" AS ENUM ('PENDING', 'ISSUED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReceiptChannel" AS ENUM ('SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

-- CreateTable
CREATE TABLE "BusinessSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "businessName" TEXT NOT NULL,
    "legalName" TEXT,
    "taxId" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "logoUrl" TEXT,
    "defaultLocale" TEXT NOT NULL DEFAULT 'mn',
    "currency" CHAR(3) NOT NULL DEFAULT 'MNT',
    "defaultTaxClassId" UUID,
    "pricesIncludeTax" BOOLEAN NOT NULL DEFAULT true,
    "totalRoundingUnit" BIGINT NOT NULL DEFAULT 100,
    "allowNegativeStock" BOOLEAN NOT NULL DEFAULT true,
    "scaleBarcodeRules" JSONB,
    "tipsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "tipPresetsBps" INTEGER[] DEFAULT ARRAY[500, 1000, 1500]::INTEGER[],
    "loyaltyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "loyaltyEarnPer" BIGINT NOT NULL DEFAULT 100000,
    "loyaltyPointValue" BIGINT NOT NULL DEFAULT 1000,
    "receiptHeader" TEXT,
    "receiptFooter" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Ulaanbaatar',
    "restaurantMode" BOOLEAN NOT NULL DEFAULT false,
    "receiptHeader" TEXT,
    "fiscalConfig" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Register" (
    "id" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "openShiftId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Register_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "registerId" UUID,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "pairedById" UUID NOT NULL,
    "pairedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "failedPinAttempts" INTEGER NOT NULL DEFAULT 0,
    "pinLockedUntil" TIMESTAMP(3),

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "passwordHash" TEXT,
    "pinLookup" TEXT,
    "role" "Role" NOT NULL DEFAULT 'CASHIER',
    "locale" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserLocation" (
    "userId" UUID NOT NULL,
    "locationId" UUID NOT NULL,

    CONSTRAINT "UserLocation_pkey" PRIMARY KEY ("userId","locationId")
);

-- CreateTable
CREATE TABLE "TaxClass" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "treatment" "TaxTreatment" NOT NULL DEFAULT 'STANDARD',
    "vatRateBps" INTEGER NOT NULL DEFAULT 1000,
    "cityTaxRateBps" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxClass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" UUID,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "color" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "ProductType" NOT NULL DEFAULT 'STANDARD',
    "unit" "UnitOfMeasure" NOT NULL DEFAULT 'PIECE',
    "categoryId" UUID,
    "taxClassId" UUID NOT NULL,
    "pricesIncludeTax" BOOLEAN NOT NULL DEFAULT true,
    "trackStock" BOOLEAN NOT NULL DEFAULT true,
    "imageUrl" TEXT,
    "taxClassificationCode" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductOption" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "values" TEXT[],

    CONSTRAINT "ProductOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "sku" TEXT,
    "pluCode" TEXT,
    "name" TEXT,
    "option1" TEXT,
    "option2" TEXT,
    "option3" TEXT,
    "price" BIGINT NOT NULL,
    "cost" BIGINT NOT NULL DEFAULT 0,
    "imageUrl" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Barcode" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "variantId" UUID NOT NULL,

    CONSTRAINT "Barcode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuickKey" (
    "id" UUID NOT NULL,
    "locationId" UUID,
    "categoryId" UUID,
    "productId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "color" TEXT,

    CONSTRAINT "QuickKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModifierGroup" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "minSelect" INTEGER NOT NULL DEFAULT 0,
    "maxSelect" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModifierGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Modifier" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "priceDelta" BIGINT NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Modifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductModifierGroup" (
    "productId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductModifierGroup_pkey" PRIMARY KEY ("productId","groupId")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "taxId" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierItem" (
    "supplierId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "supplierSku" TEXT,
    "cost" BIGINT,
    "isPreferred" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SupplierItem_pkey" PRIMARY KEY ("supplierId","variantId")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "supplierId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "expectedAt" TIMESTAMP(3),
    "orderedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" UUID NOT NULL,
    "purchaseOrderId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "qtyOrderedMilli" INTEGER NOT NULL,
    "qtyReceivedMilli" INTEGER NOT NULL DEFAULT 0,
    "unitCost" BIGINT NOT NULL,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceipt" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "purchaseOrderId" UUID,
    "supplierId" UUID,
    "locationId" UUID NOT NULL,
    "note" TEXT,
    "receivedById" UUID NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceiptLine" (
    "id" UUID NOT NULL,
    "goodsReceiptId" UUID NOT NULL,
    "purchaseOrderLineId" UUID,
    "variantId" UUID NOT NULL,
    "qtyMilli" INTEGER NOT NULL,
    "unitCost" BIGINT NOT NULL,

    CONSTRAINT "GoodsReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLevel" (
    "variantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "onHandMilli" INTEGER NOT NULL DEFAULT 0,
    "reorderPointMilli" INTEGER,
    "reorderQtyMilli" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockLevel_pkey" PRIMARY KEY ("variantId","locationId")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "qtyDeltaMilli" INTEGER NOT NULL,
    "balanceAfterMilli" INTEGER NOT NULL,
    "unitCost" BIGINT,
    "saleId" UUID,
    "refundId" UUID,
    "goodsReceiptId" UUID,
    "adjustmentId" UUID,
    "stocktakeId" UUID,
    "note" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockAdjustment" (
    "id" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "reason" "AdjustmentReason" NOT NULL,
    "note" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stocktake" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "locationId" UUID NOT NULL,
    "categoryId" UUID,
    "status" "StocktakeStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "note" TEXT,
    "startedById" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedById" UUID,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Stocktake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StocktakeLine" (
    "id" UUID NOT NULL,
    "stocktakeId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "countedMilli" INTEGER NOT NULL,
    "expectedMilli" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StocktakeLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "taxId" TEXT,
    "notes" TEXT,
    "loyaltyPoints" INTEGER NOT NULL DEFAULT 0,
    "storeCreditBalance" BIGINT NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyEntry" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "type" "LoyaltyEntryType" NOT NULL,
    "points" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "saleId" UUID,
    "refundId" UUID,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreCreditEntry" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "type" "StoreCreditEntryType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "balanceAfter" BIGINT NOT NULL,
    "saleId" UUID,
    "refundId" UUID,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreCreditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftCard" (
    "id" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "last4" CHAR(4) NOT NULL,
    "initialBalance" BIGINT NOT NULL,
    "balance" BIGINT NOT NULL,
    "status" "GiftCardStatus" NOT NULL DEFAULT 'ACTIVE',
    "customerId" UUID,
    "expiresAt" TIMESTAMP(3),
    "saleLineId" UUID,
    "issuedById" UUID NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftCardEntry" (
    "id" UUID NOT NULL,
    "giftCardId" UUID NOT NULL,
    "type" "GiftCardEntryType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "balanceAfter" BIGINT NOT NULL,
    "saleId" UUID,
    "refundId" UUID,
    "note" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftCardEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Discount" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "kind" "DiscountKind" NOT NULL,
    "percentBps" INTEGER,
    "amount" BIGINT,
    "target" "DiscountTarget" NOT NULL DEFAULT 'ORDER',
    "minSubtotal" BIGINT,
    "minQtyMilli" INTEGER,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Discount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscountProduct" (
    "discountId" UUID NOT NULL,
    "productId" UUID NOT NULL,

    CONSTRAINT "DiscountProduct_pkey" PRIMARY KEY ("discountId","productId")
);

-- CreateTable
CREATE TABLE "DiscountCategory" (
    "discountId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,

    CONSTRAINT "DiscountCategory_pkey" PRIMARY KEY ("discountId","categoryId")
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" UUID NOT NULL,
    "registerId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "openedById" UUID NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openingFloat" BIGINT NOT NULL,
    "closedById" UUID,
    "closedAt" TIMESTAMP(3),
    "expectedCash" BIGINT,
    "countedCash" BIGINT,
    "cashVariance" BIGINT,
    "denominations" JSONB,
    "closingNote" TEXT,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashMovement" (
    "id" UUID NOT NULL,
    "shiftId" UUID NOT NULL,
    "type" "CashMovementType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "approvedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZReport" (
    "id" UUID NOT NULL,
    "shiftId" UUID NOT NULL,
    "registerId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ZReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sale" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "locationId" UUID NOT NULL,
    "registerId" UUID NOT NULL,
    "shiftId" UUID NOT NULL,
    "cashierId" UUID NOT NULL,
    "customerId" UUID,
    "origin" "SaleOrigin" NOT NULL DEFAULT 'ONLINE',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "netAmount" BIGINT NOT NULL,
    "vatAmount" BIGINT NOT NULL,
    "cityTaxAmount" BIGINT NOT NULL DEFAULT 0,
    "discountAmount" BIGINT NOT NULL DEFAULT 0,
    "itemsAmount" BIGINT NOT NULL,
    "tipAmount" BIGINT NOT NULL DEFAULT 0,
    "roundingAmount" BIGINT NOT NULL DEFAULT 0,
    "totalAmount" BIGINT NOT NULL,
    "buyerTaxId" TEXT,
    "note" TEXT,
    "publicToken" TEXT NOT NULL,
    "requiresReview" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleLine" (
    "id" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "variantId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "categoryId" UUID,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "productType" "ProductType" NOT NULL,
    "unit" "UnitOfMeasure" NOT NULL,
    "qtyMilli" INTEGER NOT NULL,
    "catalogUnitPrice" BIGINT NOT NULL,
    "unitPrice" BIGINT NOT NULL,
    "priceOverrideById" UUID,
    "pricesIncludeTax" BOOLEAN NOT NULL,
    "taxTreatment" "TaxTreatment" NOT NULL,
    "vatRateBps" INTEGER NOT NULL,
    "cityTaxRateBps" INTEGER NOT NULL DEFAULT 0,
    "grossAmount" BIGINT NOT NULL,
    "discountAmount" BIGINT NOT NULL DEFAULT 0,
    "netAmount" BIGINT NOT NULL,
    "vatAmount" BIGINT NOT NULL,
    "cityTaxAmount" BIGINT NOT NULL DEFAULT 0,
    "totalAmount" BIGINT NOT NULL,
    "unitCost" BIGINT NOT NULL,
    "note" TEXT,

    CONSTRAINT "SaleLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleLineModifier" (
    "id" UUID NOT NULL,
    "saleLineId" UUID NOT NULL,
    "modifierId" UUID,
    "name" TEXT NOT NULL,
    "priceDelta" BIGINT NOT NULL,

    CONSTRAINT "SaleLineModifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleDiscount" (
    "id" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "saleLineId" UUID,
    "scope" "DiscountScope" NOT NULL,
    "source" "DiscountSource" NOT NULL,
    "discountId" UUID,
    "kind" "DiscountKind" NOT NULL,
    "percentBps" INTEGER,
    "fixedAmount" BIGINT,
    "amount" BIGINT NOT NULL,
    "loyaltyPoints" INTEGER,
    "reason" TEXT,
    "approvedById" UUID,

    CONSTRAINT "SaleDiscount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalePayment" (
    "id" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" BIGINT NOT NULL,
    "tendered" BIGINT,
    "change" BIGINT NOT NULL DEFAULT 0,
    "reference" TEXT,
    "cardBrand" TEXT,
    "cardLast4" CHAR(4),
    "paymentIntentId" UUID,
    "giftCardId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "saleId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" "PaymentIntentStatus" NOT NULL DEFAULT 'PENDING',
    "providerRef" TEXT,
    "qrText" TEXT,
    "deeplinks" JSONB,
    "raw" JSONB,
    "expiresAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleVoid" (
    "id" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "shiftId" UUID NOT NULL,
    "reason" "VoidReason" NOT NULL,
    "note" TEXT,
    "voidedById" UUID NOT NULL,
    "approvedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaleVoid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "saleId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "registerId" UUID NOT NULL,
    "shiftId" UUID NOT NULL,
    "customerId" UUID,
    "processedById" UUID NOT NULL,
    "approvedById" UUID,
    "reason" "ReturnReason" NOT NULL,
    "note" TEXT,
    "netAmount" BIGINT NOT NULL,
    "vatAmount" BIGINT NOT NULL,
    "cityTaxAmount" BIGINT NOT NULL DEFAULT 0,
    "totalAmount" BIGINT NOT NULL,
    "exchangeSaleId" UUID,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundLine" (
    "id" UUID NOT NULL,
    "refundId" UUID NOT NULL,
    "saleLineId" UUID NOT NULL,
    "qtyMilli" INTEGER NOT NULL,
    "restock" BOOLEAN NOT NULL,
    "netAmount" BIGINT NOT NULL,
    "vatAmount" BIGINT NOT NULL,
    "cityTaxAmount" BIGINT NOT NULL DEFAULT 0,
    "totalAmount" BIGINT NOT NULL,
    "unitCost" BIGINT NOT NULL,

    CONSTRAINT "RefundLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundPayment" (
    "id" UUID NOT NULL,
    "refundId" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" BIGINT NOT NULL,
    "originalPaymentId" UUID,
    "reference" TEXT,
    "giftCardId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefundPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalReceipt" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "saleId" UUID,
    "refundId" UUID,
    "status" "FiscalStatus" NOT NULL DEFAULT 'PENDING',
    "externalId" TEXT,
    "lotteryCode" TEXT,
    "qrData" TEXT,
    "request" JSONB,
    "response" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "issuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FiscalReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptDelivery" (
    "id" UUID NOT NULL,
    "saleId" UUID,
    "refundId" UUID,
    "channel" "ReceiptChannel" NOT NULL,
    "destination" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "providerRef" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiningTable" (
    "id" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "area" TEXT,
    "seats" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "DiningTable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpenTicket" (
    "id" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "tableId" UUID,
    "name" TEXT NOT NULL,
    "cart" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "saleId" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpenTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KitchenTicket" (
    "id" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "openTicketId" UUID,
    "saleId" UUID,
    "number" INTEGER NOT NULL,
    "items" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "printedAt" TIMESTAMP(3),

    CONSTRAINT "KitchenTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sequence" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Sequence_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "locationId" UUID,
    "registerId" UUID,
    "before" JSONB,
    "after" JSONB,
    "meta" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Location_code_key" ON "Location"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Register_openShiftId_key" ON "Register"("openShiftId");

-- CreateIndex
CREATE UNIQUE INDEX "Register_locationId_code_key" ON "Register"("locationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Device_tokenHash_key" ON "Device"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_pinLookup_key" ON "User"("pinLookup");

-- CreateIndex
CREATE INDEX "UserLocation_locationId_idx" ON "UserLocation"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "TaxClass_name_key" ON "TaxClass"("name");

-- CreateIndex
CREATE INDEX "Category_parentId_idx" ON "Category"("parentId");

-- CreateIndex
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

-- CreateIndex
CREATE INDEX "Product_name_idx" ON "Product" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "ProductOption_productId_position_key" ON "ProductOption"("productId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_sku_key" ON "ProductVariant"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_pluCode_key" ON "ProductVariant"("pluCode");

-- CreateIndex
CREATE INDEX "ProductVariant_productId_idx" ON "ProductVariant"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "Barcode_code_key" ON "Barcode"("code");

-- CreateIndex
CREATE INDEX "Barcode_variantId_idx" ON "Barcode"("variantId");

-- CreateIndex
CREATE INDEX "QuickKey_locationId_categoryId_position_idx" ON "QuickKey"("locationId", "categoryId", "position");

-- CreateIndex
CREATE INDEX "Modifier_groupId_idx" ON "Modifier"("groupId");

-- CreateIndex
CREATE INDEX "SupplierItem_variantId_idx" ON "SupplierItem"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_number_key" ON "PurchaseOrder"("number");

-- CreateIndex
CREATE INDEX "PurchaseOrder_supplierId_idx" ON "PurchaseOrder"("supplierId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_locationId_status_idx" ON "PurchaseOrder"("locationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderLine_purchaseOrderId_variantId_key" ON "PurchaseOrderLine"("purchaseOrderId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_number_key" ON "GoodsReceipt"("number");

-- CreateIndex
CREATE INDEX "GoodsReceipt_purchaseOrderId_idx" ON "GoodsReceipt"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "GoodsReceipt_locationId_receivedAt_idx" ON "GoodsReceipt"("locationId", "receivedAt");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_goodsReceiptId_idx" ON "GoodsReceiptLine"("goodsReceiptId");

-- CreateIndex
CREATE INDEX "StockLevel_locationId_idx" ON "StockLevel"("locationId");

-- CreateIndex
CREATE INDEX "StockMovement_variantId_locationId_createdAt_idx" ON "StockMovement"("variantId", "locationId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMovement_locationId_createdAt_idx" ON "StockMovement"("locationId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMovement_saleId_idx" ON "StockMovement"("saleId");

-- CreateIndex
CREATE INDEX "StockMovement_refundId_idx" ON "StockMovement"("refundId");

-- CreateIndex
CREATE INDEX "StockAdjustment_locationId_createdAt_idx" ON "StockAdjustment"("locationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Stocktake_number_key" ON "Stocktake"("number");

-- CreateIndex
CREATE INDEX "Stocktake_locationId_status_idx" ON "Stocktake"("locationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StocktakeLine_stocktakeId_variantId_key" ON "StocktakeLine"("stocktakeId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_phone_key" ON "Customer"("phone");

-- CreateIndex
CREATE INDEX "Customer_email_idx" ON "Customer"("email");

-- CreateIndex
CREATE INDEX "Customer_name_idx" ON "Customer" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "LoyaltyEntry_customerId_createdAt_idx" ON "LoyaltyEntry"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "StoreCreditEntry_customerId_createdAt_idx" ON "StoreCreditEntry"("customerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCard_codeHash_key" ON "GiftCard"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCard_saleLineId_key" ON "GiftCard"("saleLineId");

-- CreateIndex
CREATE INDEX "GiftCardEntry_giftCardId_createdAt_idx" ON "GiftCardEntry"("giftCardId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Discount_code_key" ON "Discount"("code");

-- CreateIndex
CREATE INDEX "Discount_isActive_startsAt_endsAt_idx" ON "Discount"("isActive", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "Shift_registerId_openedAt_idx" ON "Shift"("registerId", "openedAt");

-- CreateIndex
CREATE INDEX "Shift_locationId_openedAt_idx" ON "Shift"("locationId", "openedAt");

-- CreateIndex
CREATE INDEX "CashMovement_shiftId_idx" ON "CashMovement"("shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "ZReport_shiftId_key" ON "ZReport"("shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "ZReport_registerId_number_key" ON "ZReport"("registerId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_number_key" ON "Sale"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_publicToken_key" ON "Sale"("publicToken");

-- CreateIndex
CREATE INDEX "Sale_locationId_occurredAt_idx" ON "Sale"("locationId", "occurredAt");

-- CreateIndex
CREATE INDEX "Sale_cashierId_occurredAt_idx" ON "Sale"("cashierId", "occurredAt");

-- CreateIndex
CREATE INDEX "Sale_customerId_occurredAt_idx" ON "Sale"("customerId", "occurredAt");

-- CreateIndex
CREATE INDEX "Sale_shiftId_idx" ON "Sale"("shiftId");

-- CreateIndex
CREATE INDEX "Sale_requiresReview_idx" ON "Sale"("requiresReview");

-- CreateIndex
CREATE INDEX "SaleLine_variantId_idx" ON "SaleLine"("variantId");

-- CreateIndex
CREATE INDEX "SaleLine_productId_idx" ON "SaleLine"("productId");

-- CreateIndex
CREATE INDEX "SaleLine_categoryId_idx" ON "SaleLine"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "SaleLine_saleId_lineNo_key" ON "SaleLine"("saleId", "lineNo");

-- CreateIndex
CREATE INDEX "SaleLineModifier_saleLineId_idx" ON "SaleLineModifier"("saleLineId");

-- CreateIndex
CREATE INDEX "SaleDiscount_saleId_idx" ON "SaleDiscount"("saleId");

-- CreateIndex
CREATE INDEX "SaleDiscount_discountId_idx" ON "SaleDiscount"("discountId");

-- CreateIndex
CREATE UNIQUE INDEX "SalePayment_paymentIntentId_key" ON "SalePayment"("paymentIntentId");

-- CreateIndex
CREATE INDEX "SalePayment_saleId_idx" ON "SalePayment"("saleId");

-- CreateIndex
CREATE INDEX "SalePayment_method_createdAt_idx" ON "SalePayment"("method", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentIntent_saleId_idx" ON "PaymentIntent"("saleId");

-- CreateIndex
CREATE INDEX "PaymentIntent_status_createdAt_idx" ON "PaymentIntent"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_provider_providerRef_key" ON "PaymentIntent"("provider", "providerRef");

-- CreateIndex
CREATE UNIQUE INDEX "SaleVoid_saleId_key" ON "SaleVoid"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_number_key" ON "Refund"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_exchangeSaleId_key" ON "Refund"("exchangeSaleId");

-- CreateIndex
CREATE INDEX "Refund_saleId_idx" ON "Refund"("saleId");

-- CreateIndex
CREATE INDEX "Refund_locationId_occurredAt_idx" ON "Refund"("locationId", "occurredAt");

-- CreateIndex
CREATE INDEX "Refund_shiftId_idx" ON "Refund"("shiftId");

-- CreateIndex
CREATE INDEX "RefundLine_refundId_idx" ON "RefundLine"("refundId");

-- CreateIndex
CREATE INDEX "RefundLine_saleLineId_idx" ON "RefundLine"("saleLineId");

-- CreateIndex
CREATE INDEX "RefundPayment_refundId_idx" ON "RefundPayment"("refundId");

-- CreateIndex
CREATE INDEX "RefundPayment_method_createdAt_idx" ON "RefundPayment"("method", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalReceipt_saleId_key" ON "FiscalReceipt"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalReceipt_refundId_key" ON "FiscalReceipt"("refundId");

-- CreateIndex
CREATE INDEX "FiscalReceipt_status_createdAt_idx" ON "FiscalReceipt"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ReceiptDelivery_saleId_idx" ON "ReceiptDelivery"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "DiningTable_locationId_name_key" ON "DiningTable"("locationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "OpenTicket_saleId_key" ON "OpenTicket"("saleId");

-- CreateIndex
CREATE INDEX "OpenTicket_locationId_status_idx" ON "OpenTicket"("locationId", "status");

-- CreateIndex
CREATE INDEX "KitchenTicket_locationId_createdAt_idx" ON "KitchenTicket"("locationId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "BusinessSettings" ADD CONSTRAINT "BusinessSettings_defaultTaxClassId_fkey" FOREIGN KEY ("defaultTaxClassId") REFERENCES "TaxClass"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Register" ADD CONSTRAINT "Register_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Register" ADD CONSTRAINT "Register_openShiftId_fkey" FOREIGN KEY ("openShiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_registerId_fkey" FOREIGN KEY ("registerId") REFERENCES "Register"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_pairedById_fkey" FOREIGN KEY ("pairedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserLocation" ADD CONSTRAINT "UserLocation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserLocation" ADD CONSTRAINT "UserLocation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_taxClassId_fkey" FOREIGN KEY ("taxClassId") REFERENCES "TaxClass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductOption" ADD CONSTRAINT "ProductOption_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Barcode" ADD CONSTRAINT "Barcode_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickKey" ADD CONSTRAINT "QuickKey_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickKey" ADD CONSTRAINT "QuickKey_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickKey" ADD CONSTRAINT "QuickKey_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Modifier" ADD CONSTRAINT "Modifier_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ModifierGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductModifierGroup" ADD CONSTRAINT "ProductModifierGroup_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductModifierGroup" ADD CONSTRAINT "ProductModifierGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ModifierGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierItem" ADD CONSTRAINT "SupplierItem_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierItem" ADD CONSTRAINT "SupplierItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_goodsReceiptId_fkey" FOREIGN KEY ("goodsReceiptId") REFERENCES "GoodsReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_purchaseOrderLineId_fkey" FOREIGN KEY ("purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_goodsReceiptId_fkey" FOREIGN KEY ("goodsReceiptId") REFERENCES "GoodsReceipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "StockAdjustment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_stocktakeId_fkey" FOREIGN KEY ("stocktakeId") REFERENCES "Stocktake"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockAdjustment" ADD CONSTRAINT "StockAdjustment_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockAdjustment" ADD CONSTRAINT "StockAdjustment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stocktake" ADD CONSTRAINT "Stocktake_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stocktake" ADD CONSTRAINT "Stocktake_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stocktake" ADD CONSTRAINT "Stocktake_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stocktake" ADD CONSTRAINT "Stocktake_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StocktakeLine" ADD CONSTRAINT "StocktakeLine_stocktakeId_fkey" FOREIGN KEY ("stocktakeId") REFERENCES "Stocktake"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StocktakeLine" ADD CONSTRAINT "StocktakeLine_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyEntry" ADD CONSTRAINT "LoyaltyEntry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyEntry" ADD CONSTRAINT "LoyaltyEntry_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyEntry" ADD CONSTRAINT "LoyaltyEntry_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyEntry" ADD CONSTRAINT "LoyaltyEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreCreditEntry" ADD CONSTRAINT "StoreCreditEntry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreCreditEntry" ADD CONSTRAINT "StoreCreditEntry_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreCreditEntry" ADD CONSTRAINT "StoreCreditEntry_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreCreditEntry" ADD CONSTRAINT "StoreCreditEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCard" ADD CONSTRAINT "GiftCard_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCard" ADD CONSTRAINT "GiftCard_saleLineId_fkey" FOREIGN KEY ("saleLineId") REFERENCES "SaleLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCard" ADD CONSTRAINT "GiftCard_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCardEntry" ADD CONSTRAINT "GiftCardEntry_giftCardId_fkey" FOREIGN KEY ("giftCardId") REFERENCES "GiftCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCardEntry" ADD CONSTRAINT "GiftCardEntry_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCardEntry" ADD CONSTRAINT "GiftCardEntry_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCardEntry" ADD CONSTRAINT "GiftCardEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountProduct" ADD CONSTRAINT "DiscountProduct_discountId_fkey" FOREIGN KEY ("discountId") REFERENCES "Discount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountProduct" ADD CONSTRAINT "DiscountProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountCategory" ADD CONSTRAINT "DiscountCategory_discountId_fkey" FOREIGN KEY ("discountId") REFERENCES "Discount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountCategory" ADD CONSTRAINT "DiscountCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_registerId_fkey" FOREIGN KEY ("registerId") REFERENCES "Register"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZReport" ADD CONSTRAINT "ZReport_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZReport" ADD CONSTRAINT "ZReport_registerId_fkey" FOREIGN KEY ("registerId") REFERENCES "Register"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_registerId_fkey" FOREIGN KEY ("registerId") REFERENCES "Register"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_cashierId_fkey" FOREIGN KEY ("cashierId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_priceOverrideById_fkey" FOREIGN KEY ("priceOverrideById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleLineModifier" ADD CONSTRAINT "SaleLineModifier_saleLineId_fkey" FOREIGN KEY ("saleLineId") REFERENCES "SaleLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleLineModifier" ADD CONSTRAINT "SaleLineModifier_modifierId_fkey" FOREIGN KEY ("modifierId") REFERENCES "Modifier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleDiscount" ADD CONSTRAINT "SaleDiscount_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleDiscount" ADD CONSTRAINT "SaleDiscount_saleLineId_fkey" FOREIGN KEY ("saleLineId") REFERENCES "SaleLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleDiscount" ADD CONSTRAINT "SaleDiscount_discountId_fkey" FOREIGN KEY ("discountId") REFERENCES "Discount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleDiscount" ADD CONSTRAINT "SaleDiscount_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalePayment" ADD CONSTRAINT "SalePayment_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalePayment" ADD CONSTRAINT "SalePayment_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "PaymentIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalePayment" ADD CONSTRAINT "SalePayment_giftCardId_fkey" FOREIGN KEY ("giftCardId") REFERENCES "GiftCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleVoid" ADD CONSTRAINT "SaleVoid_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleVoid" ADD CONSTRAINT "SaleVoid_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleVoid" ADD CONSTRAINT "SaleVoid_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleVoid" ADD CONSTRAINT "SaleVoid_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_exchangeSaleId_fkey" FOREIGN KEY ("exchangeSaleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_registerId_fkey" FOREIGN KEY ("registerId") REFERENCES "Register"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_processedById_fkey" FOREIGN KEY ("processedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundLine" ADD CONSTRAINT "RefundLine_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundLine" ADD CONSTRAINT "RefundLine_saleLineId_fkey" FOREIGN KEY ("saleLineId") REFERENCES "SaleLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundPayment" ADD CONSTRAINT "RefundPayment_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundPayment" ADD CONSTRAINT "RefundPayment_originalPaymentId_fkey" FOREIGN KEY ("originalPaymentId") REFERENCES "SalePayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundPayment" ADD CONSTRAINT "RefundPayment_giftCardId_fkey" FOREIGN KEY ("giftCardId") REFERENCES "GiftCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalReceipt" ADD CONSTRAINT "FiscalReceipt_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalReceipt" ADD CONSTRAINT "FiscalReceipt_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptDelivery" ADD CONSTRAINT "ReceiptDelivery_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptDelivery" ADD CONSTRAINT "ReceiptDelivery_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningTable" ADD CONSTRAINT "DiningTable_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpenTicket" ADD CONSTRAINT "OpenTicket_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpenTicket" ADD CONSTRAINT "OpenTicket_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "DiningTable"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpenTicket" ADD CONSTRAINT "OpenTicket_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpenTicket" ADD CONSTRAINT "OpenTicket_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenTicket" ADD CONSTRAINT "KitchenTicket_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenTicket" ADD CONSTRAINT "KitchenTicket_openTicketId_fkey" FOREIGN KEY ("openTicketId") REFERENCES "OpenTicket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenTicket" ADD CONSTRAINT "KitchenTicket_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
