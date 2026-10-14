"use server";

import { z } from "zod";
import type { CatalogEntry } from "@/lib/pos/catalog-entry";
import type { CurrentUser } from "../auth/session";
import {
  browseEntries,
  loadEntries,
  lookupCode,
  searchEntries,
  type CodeLookup,
} from "../queries/register";
import { requireRegisterContext } from "../services/register-context";
import { defineAction } from "./define-action";

/**
 * Stock is shown for the location of the device the cashier is on. The device
 * goes through the same checks as checkout (paired, has a register, the user
 * may act at its location, and for a PIN session it is the device the session
 * was opened on), so a user never reads another location's stock.
 */
async function deviceLocationId(
  user: Pick<CurrentUser, "deviceId" | "role" | "locationIds">,
): Promise<string> {
  return (await requireRegisterContext(user)).locationId;
}

/** Search-as-you-type for the register: name, SKU, barcode, PLU. */
export const searchCatalogAction = defineAction({
  name: "register.search",
  access: "pos.sell",
  input: z.object({ query: z.string().trim().min(1).max(100) }),
  async run({ input, user }): Promise<CatalogEntry[]> {
    return searchEntries(input.query, await deviceLocationId(user));
  },
});

/** Exact scan/typed-code lookup (barcode, SKU, PLU, scale label). */
export const lookupCodeAction = defineAction({
  name: "register.lookupCode",
  access: "pos.sell",
  input: z.object({ code: z.string().trim().min(1).max(100) }),
  async run({ input, user }): Promise<CodeLookup> {
    return lookupCode(input.code, await deviceLocationId(user));
  },
});

/** Browse grid fallback: one category (with its children) or everything. */
export const browseCatalogAction = defineAction({
  name: "register.browse",
  access: "pos.sell",
  input: z.object({ categoryId: z.uuid().nullable() }),
  async run({ input, user }): Promise<CatalogEntry[]> {
    return browseEntries(input.categoryId, await deviceLocationId(user));
  },
});

/** Current prices/tax for cart lines (STALE_PRICE recovery, resuming a held cart). */
export const refreshEntriesAction = defineAction({
  name: "register.refresh",
  access: "pos.sell",
  input: z.object({ variantIds: z.array(z.uuid()).min(1).max(200) }),
  async run({ input, user }): Promise<CatalogEntry[]> {
    return loadEntries(input.variantIds, await deviceLocationId(user));
  },
});
