import React from "react";
import { render, screen } from "@testing-library/react-native";
import { TradeScreen } from "./TradeScreen";
import { useWalletStore } from "../state/walletStore";
import { useEnvStore } from "../state/envStore";
import { useMarketStore } from "../state/marketStore";
import type { MarketTicker } from "../lib/hyperliquid/types";

const btc: MarketTicker = {
  coin: "BTC",
  midPx: 62481.5,
  prevDayPx: 61170,
  changePct: 2.43,
  funding: 0.00011,
  dayNtlVlm: 1.2e9,
  maxLeverage: 50,
};

describe("TradeScreen", () => {
  beforeEach(() => {
    useEnvStore.setState({ network: "mainnet" });
    useMarketStore.setState({ tickers: [btc], loading: false, error: null });
    useWalletStore.setState({ mode: "none", wallet: null, address: null });
  });

  it("prompts to connect a wallet when none is set", () => {
    render(<TradeScreen />);
    expect(screen.getByText("交易 Trade")).toBeTruthy();
    expect(screen.getByText(/请先在「钱包」连接钱包后交易/)).toBeTruthy();
  });

  it("blocks trading in view-only mode", () => {
    useWalletStore.setState({ mode: "viewOnly", address: "0xabc" });
    render(<TradeScreen />);
    expect(screen.getByText(/只读模式不能交易/)).toBeTruthy();
  });

  it("renders the order form chrome when a local wallet is connected", () => {
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: "0xabc" });
    render(<TradeScreen />);
    expect(screen.getByText("HYPERSOLID")).toBeTruthy();
    expect(screen.getByText("◷ MAINNET")).toBeTruthy();
    expect(screen.getByText("买入 / 做多")).toBeTruthy();
    expect(screen.getByText("卖出 / 做空")).toBeTruthy();
    expect(screen.getByText("提交订单")).toBeTruthy();
  });

  it("shows the current price hint for the selected coin", () => {
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: "0xabc" });
    render(<TradeScreen />);
    expect(screen.getByText(/当前价 62481.5/)).toBeTruthy();
  });
});
