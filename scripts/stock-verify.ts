/**
 * Check that every cached stock level equals its ledger (Σ movements), and
 * optionally rebuild drifted caches from the ledger.
 *
 *   pnpm stock:verify            # report; exits 1 on any mismatch
 *   pnpm stock:verify --rebuild  # fix the caches, then re-check
 */
import { config as loadDotenv } from "dotenv";
import { db } from "@/server/db";
import { findLedgerMismatches, rebuildStockLevels } from "@/server/services/stock";

loadDotenv({ quiet: true });

async function main() {
  let mismatches = await findLedgerMismatches(db);
  if (mismatches.length && process.argv.includes("--rebuild")) {
    const fixed = await rebuildStockLevels(db);
    console.warn(`Rebuilt ${fixed} stock level(s) from the ledger.`);
    mismatches = await findLedgerMismatches(db);
  }
  for (const m of mismatches) {
    console.error(
      `variant ${m.variantId} @ location ${m.locationId}: cached ${m.cachedMilli}, ` +
        `ledger ${m.ledgerMilli}, last balance ${m.lastBalanceMilli ?? "—"} (milli-units)`,
    );
  }
  if (mismatches.length) {
    console.error(`${mismatches.length} stock level(s) disagree with the ledger.`);
    process.exitCode = 1;
  } else {
    console.warn("Stock levels match the ledger.");
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
