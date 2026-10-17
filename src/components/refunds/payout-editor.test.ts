import { describe, expect, it } from "vitest";
import { initialPayoutText } from "./payout-editor";

describe("initialPayoutText", () => {
  it("restores the per-method text of a stored custom split after a remount", () => {
    expect(
      initialPayoutText({
        kind: "CUSTOM",
        entries: [
          { method: "CASH", amount: 12_345n },
          { method: "BANK_TRANSFER", amount: 500_000n },
        ],
      }),
    ).toEqual({ CASH: "123.45", CARD: "", QPAY: "", BANK_TRANSFER: "5000" });
  });

  it("starts empty for every other choice", () => {
    const empty = { CASH: "", CARD: "", QPAY: "", BANK_TRANSFER: "" };
    expect(initialPayoutText({ kind: "ORIGINAL" })).toEqual(empty);
    expect(initialPayoutText({ kind: "METHOD", method: "CASH" })).toEqual(empty);
  });
});
