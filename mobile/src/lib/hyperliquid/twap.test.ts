import { normalizeActiveTwaps, twapProgressPct, normalizeTwapHistory, normalizeSliceFills, groupSliceFillsByTwapId, type ActiveTwap } from "./twap";

const running = {
  status: { status: "activated" },
  twapId: 7,
  state: { coin: "BTC", side: "B", sz: "1", executedSz: "0.4", executedNtl: "24000", minutes: 30, reduceOnly: false, timestamp: 1000 },
};
const finished = {
  status: { status: "finished" },
  twapId: 8,
  state: { coin: "ETH", side: "A", sz: "2", executedSz: "2", executedNtl: "5000", minutes: 10, reduceOnly: false, timestamp: 900 },
};
const noId = {
  status: { status: "activated" },
  state: { coin: "SOL", side: "A", sz: "3", executedSz: "0", executedNtl: "0", minutes: 15, reduceOnly: true, timestamp: 800 },
};

describe("normalizeActiveTwaps", () => {
  it("keeps only activated entries that have a numeric twapId, mapping side + fields", () => {
    expect(normalizeActiveTwaps([running, finished, noId])).toEqual([
      { twapId: 7, coin: "BTC", side: "buy", sz: 1, executedSz: 0.4, executedNtl: 24000, minutes: 30, reduceOnly: false, startedAt: 1000 },
    ]);
  });
  it("maps sell side (A) and reduceOnly", () => {
    const s = { status: { status: "activated" }, twapId: 9, state: { coin: "ETH", side: "A", sz: "2", executedSz: "1", executedNtl: "1800", minutes: 20, reduceOnly: true, timestamp: 500 } };
    expect(normalizeActiveTwaps([s])[0]).toMatchObject({ side: "sell", reduceOnly: true });
  });
  it("returns [] for a non-array or empty input", () => {
    expect(normalizeActiveTwaps(null)).toEqual([]);
    expect(normalizeActiveTwaps([])).toEqual([]);
  });
});

describe("twapProgressPct", () => {
  const t: ActiveTwap = { twapId: 1, coin: "BTC", side: "buy", sz: 2, executedSz: 0.5, executedNtl: 1, minutes: 30, reduceOnly: false, startedAt: 0 };
  it("is executed/total as a percent", () => {
    expect(twapProgressPct(t)).toBe(25);
  });
  it("clamps to [0,100] and is 0 for non-positive size", () => {
    expect(twapProgressPct({ ...t, executedSz: 5 })).toBe(100);
    expect(twapProgressPct({ ...t, sz: 0 })).toBe(0);
  });
});

function sliceRaw(twapId: unknown, over: Record<string, unknown> = {}) {
  return { twapId, fill: { coin: "BTC", px: "60000", sz: "0.1", side: "B", time: 100, startPosition: "0", dir: "Open Long", closedPnl: "0", hash: "0x", oid: 1, crossed: true, fee: "0.1", tid: 1, feeToken: "USDC", twapId, ...over } };
}

describe("normalizeTwapHistory", () => {
  it("keeps finished/terminated/error entries, maps side + fields, newest first", () => {
    const raw = [
      { status: { status: "activated" }, twapId: 1, state: { coin: "BTC", side: "B", sz: "1", executedSz: "0.4", executedNtl: "24000", minutes: 30, reduceOnly: false, timestamp: 1000 } },
      { status: { status: "finished" }, twapId: 2, state: { coin: "ETH", side: "A", sz: "2", executedSz: "2", executedNtl: "5000", minutes: 10, reduceOnly: false, timestamp: 900 } },
      { status: { status: "terminated" }, twapId: 3, state: { coin: "SOL", side: "B", sz: "3", executedSz: "1", executedNtl: "180", minutes: 15, reduceOnly: true, timestamp: 1200 } },
    ];
    const out = normalizeTwapHistory(raw);
    expect(out.map((e) => e.twapId)).toEqual([3, 2]); // activated dropped; newest (1200) first
    expect(out[1]).toEqual({ twapId: 2, coin: "ETH", side: "sell", sz: 2, executedSz: 2, executedNtl: 5000, minutes: 10, reduceOnly: false, startedAt: 900, status: "finished" });
  });
  it("keeps error status and null twapId; returns [] for non-array", () => {
    const raw = [{ status: { status: "error" }, state: { coin: "BTC", side: "B", sz: "1", executedSz: "0", executedNtl: "0", minutes: 5, reduceOnly: false, timestamp: 1 } }];
    expect(normalizeTwapHistory(raw)[0]).toMatchObject({ twapId: null, status: "error" });
    expect(normalizeTwapHistory(null)).toEqual([]);
  });
});

describe("normalizeSliceFills", () => {
  it("drops entries without a numeric twapId and normalizes the fill", () => {
    const out = normalizeSliceFills([sliceRaw(7), sliceRaw(null), sliceRaw("x")]);
    expect(out).toHaveLength(1);
    expect(out[0].twapId).toBe(7);
    expect(out[0].fill).toMatchObject({ coin: "BTC", px: 60000, sz: 0.1, side: "buy", tid: 1 });
  });
  it("returns [] for a non-array", () => {
    expect(normalizeSliceFills(undefined)).toEqual([]);
  });
});

describe("groupSliceFillsByTwapId", () => {
  it("groups by twapId, dedups by tid, sorts each group newest first", () => {
    const list = normalizeSliceFills([
      sliceRaw(7, { tid: 1, time: 100 }),
      sliceRaw(7, { tid: 1, time: 100 }), // dup tid
      sliceRaw(7, { tid: 2, time: 300 }),
      sliceRaw(8, { tid: 3, time: 200 }),
    ]);
    const map = groupSliceFillsByTwapId(list);
    expect(map.get(7)!.map((f) => f.tid)).toEqual([2, 1]); // newest first, deduped
    expect(map.get(8)!.map((f) => f.tid)).toEqual([3]);
  });
});
