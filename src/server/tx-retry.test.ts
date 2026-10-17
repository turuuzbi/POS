import { describe, expect, it } from "vitest";
import { isRetryableTxError, withTxRetry } from "./tx-retry";

describe("tx retry", () => {
  it("recognises deadlock / serialisation failures in any shape", () => {
    expect(isRetryableTxError({ code: "P2034" })).toBe(true);
    expect(isRetryableTxError({ code: "40P01" })).toBe(true);
    expect(isRetryableTxError(new Error("deadlock detected"))).toBe(true);
    expect(isRetryableTxError({ message: "x", cause: { code: "40001" } })).toBe(true);
    expect(isRetryableTxError({ code: "P2002" })).toBe(false);
    expect(isRetryableTxError(new Error("boom"))).toBe(false);
    expect(isRetryableTxError(null)).toBe(false);
  });

  it("re-runs a deadlock victim, at most `attempts` times, and rethrows anything else", async () => {
    let calls = 0;
    expect(
      await withTxRetry(async () => {
        if (++calls < 3) throw { code: "40P01" };
        return "ok";
      }),
    ).toBe("ok");
    calls = 0;
    await expect(
      withTxRetry(async () => {
        calls++;
        throw { code: "P2034" };
      }),
    ).rejects.toEqual({ code: "P2034" });
    expect(calls).toBe(3);
    calls = 0;
    await expect(
      withTxRetry(async () => {
        calls++;
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(calls).toBe(1);
  });
});
