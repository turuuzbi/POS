import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  creditNoteToken,
  isPlausibleCreditNoteToken,
  verifyCreditNoteToken,
} from "./credit-note-token";

describe("credit note tokens", () => {
  const id = randomUUID();

  it("round-trips an id for its own kind", () => {
    const token = creditNoteToken("refund", id)!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(isPlausibleCreditNoteToken(token)).toBe(true);
    expect(verifyCreditNoteToken("refund", token)).toBe(id);
    expect(verifyCreditNoteToken("void", creditNoteToken("void", id)!)).toBe(id);
  });

  it("is deterministic (nothing to store) but differs per id", () => {
    expect(creditNoteToken("refund", id)).toBe(creditNoteToken("refund", id));
    expect(creditNoteToken("refund", id)).not.toBe(creditNoteToken("refund", randomUUID()));
  });

  it("does not open a token of the other kind", () => {
    expect(verifyCreditNoteToken("void", creditNoteToken("refund", id)!)).toBeNull();
    expect(verifyCreditNoteToken("refund", creditNoteToken("void", id)!)).toBeNull();
  });

  it("rejects a tampered signature or id", () => {
    const token = creditNoteToken("refund", id)!;
    const [idPart, sig] = token.split(".") as [string, string];
    const flip = (s: string, i: number) =>
      s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
    expect(verifyCreditNoteToken("refund", `${idPart}.${flip(sig, 0)}`)).toBeNull();
    expect(verifyCreditNoteToken("refund", `${idPart}.${flip(sig, 42)}`)).toBeNull();
    // Another valid id with this signature.
    const other = creditNoteToken("refund", randomUUID())!.split(".")[0]!;
    expect(verifyCreditNoteToken("refund", `${other}.${sig}`)).toBeNull();
    // Non-canonical base64url of the same bytes (trailing bits) must not alias.
    expect(verifyCreditNoteToken("refund", `${flip(idPart, 21)}.${sig}`)).toBeNull();
  });

  it("rejects malformed tokens without throwing", () => {
    const token = creditNoteToken("refund", id)!;
    for (const bad of [
      "",
      ".",
      "abc",
      token.slice(0, -1),
      `${token}x`,
      token.replace(".", ""),
      `${token}.${token}`,
      "A".repeat(22) + "." + "A".repeat(43),
      // a stored sale share token (43 base64url chars, no dot)
      "x".repeat(43),
      `${token}\n`,
    ]) {
      expect(verifyCreditNoteToken("refund", bad), bad).toBeNull();
      expect(verifyCreditNoteToken("void", bad), bad).toBeNull();
    }
  });

  it("refuses to sign anything that is not a UUID", () => {
    expect(creditNoteToken("refund", "nope")).toBeNull();
    expect(creditNoteToken("void", `${id}0`)).toBeNull();
  });
});
