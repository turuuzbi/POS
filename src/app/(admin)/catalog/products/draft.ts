import type { PRODUCT_TYPES } from "@/domain/catalog";
import { formatMoney } from "@/domain/money";
import type { Unit } from "@/domain/qty";

/** Form state of one variant. Money fields are text as typed ("12,500"). */
export interface VariantDraft {
  /** Existing variant id; absent for new rows. */
  id?: string;
  option1: string;
  option2: string;
  option3: string;
  name: string;
  sku: string;
  pluCode: string;
  price: string;
  /** Opening cost as typed; new variants only. */
  cost: string;
  /** Current cost in möngö (read-only), existing variants only. */
  currentCost?: string;
  barcodes: string[];
  isActive: boolean;
  onHandMilli?: number;
}

export interface ProductDraft {
  id?: string;
  imageUrl: string | null;
  name: string;
  description: string;
  type: (typeof PRODUCT_TYPES)[number];
  unit: Unit;
  categoryId: string;
  taxClassId: string;
  pricesIncludeTax: boolean;
  trackStock: boolean;
  taxClassificationCode: string;
  isActive: boolean;
  options: { name: string; valuesText: string }[];
  variants: VariantDraft[];
}

export function blankVariant(values: Partial<VariantDraft> = {}): VariantDraft {
  return {
    option1: "",
    option2: "",
    option3: "",
    name: "",
    sku: "",
    pluCode: "",
    price: "",
    cost: "",
    barcodes: [],
    isActive: true,
    ...values,
  };
}

export function newProductDraft(defaultTaxClassId: string): ProductDraft {
  return {
    imageUrl: null,
    name: "",
    description: "",
    type: "STANDARD",
    unit: "PIECE",
    categoryId: "",
    taxClassId: defaultTaxClassId,
    pricesIncludeTax: true,
    trackStock: true,
    taxClassificationCode: "",
    isActive: true,
    options: [],
    variants: [blankVariant()],
  };
}

interface StoredProduct {
  id: string;
  imageUrl: string | null;
  name: string;
  description: string | null;
  type: ProductDraft["type"];
  unit: Unit;
  categoryId: string | null;
  taxClassId: string;
  pricesIncludeTax: boolean;
  trackStock: boolean;
  taxClassificationCode: string | null;
  isActive: boolean;
  options: { name: string; values: string[] }[];
  variants: {
    id: string;
    name: string | null;
    sku: string | null;
    pluCode: string | null;
    option1: string | null;
    option2: string | null;
    option3: string | null;
    price: bigint;
    cost: bigint;
    isActive: boolean;
    barcodes: { code: string }[];
  }[];
}

/** Money for a text field: grouped with "," so parseMoney reads it back. */
const moneyText = (amount: bigint) => formatMoney(amount, { locale: "en", symbol: false });

export function draftFromProduct(
  product: StoredProduct,
  onHand: Record<string, number>,
): ProductDraft {
  return {
    id: product.id,
    imageUrl: product.imageUrl,
    name: product.name,
    description: product.description ?? "",
    type: product.type,
    unit: product.unit,
    categoryId: product.categoryId ?? "",
    taxClassId: product.taxClassId,
    pricesIncludeTax: product.pricesIncludeTax,
    trackStock: product.trackStock,
    taxClassificationCode: product.taxClassificationCode ?? "",
    isActive: product.isActive,
    options: product.options.map((o) => ({ name: o.name, valuesText: o.values.join(", ") })),
    variants: product.variants.map((v) => ({
      id: v.id,
      option1: v.option1 ?? "",
      option2: v.option2 ?? "",
      option3: v.option3 ?? "",
      name: v.name ?? "",
      sku: v.sku ?? "",
      pluCode: v.pluCode ?? "",
      price: moneyText(v.price),
      cost: "",
      currentCost: v.cost.toString(),
      barcodes: v.barcodes.map((b) => b.code),
      isActive: v.isActive,
      onHandMilli: onHand[v.id] ?? 0,
    })),
  };
}
