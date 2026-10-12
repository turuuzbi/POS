import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isWeakPin, pinLookup, pinSchema } from "./pin";

describe("pinLookup", () => {
  it("is deterministic and never contains the PIN", () => {
    expect(pinLookup("4821")).toBe(pinLookup("4821"));
    expect(pinLookup("4821")).not.toBe(pinLookup("4822"));
    expect(pinLookup("4821")).not.toContain("4821");
  });

  it("is an HMAC keyed by the server pepper", () => {
    const expected = createHmac("sha256", process.env.PIN_PEPPER ?? "")
      .update("pin:v1:4821")
      .digest("base64url");
    expect(pinLookup("4821")).toBe(expected);
    const unkeyed = createHmac("sha256", "").update("pin:v1:4821").digest("base64url");
    expect(pinLookup("4821")).not.toBe(unkeyed);
  });
});

describe("pinSchema", () => {
  it("accepts 4–8 digits only", () => {
    for (const ok of ["0000", "12345678", "4821"])
      expect(pinSchema.safeParse(ok).success).toBe(true);
    for (const bad of ["123", "123456789", "12a4", " 1234", ""]) {
      expect(pinSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("isWeakPin", () => {
  it.each(["0000", "1111", "1234", "4321", "123456", "987654", "8901", "2109"])(
    "flags %s",
    (pin) => {
      expect(isWeakPin(pin)).toBe(true);
    },
  );
  it.each(["4821", "1357", "2580", "1122", "903817"])("accepts %s", (pin) => {
    expect(isWeakPin(pin)).toBe(false);
  });
});
