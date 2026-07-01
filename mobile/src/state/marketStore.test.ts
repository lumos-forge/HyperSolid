import { useMarketStore } from "./marketStore";
import type { MarketTicker } from "../lib/hyperliquid/types";

const tickers: MarketTicker[] = [
  { coin: "BTC", midPx: 100, prevDayPx: 100, changePct: 0, funding: 0, dayNtlVlm: 9, maxLeverage: 50, szDecimals: 5 },
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

  it("setError records the code and clears loading", () => {
    useMarketStore.getState().setError("network");
    expect(useMarketStore.getState().error).toBe("network");
    expect(useMarketStore.getState().loading).toBe(false);
  });

  it("retry clears the error and bumps the nonce", () => {
    useMarketStore.getState().setError("network");
    const before = useMarketStore.getState().retryNonce;
    useMarketStore.getState().retry();
    expect(useMarketStore.getState().error).toBeNull();
    expect(useMarketStore.getState().loading).toBe(true);
    expect(useMarketStore.getState().retryNonce).toBe(before + 1);
  });
});
