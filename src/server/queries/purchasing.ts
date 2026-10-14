import "server-only";
import { variantLabel } from "@/domain/catalog";
import { orderTotal, type PurchaseOrderStatus } from "@/domain/purchasing";
import type { CurrentUser } from "../auth/session";
import { db } from "../db";

/** Restrict a `locationId` column to what this user may see. */
function locationScope(user: Pick<CurrentUser, "locationIds">) {
  return user.locationIds === "ALL" ? {} : { locationId: { in: [...user.locationIds] } };
}

const variantSelect = {
  id: true,
  name: true,
  option1: true,
  option2: true,
  option3: true,
  sku: true,
  product: { select: { name: true, unit: true } },
} as const;

type VariantRow = {
  name: string | null;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  product: { name: string };
};

const labelOf = (v: VariantRow) => variantLabel(v.product.name, v);

export function listSuppliers(options: { includeInactive?: boolean } = {}) {
  return db.supplier.findMany({
    where: options.includeInactive ? {} : { isActive: true },
    orderBy: { name: "asc" },
    include: { _count: { select: { items: true, purchaseOrders: true, goodsReceipts: true } } },
  });
}

export async function getSupplier(id: string) {
  const supplier = await db.supplier.findUnique({
    where: { id },
    include: {
      items: {
        include: { variant: { select: variantSelect } },
        orderBy: { variant: { sku: "asc" } },
      },
    },
  });
  if (!supplier) return null;
  return {
    ...supplier,
    items: supplier.items.map(({ variant, ...item }) => ({
      ...item,
      label: labelOf(variant),
      sku: variant.sku,
    })),
  };
}

export async function listPurchaseOrders(
  user: CurrentUser,
  filter: { status?: PurchaseOrderStatus; supplierId?: string } = {},
) {
  const rows = await db.purchaseOrder.findMany({
    where: { ...locationScope(user), status: filter.status, supplierId: filter.supplierId },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      supplier: { select: { name: true } },
      location: { select: { name: true } },
      lines: { select: { qtyOrderedMilli: true, unitCost: true } },
    },
  });
  return rows.map(({ lines, ...row }) => ({
    ...row,
    lineCount: lines.length,
    total: orderTotal(lines.map((l) => ({ qtyMilli: l.qtyOrderedMilli, unitCost: l.unitCost }))),
  }));
}

export async function getPurchaseOrder(user: CurrentUser, id: string) {
  const order = await db.purchaseOrder.findFirst({
    where: { id, ...locationScope(user) },
    include: {
      supplier: true,
      location: { select: { id: true, name: true } },
      createdBy: { select: { name: true } },
      lines: { include: { variant: { select: variantSelect } }, orderBy: { id: "asc" } },
      receipts: {
        orderBy: { receivedAt: "desc" },
        select: { id: true, number: true, receivedAt: true },
      },
    },
  });
  if (!order) return null;
  const lines = order.lines.map(({ variant, ...line }) => ({
    ...line,
    label: labelOf(variant),
    sku: variant.sku,
    unit: variant.product.unit,
  }));
  return {
    ...order,
    lines,
    total: orderTotal(lines.map((l) => ({ qtyMilli: l.qtyOrderedMilli, unitCost: l.unitCost }))),
  };
}

/** Orders that can still take a receipt (for the receiving screen). */
export function listReceivableOrders(user: CurrentUser) {
  return db.purchaseOrder.findMany({
    where: { ...locationScope(user), status: { in: ["ORDERED", "PARTIALLY_RECEIVED"] } },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      number: true,
      status: true,
      supplier: { select: { name: true } },
      location: { select: { name: true } },
    },
  });
}

export function listReceipts(user: CurrentUser) {
  return db.goodsReceipt.findMany({
    where: locationScope(user),
    orderBy: { receivedAt: "desc" },
    take: 200,
    include: {
      supplier: { select: { name: true } },
      location: { select: { name: true } },
      purchaseOrder: { select: { id: true, number: true } },
      receivedBy: { select: { name: true } },
      _count: { select: { lines: true } },
    },
  });
}

export async function getReceipt(user: CurrentUser, id: string) {
  const receipt = await db.goodsReceipt.findFirst({
    where: { id, ...locationScope(user) },
    include: {
      supplier: { select: { id: true, name: true } },
      location: { select: { name: true } },
      purchaseOrder: { select: { id: true, number: true } },
      receivedBy: { select: { name: true } },
      lines: { include: { variant: { select: variantSelect } }, orderBy: { id: "asc" } },
    },
  });
  if (!receipt) return null;
  const lines = receipt.lines.map(({ variant, ...line }) => ({
    ...line,
    label: labelOf(variant),
    sku: variant.sku,
    unit: variant.product.unit,
  }));
  return {
    ...receipt,
    lines,
    total: orderTotal(lines.map((l) => ({ qtyMilli: l.qtyMilli, unitCost: l.unitCost }))),
  };
}
