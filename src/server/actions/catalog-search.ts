"use server";

import { z } from "zod";
import { can } from "@/domain/access";
import { assertCan, defineAction } from "./define-action";
import { searchVariants } from "../queries/catalog";

/** Variant search for pickers (adjustments, purchase orders, stocktakes, …). */
export const findVariants = defineAction({
  name: "catalog.findVariants",
  access: "catalog.view",
  input: z.object({
    query: z.string().max(100),
    locationId: z.uuid().nullish(),
    stockOnly: z.boolean().optional(),
  }),
  async run({ input, user }) {
    if (input.locationId) assertCan(user, "inventory.view", input.locationId);
    const hits = await searchVariants(input.query, {
      locationId: input.locationId ?? null,
      stockOnly: input.stockOnly,
      limit: 15,
    });
    // Cost prices are for those who may see margins.
    const showCost = can(user, "reports.view_costs");
    return hits.map((hit) => ({ ...hit, cost: showCost ? hit.cost : null }));
  },
});
