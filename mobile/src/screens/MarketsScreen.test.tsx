import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { MarketsScreen } from "./MarketsScreen";
import { useMarketStore } from "../state/marketStore";
import { useEnvStore } from "../state/envStore";
import type { MarketTicker } from "../lib/hyperliquid/types";

const tickers: MarketTicker[] = [
  { coin: "BTC", midPx: 62481.5, prevDayPx: 61000, changePct: 2.43, funding: 0.0001, dayNtlVlm: 2, maxLeverage: 50 },
  { coin: "ETH", midPx: 3002.18, prevDayPx: 3028, changePct: -0.86, funding: 0.00008, dayNtlVlm: 1, maxLeverage: 50 },
];

describe("MarketsScreen", () => {
  beforeEach(() => {
    useMarketStore.setState({ tickers: [], loading: true, error: null });
    useEnvStore.setState({ network: "mainnet" });
  });

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

  it("renders the phosphor chrome: status title, signal readout and search", () => {
    render(<MarketsScreen />);
    expect(screen.getByText("HYPERSOLID")).toBeTruthy();
    expect(screen.getByText("SIGNAL · LIVE")).toBeTruthy();
    expect(screen.getByPlaceholderText("search markets")).toBeTruthy();
  });

  it("shows the active network in the status pill", () => {
    render(<MarketsScreen />);
    expect(screen.getByText("◷ MAINNET")).toBeTruthy();
  });

  it("filters rows by the search query", () => {
    useMarketStore.getState().setMarkets(tickers);
    render(<MarketsScreen />);
    fireEvent.changeText(screen.getByPlaceholderText("search markets"), "btc");
    expect(screen.getByText("BTC")).toBeTruthy();
    expect(screen.queryByText("ETH")).toBeNull();
  });
});
