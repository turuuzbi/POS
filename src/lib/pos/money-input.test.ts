import { describe, expect, it } from "vitest";
import {
  applyKeypad,
  moneyToInput,
  parseKeypadMoney,
  parsePercentBps,
  qtyToInput,
} from "./money-input";

describe("money input", () => {
  it("formats möngö as the plain tögrög text the server parses", () => {
    expect(moneyToInput(1_250_000n)).toBe("12500");
    expect(moneyToInput(1_250_050n)).toBe("12500.50");
    expect(moneyToInput(5n)).toBe("0.05");
    expect(moneyToInput(0n)).toBe("0");
  });

  it("parses keypad text", () => {
    expect(parseKeypadMoney("5000")).toBe(500_000n);
    expect(parseKeypadMoney("12.5")).toBe(1250n);
    expect(parseKeypadMoney("")).toBeNull();
    expect(parseKeypadMoney("99", 100n)).toBeNull();
  });

  it("parses percentages to basis points within range", () => {
    expect(parsePercentBps("10")).toBe(1000);
    expect(parsePercentBps("12.5")).toBe(1250);
    expect(parsePercentBps("0.01")).toBe(1);
    expect(parsePercentBps("100")).toBe(10_000);
    expect(parsePercentBps("100.01")).toBeNull();
    expect(parsePercentBps("0")).toBeNull();
    expect(parsePercentBps("abc")).toBeNull();
  });

  it("formats quantities without trailing zeros", () => {
    expect(qtyToInput(3000)).toBe("3");
    expect(qtyToInput(1250)).toBe("1.25");
    expect(qtyToInput(50)).toBe("0.05");
  });
});

describe("applyKeypad", () => {
  const press = (keys: string[], options = {}) =>
    keys.reduce((text, key) => applyKeypad(text, key, options), "");

  it("builds integers and collapses leading zeros", () => {
    expect(press(["0", "0", "7", "5"])).toBe("75");
    expect(press(["00"])).toBe("0");
    expect(press(["1", "00"])).toBe("100");
  });

  it("supports backspace and clear", () => {
    expect(press(["1", "2", "3", "backspace"])).toBe("12");
    expect(press(["1", "2", "clear"])).toBe("");
  });

  it("allows one decimal mark up to the allowed digits", () => {
    const options = { decimals: 3 };
    expect(press(["1", ".", "2", "5", "0", "9"], options)).toBe("1.250");
    expect(press([".", "5"], options)).toBe("0.5");
    expect(press(["1", ".", ".", "2"], options)).toBe("1.2");
  });

  it("ignores the decimal mark when decimals are not allowed", () => {
    expect(press(["1", ".", "2"])).toBe("12");
  });

  it("keeps leading zeros for PINs", () => {
    expect(press(["0", "0", "0", "0"], { leadingZeros: true })).toBe("0000");
    expect(press(["0", "0", "7"], { leadingZeros: true })).toBe("007");
  });

  it("stops at the maximum length", () => {
    expect(press(Array(20).fill("9"), { maxLength: 5 })).toBe("99999");
  });
});
