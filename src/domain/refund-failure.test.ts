import { describe, expect, it } from "vitest";
import en from "../../messages/en/refundErrors.json";
import mn from "../../messages/mn/refundErrors.json";
import { REFUND_ERROR_CODES, REFUND_ERROR_MESSAGE_KEYS } from "./refund-contract";
import { refundCodeFromFailure, shiftCodeFromFailure, voidCodeFromFailure } from "./refund-failure";
import { SHIFT_ERROR_CODES, SHIFT_ERROR_MESSAGE_KEYS } from "./shift-contract";
import { VOID_ERROR_CODES, VOID_ERROR_MESSAGE_KEYS } from "./void-contract";

type Tree = { [key: string]: string | Tree };

/** Resolve "refund.errors.CODE" the way next-intl does inside the namespace. */
function lookup(tree: Tree, key: string): string | undefined {
  let node: string | Tree | undefined = tree;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === undefined) return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

describe("refundErrors messages", () => {
  const all = [
    ...Object.values(REFUND_ERROR_MESSAGE_KEYS),
    ...Object.values(VOID_ERROR_MESSAGE_KEYS),
    ...Object.values(SHIFT_ERROR_MESSAGE_KEYS),
  ];

  it("has a Mongolian and an English message for every contract error code", () => {
    expect(all.length).toBe(
      REFUND_ERROR_CODES.length + VOID_ERROR_CODES.length + SHIFT_ERROR_CODES.length,
    );
    for (const key of all) {
      expect(lookup(mn as Tree, key), `mn ${key}`).toBeTruthy();
      expect(lookup(en as Tree, key), `en ${key}`).toBeTruthy();
    }
  });

  it("has no message that is not a contract code", () => {
    const keys = (tree: Tree, prefix = ""): string[] =>
      Object.entries(tree).flatMap(([k, v]) =>
        typeof v === "string" ? [`${prefix}${k}`] : keys(v, `${prefix}${k}.`),
      );
    expect(keys(mn as Tree).sort()).toEqual([...all].sort());
    expect(keys(en as Tree).sort()).toEqual([...all].sort());
  });
});

describe("failure transport", () => {
  it("reads codes and details back out of the action envelope", () => {
    const failure = {
      fieldErrors: { refund: ["OVER_REFUND"], "refund.details": ['{"issues":[1]}'] },
    };
    expect(refundCodeFromFailure(failure)).toEqual({
      code: "OVER_REFUND",
      messageKey: "refund.errors.OVER_REFUND",
      details: { issues: [1] },
    });
    expect(voidCodeFromFailure({ fieldErrors: { void: ["ALREADY_VOIDED"] } })?.messageKey).toBe(
      "void.errors.ALREADY_VOIDED",
    );
    expect(shiftCodeFromFailure({ fieldErrors: { shift: ["SHIFT_NOT_OPEN"] } })?.code).toBe(
      "SHIFT_NOT_OPEN",
    );
  });

  it("ignores unknown codes, other areas and malformed details", () => {
    expect(refundCodeFromFailure({ fieldErrors: { refund: ["NOPE"] } })).toBeNull();
    expect(refundCodeFromFailure({ fieldErrors: { void: ["ALREADY_VOIDED"] } })).toBeNull();
    expect(refundCodeFromFailure({})).toBeNull();
    expect(
      refundCodeFromFailure({ fieldErrors: { refund: ["OVER_REFUND"], "refund.details": ["{"] } }),
    ).toEqual({ code: "OVER_REFUND", messageKey: "refund.errors.OVER_REFUND" });
  });
});
