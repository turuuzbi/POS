-- DropIndex
DROP INDEX "Shift_one_open_per_register";

-- Throttle buckets are transient and their key scheme changed (email-keyed,
-- /64-grouped sources), so existing buckets are simply discarded.
DELETE FROM "AuthThrottle";

-- AlterTable
ALTER TABLE "AuthThrottle" ADD COLUMN     "windowStart" TIMESTAMP(3) NOT NULL;

-- CreateTable
CREATE TABLE "TrustedSignInSource" (
    "key" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrustedSignInSource_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "TrustedSignInSource_lastSeenAt_idx" ON "TrustedSignInSource"("lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "Shift_one_open_per_register" ON "Shift"("registerId", "status") WHERE (status = 'OPEN');
