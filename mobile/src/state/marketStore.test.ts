import { useMarketStore } from "./marketStore";
import type { MarketTicker } from "../lib/hyperliquid/types";

const tickers: MarketTicker[] = [
  { coin: "BTC", midPx: 100, prevDayPx: 100, changePct: 0, funding: 0, dayNtlVlm: 9, maxLeverage: 50 },
];

describe("marketStore", () => {
  beforeEach(() => {
    useMarketStore.setState({ tickers: [], loading: true, error: null });
  });

  it("setMarkets stores tickers and clears loading", () => {
    useMarketStore.getState().setMarkets(tickers);
    expect(useMarketStore.getState().tickers).toHaveLength(1);
    expect(useMarketStore.getState().loading).toBe(false);
    expect(useMarketStore.getState().error).toBeNull();
  });

  it("mergeMids updates an existing ticker price", () => {
    useMarketStore.getState().setMarkets(tickers);
    useMarketStore.getState().mergeMids({ BTC: "120" });
    expect(useMarketStore.getState().tickers[0].midPx).toBe(120);
  });

  it("setError records the message and clears loading", () => {
    useMarketStore.getState().setError("boom");
    expect(useMarketStore.getState().error).toBe("boom");
    expect(useMarketStore.getState().loading).toBe(false);
  });
});
