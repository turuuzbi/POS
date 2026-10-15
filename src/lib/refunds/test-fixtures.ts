/** Shared fixtures for the refund UI helpers' tests. Not imported by app code. */
import type { ReturnSale } from "./sale-wire";

export const IDS = {
  sale: "01900000-0000-7000-8000-000000000001",
  shift: "01900000-0000-7000-8000-0000000000a1",
  otherShift: "01900000-0000-7000-8000-0000000000a2",
  milk: "01900000-0000-7000-8000-000000000011",
  apples: "01900000-0000-7000-8000-000000000012",
  book: "01900000-0000-7000-8000-000000000013",
  card: "01900000-0000-7000-8000-000000000021",
  cash: "01900000-0000-7000-8000-000000000022",
  refund: "01900000-0000-7000-8000-000000000031",
  newRefund: "01900000-0000-7000-8000-000000000032",
  exchangeSale: "01900000-0000-7000-8000-000000000041",
  location: "01900000-0000-7000-8000-0000000000b1",
  register: "01900000-0000-7000-8000-0000000000b2",
  variant: "01900000-0000-7000-8000-0000000000c1",
};

/**
 * A realistic sale (money in möngö): 2 milk (VAT inclusive), 1.5 kg apples
 * (weighed), 1 book (VAT exempt, untracked). Items 1 850 150 + rounding 50 =
 * 1 850 200, paid CARD 1 000 000 + CASH 850 200.
 */
export function makeSale(overrides: Partial<ReturnSale> = {}): ReturnSale {
  const base: ReturnSale = {
    id: IDS.sale,
    number: "UB1-000123",
    occurredAt: "2026-10-14T10:00:00.000Z",
    locationId: IDS.location,
    registerId: IDS.register,
    shiftId: IDS.shift,
    cashierName: "Болор",
    totalAmount: 1_850_200n,
    itemsAmount: 1_850_150n,
    tipAmount: 0n,
    roundingAmount: 50n,
    vatAmount: 145_454n,
    status: "COMPLETED",
    voided: null,
    lines: [
      {
        id: IDS.milk,
        lineNo: 1,
        name: "Сүү 1л",
        sku: "MILK-1",
        variantId: IDS.variant,
        unit: "PIECE",
        qtyMilli: 2000,
        unitPrice: 500_000n,
        totalAmount: 1_000_000n,
        netAmount: 909_091n,
        vatAmount: 90_909n,
        cityTaxAmount: 0n,
        pricesIncludeTax: true,
        tracksStock: true,
        isGiftCard: false,
      },
      {
        id: IDS.apples,
        lineNo: 2,
        name: "Алим",
        sku: null,
        variantId: IDS.variant,
        unit: "KG",
        qtyMilli: 1500,
        unitPrice: 400_000n,
        totalAmount: 600_000n,
        netAmount: 545_455n,
        vatAmount: 54_545n,
        cityTaxAmount: 0n,
        pricesIncludeTax: true,
        tracksStock: true,
        isGiftCard: false,
      },
      {
        id: IDS.book,
        lineNo: 3,
        name: "Ном",
        sku: null,
        variantId: IDS.variant,
        unit: "PIECE",
        qtyMilli: 1000,
        unitPrice: 250_150n,
        totalAmount: 250_150n,
        netAmount: 250_150n,
        vatAmount: 0n,
        cityTaxAmount: 0n,
        pricesIncludeTax: true,
        tracksStock: false,
        isGiftCard: false,
      },
    ],
    payments: [
      {
        id: IDS.card,
        method: "CARD",
        amount: 1_000_000n,
        change: 0n,
        reference: null,
        cardLast4: "4242",
      },
      {
        id: IDS.cash,
        method: "CASH",
        amount: 850_200n,
        change: 149_800n,
        reference: null,
        cardLast4: null,
      },
    ],
    refunds: [],
  };
  return { ...base, ...overrides };
}
