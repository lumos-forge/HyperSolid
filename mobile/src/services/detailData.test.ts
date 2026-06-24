import { DetailDataService } from "./detailData";
import type {
  DetailInfoLike,
  DetailSubsLike,
  RawCandle,
  RawL2Book,
  RawTrade,
  Subscription,
} from "../lib/hyperliquid/types";

const candles: RawCandle[] = [
  { t: 1, T: 2, s: "BTC", o: "10", c: "12", h: "13", l: "9", v: "100", n: 5 },
];
const book: RawL2Book = {
  coin: "BTC",
  time: 1,
  levels: [
    [{ px: "100", sz: "2", n: 1 }],
    [{ px: "101", sz: "1", n: 1 }],
  ],
};
const trades: RawTrade[] = [{ coin: "BTC", side: "B", px: "100", sz: "1", time: 5, tid: 1 }];

class FakeInfo implements DetailInfoLike {
  candleSnapshot = jest.fn(
    async (_coin: string, _interval: string, _start: number, _end: number): Promise<RawCandle[]> =>
      candles,
  );
}
class FakeSubs implements DetailSubsLike {
  bookListener: ((b: RawL2Book) => void) | null = null;
  tradeListener: ((t: RawTrade[]) => void) | null = null;
  unsub = jest.fn(async () => {});
  l2Book = jest.fn(async (_c: string, cb: (b: RawL2Book) => void): Promise<Subscription> => {
    this.bookListener = cb;
    return { unsubscribe: this.unsub };
  });
  trades = jest.fn(async (_c: string, cb: (t: RawTrade[]) => void): Promise<Subscription> => {
    this.tradeListener = cb;
    return { unsubscribe: this.unsub };
  });
}

describe("DetailDataService", () => {
  it("loadCandles returns normalized candles and requests a time window", async () => {
    const info = new FakeInfo();
    const svc = new DetailDataService(info, new FakeSubs());
    const out = await svc.loadCandles("BTC", "1h", 100, 1_000_000_000);
    expect(out[0].open).toBe(10);
    const [coin, interval, start, end] = info.candleSnapshot.mock.calls[0];
    expect(coin).toBe("BTC");
    expect(interval).toBe("1h");
    expect(end - start).toBe(3_600_000 * 100);
  });

  it("loadCandles supports the v8 sub-hour/2h intervals (3m/30m/2h)", async () => {
    const info = new FakeInfo();
    const svc = new DetailDataService(info, new FakeSubs());
    for (const [interval, step] of [["3m", 180_000], ["30m", 1_800_000], ["2h", 7_200_000]] as const) {
      info.candleSnapshot.mockClear();
      await svc.loadCandles("BTC", interval, 50, 1_000_000_000);
      const [, iv, start, end] = info.candleSnapshot.mock.calls[0];
      expect(iv).toBe(interval);
      expect(end - start).toBe(step * 50);
    }
  });

  it("subscribeOrderbook forwards normalized book", async () => {
    const subs = new FakeSubs();
    const svc = new DetailDataService(new FakeInfo(), subs);
    let received: number | null = null;
    await svc.subscribeOrderbook("BTC", (ob) => (received = ob.spread));
    subs.bookListener!(book);
    expect(received).toBe(1);
  });

  it("subscribeTrades forwards normalized trades", async () => {
    const subs = new FakeSubs();
    const svc = new DetailDataService(new FakeInfo(), subs);
    let side: string | null = null;
    await svc.subscribeTrades("BTC", (t) => (side = t[0].side));
    subs.tradeListener!(trades);
    expect(side).toBe("buy");
  });
});
