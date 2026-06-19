import React from "react";
import { render, screen } from "@testing-library/react-native";
import { MarketsScreen } from "./MarketsScreen";
import { useMarketStore } from "../state/marketStore";
import type { MarketTicker } from "../lib/hyperliquid/types";

const tickers: MarketTicker[] = [
  { coin: "BTC", midPx: 62481.5, prevDayPx: 61000, changePct: 2.43, funding: 0.0001, dayNtlVlm: 2, maxLeverage: 50 },
  { coin: "ETH", midPx: 3002.18, prevDayPx: 3028, changePct: -0.86, funding: 0.00008, dayNtlVlm: 1, maxLeverage: 50 },
];

describe("MarketsScreen", () => {
  beforeEach(() => useMarketStore.setState({ tickers: [], loading: true, error: null }));

  it("shows a loading state initially", () => {
    render(<MarketsScreen />);
    expect(screen.getByText(/loading/i)).toBeTruthy();
  });

  it("renders rows once markets load", () => {
    useMarketStore.getState().setMarkets(tickers);
    render(<MarketsScreen />);
    expect(screen.getByText("BTC")).toBeTruthy();
    expect(screen.getByText("ETH")).toBeTruthy();
  });

  it("shows an error message when set", () => {
    useMarketStore.getState().setError("network down");
    render(<MarketsScreen />);
    expect(screen.getByText(/network down/i)).toBeTruthy();
  });
});
