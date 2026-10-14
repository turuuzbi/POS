import type { Role } from "@/domain/permissions";
import { createDevice } from "@/server/auth/device";
import { hashPassword } from "@/server/auth/password";
import { pinLookup } from "@/server/auth/pin";
import { db } from "@/server/db";

let counter = 0;
const next = () => ++counter;

export async function createLocation(overrides: { name?: string; isActive?: boolean } = {}) {
  const n = next();
  const location = await db.location.create({
    data: {
      code: `L${n}`,
      name: overrides.name ?? `Location ${n}`,
      isActive: overrides.isActive ?? true,
    },
  });
  const register = await db.register.create({
    data: { locationId: location.id, code: "R1", name: `Register ${n}` },
  });
  return { location, register };
}

export async function createUser(options: {
  role: Role;
  email?: string;
  password?: string;
  pin?: string;
  locationIds?: string[];
  isActive?: boolean;
}) {
  return db.user.create({
    data: {
      name: `${options.role.toLowerCase()} ${next()}`,
      role: options.role,
      email: options.email ?? null,
      passwordHash: options.password ? await hashPassword(options.password) : null,
      pinLookup: options.pin ? pinLookup(options.pin) : null,
      isActive: options.isActive ?? true,
      locations: { create: (options.locationIds ?? []).map((locationId) => ({ locationId })) },
    },
  });
}

export async function pairDevice(
  locationId: string,
  pairedById: string,
  registerId: string | null = null,
) {
  return createDevice(db, { locationId, registerId, name: `Device ${next()}`, pairedById });
}

export async function createTaxClass(overrides: { name?: string; vatRateBps?: number } = {}) {
  return db.taxClass.create({
    data: { name: overrides.name ?? `VAT ${next()}`, vatRateBps: overrides.vatRateBps ?? 1000 },
  });
}

/** A single-variant product (STANDARD, stock-tracked unless told otherwise). */
export async function createProduct(
  options: {
    name?: string;
    unit?: "PIECE" | "KG" | "LITER" | "METER";
    type?: "STANDARD" | "SERVICE" | "GIFT_CARD";
    trackStock?: boolean;
    price?: bigint;
    cost?: bigint;
    sku?: string;
    taxClassId?: string;
  } = {},
) {
  const n = next();
  const taxClassId = options.taxClassId ?? (await createTaxClass()).id;
  const product = await db.product.create({
    data: {
      name: options.name ?? `Product ${n}`,
      unit: options.unit ?? "PIECE",
      type: options.type ?? "STANDARD",
      trackStock: options.trackStock ?? true,
      taxClassId,
      variants: {
        create: {
          sku: options.sku ?? `SKU-${n}`,
          price: options.price ?? 100_000n,
          cost: options.cost ?? 0n,
        },
      },
    },
    include: { variants: true },
  });
  return { product, variant: product.variants[0]! };
}
