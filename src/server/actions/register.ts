"use server";

import { z } from "zod";
import type { CatalogEntry } from "@/lib/pos/catalog-entry";
import { findActiveDevice, readDeviceToken } from "../auth/device";
import { db } from "../db";
import {
  browseEntries,
  loadEntries,
  lookupCode,
  searchEntries,
  type CodeLookup,
} from "../queries/register";
import { defineAction } from "./define-action";

/** Stock is shown for the location of the device the cashier is on. */
async function deviceLocationId(): Promise<string | null> {
  const device = await findActiveDevice(db, await readDeviceToken());
  return device?.locationId ?? null;
}

/** Search-as-you-type for the register: name, SKU, barcode, PLU. */
export const searchCatalogAction = defineAction({
  name: "register.search",
  access: "pos.sell",
  input: z.object({ query: z.string().trim().min(1).max(100) }),
  async run({ input }): Promise<CatalogEntry[]> {
    return searchEntries(input.query, await deviceLocationId());
  },
});

/** Exact scan/typed-code lookup (barcode, SKU, PLU, scale label). */
export const lookupCodeAction = defineAction({
  name: "register.lookupCode",
  access: "pos.sell",
  input: z.object({ code: z.string().trim().min(1).max(100) }),
  async run({ input }): Promise<CodeLookup> {
    return lookupCode(input.code, await deviceLocationId());
  },
});

/** Browse grid fallback: one category (with its children) or everything. */
export const browseCatalogAction = defineAction({
  name: "register.browse",
  access: "pos.sell",
  input: z.object({ categoryId: z.uuid().nullable() }),
  async run({ input }): Promise<CatalogEntry[]> {
    return browseEntries(input.categoryId, await deviceLocationId());
  },
});

/** Current prices/tax for cart lines (STALE_PRICE recovery, resuming a held cart). */
export const refreshEntriesAction = defineAction({
  name: "register.refresh",
  access: "pos.sell",
  input: z.object({ variantIds: z.array(z.uuid()).min(1).max(200) }),
  async run({ input }): Promise<CatalogEntry[]> {
    return loadEntries(input.variantIds, await deviceLocationId());
  },
});
