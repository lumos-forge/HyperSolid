import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { MarketDetailScreen } from "./MarketDetailScreen";
import { useMarketStore } from "../state/marketStore";
import type { MarketTicker } from "../lib/hyperliquid/types";

jest.mock("../hooks/useLiveDetail", () => ({
  useLiveDetail: () => ({ candles: [], orderbook: null, trades: [] }),
}));
jest.mock("../lib/hyperliquid/client", () => ({
  createDetailInfoClient: () => ({}),
  createDetailSubsClient: () => ({}),
}));
jest.mock("../services/detailData", () => ({
  DetailDataService: class {
    async loadDailyCloses() {
      return [];
    }
  },
}));

const btc: MarketTicker = {
  coin: "BTC",
  midPx: 62481.5,
  prevDayPx: 61170,
  changePct: 2.43,
  funding: 0.00011,
  dayNtlVlm: 1.2e9,
  openInterest: 1.95e9,
  maxLeverage: 50,
  szDecimals: 5,
};

function renderDetail(nav: { goBack: jest.Mock }) {
  return render(
    <MarketDetailScreen
      route={{ key: "k", name: "MarketDetail", params: { coin: "BTC" } } as never}
      navigation={nav as never}
    />,
  );
}

describe("MarketDetailScreen", () => {
  beforeEach(() => useMarketStore.setState({ tickers: [btc], loading: false, error: null }));

  it("renders the back header, hero price and signed change", () => {
    renderDetail({ goBack: jest.fn() });
    expect(screen.getByText("BTC-USDC PERP")).toBeTruthy();
    expect(screen.getAllByText("62,481.5").length).toBeGreaterThan(0);
    const chg = screen.getByText(/\+2\.43%/);
    expect(chg).toHaveTextContent(/▲/);
  });

  it("renders timeframe chips and the order book / trades tabs", () => {
    renderDetail({ goBack: jest.fn() });
    for (const tf of ["1H", "4H", "1D", "1W"]) {
      expect(screen.getByText(tf)).toBeTruthy();
    }
    expect(screen.getByText("Order book")).toBeTruthy();
    expect(screen.getByText("Trades")).toBeTruthy();
    expect(screen.getByText("Open interest")).toBeTruthy();
  });

  it("renders the trade CTA", () => {
    renderDetail({ goBack: jest.fn() });
    expect(screen.getByText("Trade")).toBeTruthy();
  });

  it("calls navigation.goBack when the back control is pressed", () => {
    const goBack = jest.fn();
    renderDetail({ goBack });
    fireEvent.press(screen.getByLabelText("back"));
    expect(goBack).toHaveBeenCalled();
  });
});
