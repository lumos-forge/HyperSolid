import {
  normalizeFills,
  normalizeFundings,
  normalizeOpenOrders,
  normalizeOrderUpdates,
  reconcileOpenOrders,
  mergeFills,
} from "./history";
import type { RawUserFill, RawFunding, RawOpenOrder, RawOrderUpdate } from "./types";
import { IntentLedger } from "./intentLedger";

const fill = (over: Partial<RawUserFill>): RawUserFill => ({
  coin: "BTC",
  px: "60000",
  sz: "0.01",
  side: "B",
  time: 1000,
  startPosition: "0",
  dir: "Open Long",
  closedPnl: "0",
  hash: ("0x" + "1".repeat(64)) as `0x${string}`,
  oid: 1,
  crossed: true,
  fee: "0.5",
  tid: 100,
  feeToken: "USDC",
  twapId: null,
  ...over,
});

describe("normalizeFills (userFills)", () => {
  it("maps fields, B/A side, builderFee default 0", () => {
    const [f] = normalizeFills([fill({ side: "A", closedPnl: "-1.5", builderFee: "0.1" })]);
    expect(f.side).toBe("sell");
    expect(f.px).toBe(60000);
    expect(f.sz).toBe(0.01);
    expect(f.closedPnl).toBe(-1.5);
    expect(f.fee).toBe(0.5);
    expect(f.builderFee).toBe(0.1);
    const [g] = normalizeFills([fill({})]);
    expect(g.side).toBe("buy");
    expect(g.builderFee).toBe(0); // absent -> 0
  });

  it("dedupes by tid and sorts newest first", () => {
    const out = normalizeFills([
      fill({ tid: 1, time: 100 }),
      fill({ tid: 1, time: 100 }), // duplicate tid
      fill({ tid: 2, time: 300 }),
      fill({ tid: 3, time: 200 }),
    ]);
    expect(out.map((f) => f.tid)).toEqual([2, 3, 1]); // unique, time desc
  });

  it("handles empty input", () => {
    expect(normalizeFills([])).toEqual([]);
  });
});

describe("mergeFills (cross-page pagination dedup)", () => {
  it("merges pages, dedupes by tid, keeps newest first", () => {
    const page1 = normalizeFills([fill({ tid: 3, time: 300 }), fill({ tid: 2, time: 200 })]);
    const page2 = normalizeFills([fill({ tid: 2, time: 200 }), fill({ tid: 1, time: 100 })]); // tid 2 overlaps
    const merged = mergeFills(page1, page2);
    expect(merged.map((f) => f.tid)).toEqual([3, 2, 1]);
  });

  it("returns existing unchanged when incoming is empty", () => {
    const page1 = normalizeFills([fill({ tid: 1, time: 100 })]);
    expect(mergeFills(page1, []).map((f) => f.tid)).toEqual([1]);
  });
});

const funding = (over: Partial<RawFunding["delta"]>, time = 1000): RawFunding => ({
  time,
  hash: ("0x" + "2".repeat(64)) as `0x${string}`,
  delta: { type: "funding", coin: "BTC", usdc: "-0.25", szi: "0.01", fundingRate: "0.0000125", nSamples: 1, ...over },
});

describe("normalizeFundings (userFundings)", () => {
  it("extracts delta fields (signed usdc) and sorts newest first", () => {
    const out = normalizeFundings([
      funding({ coin: "BTC", usdc: "-0.25" }, 100),
      funding({ coin: "ETH", usdc: "0.10" }, 300),
    ]);
    expect(out.map((f) => f.coin)).toEqual(["ETH", "BTC"]); // time desc
    expect(out[1].usdc).toBe(-0.25);
    expect(out[1].fundingRate).toBe(0.0000125);
    expect(out[1].szi).toBe(0.01);
  });

  it("handles empty input", () => {
    expect(normalizeFundings([])).toEqual([]);
  });
});

const openOrder = (over: Partial<RawOpenOrder>): RawOpenOrder => ({
  coin: "BTC",
  side: "B",
  limitPx: "59000",
  sz: "0.01",
  oid: 1,
  timestamp: 1000,
  origSz: "0.02",
  ...over,
});

describe("normalizeOpenOrders (openOrders)", () => {
  it("maps fields, B/A side, cloid null + reduceOnly default false", () => {
    const [o] = normalizeOpenOrders([openOrder({ side: "A" })]);
    expect(o.side).toBe("sell");
    expect(o.limitPx).toBe(59000);
    expect(o.sz).toBe(0.01);
    expect(o.origSz).toBe(0.02);
    expect(o.cloid).toBeNull();
    expect(o.reduceOnly).toBe(false);
    const [r] = normalizeOpenOrders([
      openOrder({ cloid: ("0x" + "a".repeat(32)) as `0x${string}`, reduceOnly: true }),
    ]);
    expect(r.cloid).toBe("0x" + "a".repeat(32));
    expect(r.reduceOnly).toBe(true);
  });

  it("dedupes by oid", () => {
    const out = normalizeOpenOrders([openOrder({ oid: 1 }), openOrder({ oid: 1 }), openOrder({ oid: 2 })]);
    expect(out.map((o) => o.oid)).toEqual([1, 2]);
  });

  it("handles empty input", () => {
    expect(normalizeOpenOrders([])).toEqual([]);
  });
});

describe("normalizeOrderUpdates (orderUpdates WS)", () => {
  const upd = (over: Partial<RawOrderUpdate>): RawOrderUpdate => ({
    order: openOrder({}),
    status: "open",
    statusTimestamp: 2000,
    ...over,
  });

  it("normalizes the order and maps status -> kind + Chinese message (DRY normalizeOrderStatus)", () => {
    const [u] = normalizeOrderUpdates([upd({ status: "filled" })]);
    expect(u.order.coin).toBe("BTC");
    expect(u.status).toBe("filled");
    expect(u.statusTimestamp).toBe(2000);
    expect(u.kind).toBe("filled");
    expect(u.message).toMatch(/[\u4e00-\u9fa5]/);
  });

  it("maps cancellation statuses", () => {
    const [u] = normalizeOrderUpdates([upd({ status: "marginCanceled" })]);
    expect(u.kind).toBe("canceled");
  });
});

describe("reconcileOpenOrders (read-only consumption of the cloid ledger)", () => {
  it("annotates orders that have a tracked local intent by cloid", () => {
    const ledger = new IntentLedger();
    const cloid = ("0x" + "a".repeat(32)) as `0x${string}`;
    ledger.open({ coin: "BTC", side: "buy", size: 0.01, price: 60000, cloid });

    const orders = normalizeOpenOrders([
      openOrder({ oid: 1, cloid }),
      openOrder({ oid: 2 }), // no cloid -> untracked
    ]);
    const out = reconcileOpenOrders(orders, ledger);

    const tracked = out.find((o) => o.oid === 1)!;
    const untracked = out.find((o) => o.oid === 2)!;
    expect(tracked.tracked).toBe(true);
    expect(tracked.intentStatus).toBe("pending");
    expect(untracked.tracked).toBe(false);
    expect(untracked.intentStatus).toBeNull();
  });

  it("treats unknown cloids as untracked", () => {
    const ledger = new IntentLedger();
    const orders = normalizeOpenOrders([
      openOrder({ oid: 3, cloid: ("0x" + "b".repeat(32)) as `0x${string}` }),
    ]);
    const [o] = reconcileOpenOrders(orders, ledger);
    expect(o.tracked).toBe(false);
    expect(o.intentStatus).toBeNull();
  });
});
