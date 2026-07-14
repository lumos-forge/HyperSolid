import { createL1ActionHash } from "@nktkas/hyperliquid/signing";
import { actionFromKindParams } from "./l1Action";

describe("actionFromKindParams", () => {
  it("builds an order action in HL field order (cloid included)", () => {
    const a = actionFromKindParams("order", {
      asset: 3, isBuy: true, px: "100.0", sz: "0.5", reduceOnly: false, tif: "Ioc", grouping: "na", cloid: "0xabc",
    });
    expect(a).toEqual({
      type: "order",
      orders: [{ a: 3, b: true, p: "100.0", s: "0.5", r: false, t: { limit: { tif: "Ioc" } }, c: "0xabc" }],
      grouping: "na",
    });
  });

  it("omits the order cloid when absent and defaults grouping to na", () => {
    const a = actionFromKindParams("order", {
      asset: 1, isBuy: false, px: "1", sz: "1", reduceOnly: true, tif: "Alo",
    }) as { orders: Array<Record<string, unknown>>; grouping: string };
    expect("c" in a.orders[0]).toBe(false);
    expect(a.grouping).toBe("na");
  });

  it("builds a cancelByCloid action", () => {
    expect(actionFromKindParams("cancelByCloid", { cancels: [{ asset: 2, cloid: "0x1" }] })).toEqual({
      type: "cancelByCloid",
      cancels: [{ asset: 2, cloid: "0x1" }],
    });
  });

  it("builds scheduleCancel with and without a time", () => {
    expect(actionFromKindParams("scheduleCancel", { time: 123 })).toEqual({ type: "scheduleCancel", time: 123 });
    expect(actionFromKindParams("scheduleCancel", {})).toEqual({ type: "scheduleCancel" });
    expect(actionFromKindParams("scheduleCancel", undefined)).toEqual({ type: "scheduleCancel" });
  });

  it("returns undefined for an unsupported kind", () => {
    expect(actionFromKindParams("updateLeverage", {})).toBeUndefined();
  });

  it("appends the builder after grouping when present", () => {
    const a = actionFromKindParams("order", {
      asset: 0, isBuy: true, px: "50000", sz: "0.01", reduceOnly: false, tif: "Gtc", grouping: "na",
      builder: { b: "0x1111111111111111111111111111111111111111", f: 20 },
    }) as Record<string, unknown>;
    expect(a).toEqual({
      type: "order",
      orders: [{ a: 0, b: true, p: "50000", s: "0.01", r: false, t: { limit: { tif: "Gtc" } } }],
      grouping: "na",
      builder: { b: "0x1111111111111111111111111111111111111111", f: 20 },
    });
    expect(Object.keys(a)).toEqual(["type", "orders", "grouping", "builder"]);
  });

  it("omits the builder when absent (unchanged action)", () => {
    const a = actionFromKindParams("order", { asset: 0, isBuy: true, px: "1", sz: "1", reduceOnly: false, tif: "Ioc" }) as Record<string, unknown>;
    expect("builder" in a).toBe(false);
  });

  it("produces a stable, hashable action (createL1ActionHash is deterministic)", () => {
    const a = actionFromKindParams("order", { asset: 0, isBuy: true, px: "50", sz: "1", reduceOnly: false, tif: "Ioc", cloid: "0xdeadbeef" });
    const h1 = createL1ActionHash({ action: a as Record<string, unknown>, nonce: 1 });
    const h2 = createL1ActionHash({ action: a as Record<string, unknown>, nonce: 1 });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^0x[0-9a-f]+$/i);
  });
});
