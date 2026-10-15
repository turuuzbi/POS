import { describe, expect, it } from "vitest";
import {
  exchangeKey,
  fromStored,
  loadExchange,
  saveExchange,
  toStored,
  type ExchangeContext,
  type KeyValueStore,
} from "./exchange";
import { IDS } from "./test-fixtures";

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const context: ExchangeContext = {
  refundId: IDS.newRefund,
  saleId: IDS.sale,
  saleNumber: "UB1-000123",
  draft: {
    choices: { [IDS.milk]: { qtyMilli: 1000, restock: true } },
    reason: "WRONG_ITEM",
    note: "",
    payout: { kind: "CUSTOM", entries: [{ method: "CASH", amount: 12_345n }] },
  },
  checkedOut: { saleId: IDS.exchangeSale, payable: 1_500_000n },
};

describe("exchange context storage", () => {
  it("round-trips bigint money through JSON", () => {
    const stored = toStored(context);
    expect(JSON.parse(JSON.stringify(stored))).toEqual(stored);
    expect(fromStored(stored)).toEqual(context);
  });

  it("saves, loads and clears per scope", () => {
    const store = memory();
    saveExchange(store, "reg:user", context);
    expect(store.data.has(exchangeKey("reg:user"))).toBe(true);
    expect(loadExchange(store, "reg:user")).toEqual(context);
    expect(loadExchange(store, "other:user")).toBeNull();
    saveExchange(store, "reg:user", null);
    expect(loadExchange(store, "reg:user")).toBeNull();
  });

  it("ignores corrupt or foreign data and tolerates missing storage", () => {
    const store = memory();
    store.setItem(exchangeKey("s"), "{not json");
    expect(loadExchange(store, "s")).toBeNull();
    store.setItem(exchangeKey("s"), JSON.stringify({ v: 2 }));
    expect(loadExchange(store, "s")).toBeNull();
    expect(loadExchange(null, "s")).toBeNull();
    expect(() => saveExchange(null, "s", context)).not.toThrow();
    const throwing: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadExchange(throwing, "s")).toBeNull();
    expect(() => saveExchange(throwing, "s", context)).not.toThrow();
  });
});
