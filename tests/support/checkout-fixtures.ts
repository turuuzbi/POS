import { v7 as uuidv7 } from "uuid";
import { checkoutInputSchema, type CheckoutInputWire } from "@/domain/checkout-contract";
import type { CheckoutContext } from "@/server/services/checkout";
import { postStockMovements } from "@/server/services/stock";
import { db } from "./db";
import { createLocation, createProduct, createUser, pairDevice } from "./fixtures";

/** A till: location + register + cashier + manager + paired device + OPEN shift. */
export async function createTill(options: { withShift?: boolean } = {}) {
  const { location, register } = await createLocation();
  const cashier = await createUser({ role: "CASHIER", locationIds: [location.id] });
  const manager = await createUser({ role: "MANAGER", locationIds: [location.id] });
  const { device } = await pairDevice(location.id, manager.id, register.id);
  const shift =
    options.withShift === false
      ? null
      : await db.shift.create({
          data: {
            registerId: register.id,
            locationId: location.id,
            openedById: cashier.id,
            openingFloat: 5_000_000n,
          },
        });
  const ctx = (user: { id: string; role: "OWNER" | "MANAGER" | "CASHIER" } = cashier) =>
    ({
      user: { id: user.id, role: user.role, locationIds: [location.id] },
      device: { deviceId: device.id, locationId: location.id, registerId: register.id },
      meta: { ip: null, userAgent: null },
    }) satisfies CheckoutContext;
  return { location, register, cashier, manager, device, shift, ctx };
}

export type Till = Awaited<ReturnType<typeof createTill>>;

/** A stocked product at the till's location. */
export async function createStockedProduct(
  till: Till,
  options: Parameters<typeof createProduct>[0] & { stockMilli?: number } = {},
) {
  const { stockMilli = 100_000, ...productOptions } = options;
  const made = await createProduct(productOptions);
  if (stockMilli > 0 && made.product.trackStock && made.product.type === "STANDARD") {
    await db.$transaction((tx) =>
      postStockMovements(tx, {
        locationId: till.location.id,
        type: "OPENING",
        createdById: till.manager.id,
        lines: [{ variantId: made.variant.id, qtyDeltaMilli: stockMilli }],
      }),
    );
  }
  return made;
}

type Line = CheckoutInputWire["lines"][number];

/** Wire-shaped checkout input, parsed through the real schema (so defaults apply). */
export function buildInput(
  overrides: Partial<Omit<CheckoutInputWire, "lines" | "tenders">> & {
    lines: Line[];
    tenders: CheckoutInputWire["tenders"];
  },
) {
  return checkoutInputSchema.parse({
    saleId: uuidv7(),
    expectedPayable: "0",
    approvals: {},
    createdAtClient: new Date().toISOString(),
    ...overrides,
  });
}

export const lineOf = (variantId: string, qtyMilli = 1000, extra: Partial<Line> = {}): Line => ({
  lineId: uuidv7(),
  variantId,
  qtyMilli,
  discounts: [],
  ...extra,
});
