import { useTradeStore } from "./tradeStore";

describe("tradeStore", () => {
  beforeEach(() => useTradeStore.setState({ selectedCoin: null, prefill: null }));

  it("stores a selected coin uppercased", () => {
    useTradeStore.getState().setSelectedCoin("eth");
    expect(useTradeStore.getState().selectedCoin).toBe("ETH");
  });

  it("clears the selected coin", () => {
    useTradeStore.getState().setSelectedCoin("SOL");
    useTradeStore.getState().clearSelectedCoin();
    expect(useTradeStore.getState().selectedCoin).toBeNull();
  });

  it("openTrade sets coin plus a reduce-only size prefill", () => {
    useTradeStore.getState().openTrade("eth", { size: "1.5", reduceOnly: true });
    expect(useTradeStore.getState().selectedCoin).toBe("ETH");
    expect(useTradeStore.getState().prefill).toEqual({ size: "1.5", reduceOnly: true });
  });

  it("openTrade without options leaves prefill null (plain coin select)", () => {
    useTradeStore.getState().openTrade("sol");
    expect(useTradeStore.getState().selectedCoin).toBe("SOL");
    expect(useTradeStore.getState().prefill).toBeNull();
  });

  it("clearPrefill drops the prefill but keeps coin clearing separate", () => {
    useTradeStore.getState().openTrade("BTC", { size: "0.1", reduceOnly: true });
    useTradeStore.getState().clearPrefill();
    expect(useTradeStore.getState().prefill).toBeNull();
  });
});
