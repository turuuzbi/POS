import { randomBytes } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { withE2eDb } from "../db";
import { enterPin, mn, SEED, signInWithPassword, signOut } from "../fixtures";

/** Fill `{name}`-style placeholders of a message template. */
export function msg(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`));
}

export function ean13CheckDigit(first12: string): number {
  const sum = [...first12].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10;
}

/** The seed's demo EAN-13 for item number `n` (prisma/seed.ts demoEan13). */
export function seedEan(n: number): string {
  const first12 = `8650001${String(n).padStart(5, "0")}`;
  return first12 + ean13CheckDigit(first12);
}

/** A weight-embedded scale label: prefix 20, 5-digit PLU, grams. */
export function scaleLabel(plu: string, grams: number): string {
  const first12 = `20${plu.padStart(5, "0")}${String(grams).padStart(5, "0")}`;
  return first12 + ean13CheckDigit(first12);
}

export interface RegisterSession {
  deviceName: string;
  registerId: string;
  locationId: string;
  cashierId: string;
}

/**
 * Pair a fresh tablet as the manager, sign in as the seed cashier on it and
 * (optionally) make sure that register has an OPEN shift. Shifts are inserted
 * straight into the database: the register UI under test only reads them.
 */
export async function startRegister(
  page: Page,
  { shift }: { shift: boolean },
): Promise<RegisterSession> {
  const deviceName = `E2E register ${randomBytes(3).toString("hex")}`;
  await signInWithPassword(page, SEED.manager.email);
  await page.goto("/settings/devices");
  await page.getByLabel(mn.devices.name).fill(deviceName);
  await page.getByRole("button", { name: mn.devices.pair }).click();
  await expect(page.getByText(mn.devices.paired)).toBeVisible();
  await signOut(page, SEED.manager.name, mn.auth.signOut);
  await enterPin(page, SEED.cashier.pin);
  await expect(page).toHaveURL(/\/register$/);

  let session: RegisterSession | undefined;
  await withE2eDb(async (db) => {
    const device = await db.query(
      `SELECT "registerId", "locationId" FROM "Device" WHERE "name" = $1`,
      [deviceName],
    );
    const cashier = await db.query(
      `SELECT id FROM "User" WHERE "name" = $1 AND "role" = 'CASHIER'`,
      [SEED.cashier.name],
    );
    session = {
      deviceName,
      registerId: device.rows[0].registerId,
      locationId: device.rows[0].locationId,
      cashierId: cashier.rows[0].id,
    };
    await closeShifts(db, session.registerId);
    if (shift) {
      await db.query(
        `INSERT INTO "Shift" ("id", "registerId", "locationId", "status", "openedById", "openingFloat")
         VALUES (gen_random_uuid(), $1, $2, 'OPEN', $3, 5000000)`,
        [session.registerId, session.locationId, session.cashierId],
      );
    }
  });
  if (!session) throw new Error("register e2e needs a database (DATABASE_URL / E2E_DATABASE_URL)");
  await page.goto("/register");
  return session;
}

type Query = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

async function closeShifts(db: Query, registerId: string) {
  await db.query(
    `UPDATE "Shift" SET "status" = 'CLOSED', "closedAt" = now() WHERE "registerId" = $1 AND "status" = 'OPEN'`,
    [registerId],
  );
}

/** Leave no OPEN shift behind for other specs. */
export async function endRegister(session: RegisterSession | undefined) {
  if (!session) return;
  await withE2eDb((db) => closeShifts(db, session.registerId));
}

/** Add a product the way a cashier does: type the SKU/barcode in search and press Enter. */
export async function addByCode(page: Page, code: string) {
  const search = page.getByRole("combobox", { name: mn.pos.search.label });
  await search.fill(code);
  await search.press("Enter");
}

export const cartLines = (page: Page) => page.getByTestId("cart-line");

/**
 * Give the location quick keys for the named products (all locations, no
 * category = the favourites tab). Returns a cleanup that removes exactly them.
 */
export async function addQuickKeys(
  products: { name: string; color?: string }[],
): Promise<() => Promise<void>> {
  const ids: string[] = [];
  await withE2eDb(async (db) => {
    let position = 0;
    for (const product of products) {
      const found = (await db.query(`SELECT id FROM "Product" WHERE "name" = $1 LIMIT 1`, [
        product.name,
      ])) as { rows: { id: string }[] };
      const created = (await db.query(
        `INSERT INTO "QuickKey" ("id", "productId", "position", "color")
         VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`,
        [found.rows[0]!.id, position++, product.color ?? null],
      )) as { rows: { id: string }[] };
      ids.push(created.rows[0]!.id);
    }
  });
  return () =>
    withE2eDb(async (db) => {
      await db.query(`DELETE FROM "QuickKey" WHERE id = ANY($1::uuid[])`, [ids]);
    });
}
