import { describe, expect, it } from "vitest";
import { normaliseSearch, parseReceiptInput } from "./receipt-input";

describe("parseReceiptInput", () => {
  it("accepts receipt numbers however they are typed or scanned", () => {
    expect(parseReceiptInput("UB1-000123")).toEqual({ kind: "number", number: "UB1-000123" });
    expect(parseReceiptInput("  ub1-000123\n")).toEqual({ kind: "number", number: "UB1-000123" });
    expect(parseReceiptInput("UB1 - 000123")).toEqual({ kind: "number", number: "UB1-000123" });
    expect(parseReceiptInput("UB1–000123")).toEqual({ kind: "number", number: "UB1-000123" });
  });

  it("reads the token out of a receipt link or QR text", () => {
    const token = "A".repeat(43);
    expect(parseReceiptInput(`https://pos.example/receipt/${token}`)).toEqual({
      kind: "token",
      token,
    });
    expect(parseReceiptInput(`https://pos.example/receipt/${token}?x=1#y`)).toEqual({
      kind: "token",
      token,
    });
  });

  it("reads the real share link the receipts print: /r/<token>", () => {
    const token = "Zk3_-9aB".repeat(5) + "abc"; // 43 base64url chars, like randomToken(32)
    expect(token).toHaveLength(43);
    expect(parseReceiptInput(`https://pos.example/r/${token}`)).toEqual({ kind: "token", token });
    expect(parseReceiptInput(`http://localhost:3000/r/${token}?utm=x#y`)).toEqual({
      kind: "token",
      token,
    });
    expect(parseReceiptInput(`pos.example/r/${token}`)).toEqual({ kind: "token", token });
    expect(parseReceiptInput("https://pos.example/r/short")).toBeNull();
  });

  it("recognises credit-note and void-slip links (resolved to the sale on the server)", () => {
    const signed = `${"A".repeat(22)}.${"b".repeat(43)}`;
    expect(parseReceiptInput(`https://pos.example/r/refund/${signed}`)).toEqual({
      kind: "credit",
      type: "refund",
      token: signed,
    });
    expect(parseReceiptInput(`https://pos.example/r/void/${signed}?x=1`)).toEqual({
      kind: "credit",
      type: "void",
      token: signed,
    });
    expect(parseReceiptInput(`https://pos.example/r/refund/${"A".repeat(43)}`)).toBeNull();
    // The staff route of a credit note names a REFUND id, not a sale id.
    const id = "01900000-0000-7000-8000-000000000001";
    expect(parseReceiptInput(`https://pos.example/receipt/refund/${id}`)).toEqual({
      kind: "refundId",
      id,
    });
    expect(parseReceiptInput("https://pos.example/receipt/refund/nope")).toBeNull();
  });

  it("accepts a bare sale id and a sale id inside a link", () => {
    const id = "01900000-0000-7000-8000-000000000001";
    expect(parseReceiptInput(id.toUpperCase())).toEqual({ kind: "id", id });
    expect(parseReceiptInput(`https://pos.example/receipt/${id}`)).toEqual({ kind: "id", id });
  });

  it("rejects text that cannot be a receipt", () => {
    expect(parseReceiptInput("")).toBeNull();
    expect(parseReceiptInput("hello world")).toBeNull();
    expect(parseReceiptInput("12345")).toBeNull();
    expect(parseReceiptInput("https://pos.example/other")).toBeNull();
    expect(parseReceiptInput("x".repeat(400))).toBeNull();
    expect(parseReceiptInput("UB1-000123'; DROP TABLE")).toBeNull();
  });
});

describe("normaliseSearch", () => {
  it("drops spaces, upper-cases and bounds the length", () => {
    expect(normaliseSearch(" ub1 -0001 ")).toBe("UB1-0001");
    expect(normaliseSearch("a".repeat(100))).toHaveLength(40);
  });
});
