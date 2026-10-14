-- Stocktake lines are created at the start of a count with the expected
-- on-hand snapshot; countedMilli stays NULL until the item is counted.
-- varianceMilli is the delta actually posted at finalization.
ALTER TABLE "StocktakeLine" ALTER COLUMN "countedMilli" DROP NOT NULL;
ALTER TABLE "StocktakeLine" ADD COLUMN "varianceMilli" INTEGER;
