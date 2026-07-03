import { normalizeActiveTwaps, twapProgressPct, type ActiveTwap } from "./twap";

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
