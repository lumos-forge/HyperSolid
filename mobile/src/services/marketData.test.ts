import { MarketDataService } from "./marketData";
import type {
  InfoLike,
  MetaAndAssetCtxs,
  Subscription,
  SubsLike,
} from "../lib/hyperliquid/types";

const meta: MetaAndAssetCtxs = [
  { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 50 }] },
  [{ midPx: "102", prevDayPx: "100", funding: "0", dayNtlVlm: "1", openInterest: "0" }],
];

class FakeInfo implements InfoLike {
  metaAndAssetCtxs = jest.fn(async (): Promise<MetaAndAssetCtxs> => meta);
  maxBuilderFee = jest.fn(async (): Promise<number> => 0);
}

class FakeSubs implements SubsLike {
  public listener: ((data: { mids: Record<string, string> }) => void) | null = null;
  public unsub = jest.fn(async () => {});
  allMids = jest.fn(async (l: (data: { mids: Record<string, string> }) => void): Promise<Subscription> => {
    this.listener = l;
    return { unsubscribe: this.unsub };
  });
}

describe("MarketDataService", () => {
  it("loadSnapshot returns normalized tickers", async () => {
    const svc = new MarketDataService(new FakeInfo(), new FakeSubs());
    const tickers = await svc.loadSnapshot();
    expect(tickers[0].coin).toBe("BTC");
    expect(tickers[0].midPx).toBe(102);
  });

  it("subscribeMids forwards mid updates to the callback", async () => {
    const subs = new FakeSubs();
    const svc = new MarketDataService(new FakeInfo(), subs);
    const received: Record<string, string>[] = [];
    await svc.subscribeMids((mids) => received.push(mids));
    subs.listener!({ mids: { BTC: "120" } });
    expect(received).toEqual([{ BTC: "120" }]);
  });

  it("subscribeMids returns a handle that unsubscribes", async () => {
    const subs = new FakeSubs();
    const svc = new MarketDataService(new FakeInfo(), subs);
    const handle = await svc.subscribeMids(() => {});
    await handle.unsubscribe();
    expect(subs.unsub).toHaveBeenCalled();
  });
});
