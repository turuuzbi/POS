"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { MAX_IMPORT_BYTES } from "@/domain/csv-catalog";
import { can } from "../auth/session";
import { db } from "../db";
import { commitCatalogImport, planCatalogImport, toPreview } from "../services/catalog-import";
import { defineAction } from "./define-action";

// UTF-16 length never exceeds the UTF-8 byte length; the parser enforces the
// exact byte limit.
const csvInput = z.object({ csv: z.string().max(MAX_IMPORT_BYTES + 1) });

/** Dry run: parse, validate and match the file without writing anything. */
export const previewCatalogImportAction = defineAction({
  name: "catalogImport.preview",
  access: "catalog.edit",
  input: csvInput,
  async run({ input, user }) {
    const plan = await planCatalogImport(db, input.csv, {
      allowCost: can(user, "reports.view_costs"),
    });
    return toPreview(plan, plan.rowCount);
  },
});

/** Apply the file in one transaction; nothing is written if any row is invalid. */
export const commitCatalogImportAction = defineAction({
  name: "catalogImport.commit",
  access: "catalog.edit",
  input: csvInput,
  async run({ input, user, meta }) {
    const allowCost = can(user, "reports.view_costs");
    const outcome = await db.$transaction(
      (tx) => commitCatalogImport(tx, input.csv, user, { allowCost }, meta),
      { timeout: 120_000, maxWait: 10_000 },
    );
    if (outcome.committed) revalidatePath("/catalog", "layout");
    return outcome;
  },
});
