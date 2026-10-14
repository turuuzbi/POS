import "server-only";
import { createHash } from "node:crypto";
import type {
  FiscalIssueResult,
  FiscalProvider,
  FiscalReturnRequest,
  FiscalSaleRequest,
  FiscalStatusResult,
} from "./types";

/**
 * Deterministic eBarimt stand-in: ids, lottery codes and QR data derive from
 * the receipt number, so retries and tests are reproducible.
 * MOCK_EBARIMT_FAIL=1 makes every call fail (exercises the retry queue).
 *
 * TODO(ebarimt): replace with the real PosAPI adapter (see types.ts).
 */

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function failing(): boolean {
  return process.env.MOCK_EBARIMT_FAIL === "1";
}

export function createMockEbarimtProvider(): FiscalProvider {
  return {
    name: "mock",

    async issue(request: FiscalSaleRequest): Promise<FiscalIssueResult> {
      if (failing()) throw new Error("mock eBarimt: unavailable");
      const hash = digest(`sale:${request.receiptNumber}`);
      const lottery = `${hash.slice(0, 2).toUpperCase().replace(/[0-9]/g, "A")}${BigInt(
        `0x${hash.slice(2, 12)}`,
      )
        .toString()
        .padStart(8, "0")
        .slice(0, 8)}`;
      return {
        externalId: `MOCK-${hash.slice(0, 16).toUpperCase()}`,
        lotteryCode: lottery,
        qrData: `MOCKEBARIMT:${hash.slice(16, 48)}`,
        raw: { mock: true, receiptNumber: request.receiptNumber, total: request.total.toString() },
      };
    },

    async issueReturn(request: FiscalReturnRequest): Promise<FiscalIssueResult> {
      if (failing()) throw new Error("mock eBarimt: unavailable");
      const hash = digest(`return:${request.receiptNumber}`);
      return {
        externalId: `MOCK-R-${hash.slice(0, 14).toUpperCase()}`,
        raw: { mock: true, originalExternalId: request.originalExternalId },
      };
    },

    async status(externalId: string): Promise<FiscalStatusResult> {
      return { status: externalId.startsWith("MOCK-") ? "ISSUED" : "FAILED", raw: { mock: true } };
    },
  };
}
