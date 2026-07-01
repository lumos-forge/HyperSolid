import { renderHook, waitFor } from "@testing-library/react-native";
import { useLiveMarkets } from "./useLiveMarkets";
import { useMarketStore } from "../state/marketStore";
import type { MarketDataService } from "../services/marketData";
import type { MarketTicker, Mids, Subscription } from "../lib/hyperliquid/types";

const tickers: MarketTicker[] = [
  { coin: "BTC", midPx: 100, prevDayPx: 100, changePct: 0, funding: 0, dayNtlVlm: 1, maxLeverage: 50, szDecimals: 5 },
];

function fakeService(midsToPush?: Mids) {
  const unsub = jest.fn(async () => {});
  return {
    loadSnapshot: jest.fn(async () => tickers),
    subscribeMids: jest.fn(async (cb: (m: Mids) => void): Promise<Subscription> => {
      if (midsToPush) cb(midsToPush);
      return { unsubscribe: unsub };
    }),
    _unsub: unsub,
  } as unknown as MarketDataService & { _unsub: jest.Mock };
}

describe("useLiveMarkets", () => {
  beforeEach(() => useMarketStore.setState({ tickers: [], loading: true, error: null }));

  it("loads the snapshot into the store", async () => {
    const svc = fakeService();
    renderHook(() => useLiveMarkets(svc));
    await waitFor(() => expect(useMarketStore.getState().tickers).toHaveLength(1));
    expect(useMarketStore.getState().loading).toBe(false);
  });

  it("merges pushed mids into the store", async () => {
    const svc = fakeService({ BTC: "150" });
    renderHook(() => useLiveMarkets(svc));
    await waitFor(() => expect(useMarketStore.getState().tickers[0]?.midPx).toBe(150));
  });

  it("records an error when the snapshot fails", async () => {
    const svc = {
      loadSnapshot: jest.fn(async () => {
        const e = new Error("Unknown HTTP request error: boom");
        e.name = "HttpRequestError";
        throw e;
      }),
      subscribeMids: jest.fn(),
    } as unknown as MarketDataService;
    renderHook(() => useLiveMarkets(svc));
    await waitFor(() => expect(useMarketStore.getState().error).toBe("network"));
  });
});
