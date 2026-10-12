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
