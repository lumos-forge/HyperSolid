import { dueTwap, twapSliceUsdc, twapIntervalMs } from "./twap";
import type { Strategy, TwapParams } from "./types";

const p: TwapParams = { coin: "ETH", side: "buy", totalUsdc: 300, slices: 6, durationHours: 3 };
const s = (over: Partial<Strategy> = {}): Strategy => ({
  id: "t1", owner: "0xo", kind: "twap", status: "running", createdAt: 0,
  params: p, nextRunAt: 1000, filledTotalUsdc: 0, slicesDone: 0, ...over,
} as Strategy);

describe("twap", () => {
  it("dueTwap returns running twaps due and not yet fully sliced", () => {
    const list = [
      s({ id: "a", nextRunAt: 500 }),
      s({ id: "b", nextRunAt: 5000 }),
      s({ id: "c", nextRunAt: 0, slicesDone: 6 }), // all slices done
      s({ id: "d", status: "paused", nextRunAt: 0 }),
    ];
    expect(dueTwap(list, 1000).map((x) => x.id)).toEqual(["a"]);
  });
  it("twapSliceUsdc splits total evenly", () => {
    expect(twapSliceUsdc(p)).toBe(50);
  });
  it("twapIntervalMs = duration / slices", () => {
    expect(twapIntervalMs(p)).toBe((3 * 3600 * 1000) / 6);
  });
  it("guards against zero slices", () => {
    expect(twapSliceUsdc({ ...p, slices: 0 })).toBe(0);
    expect(twapIntervalMs({ ...p, slices: 0 })).toBe(0);
  });
});
