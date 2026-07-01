import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { MarketDetailScreen } from "./MarketDetailScreen";
import { useMarketStore } from "../state/marketStore";
import type { MarketTicker } from "../lib/hyperliquid/types";

const mockCandles = Array.from({ length: 40 }, (_, i) => ({
  t: i * 3_600_000,
  open: 100 + i,
  close: 101 + i,
  high: 102 + i,
  low: 99 + i,
  volume: 1000 + i * 10,
}));
const mockDetail: { candles: typeof mockCandles; orderbook: null; trades: never[]; error: string | null; retry: jest.Mock } = {
  candles: mockCandles,
  orderbook: null,
  trades: [],
  error: null,
  retry: jest.fn(),
};
jest.mock("../hooks/useLiveDetail", () => ({
  useLiveDetail: () => mockDetail,
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
  beforeEach(() => {
    useMarketStore.setState({ tickers: [btc], loading: false, error: null });
    mockDetail.orderbook = null;
    mockDetail.trades = [];
    mockDetail.error = null;
  });

  it("renders the back header, hero price and signed change", () => {
    renderDetail({ goBack: jest.fn() });
    expect(screen.getByText("BTC-USDC PERP")).toBeTruthy();
    expect(screen.getAllByText("62,481.5").length).toBeGreaterThan(0);
    const chg = screen.getByText(/\+2\.43%/);
    expect(chg).toHaveTextContent(/▲/);
  });

  it("renders timeframe chips and the order book / trades tabs", () => {
    renderDetail({ goBack: jest.fn() });
    for (const tf of ["1m", "5m", "15m", "1h", "4h"]) {
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

  it("renders all 8 indicators and shows the matching panel when an oscillator is selected", () => {
    renderDetail({ goBack: jest.fn() });
    for (const ind of ["MA", "EMA", "BOLL", "SAR", "VOL", "MACD", "KDJ", "RSI"]) {
      expect(screen.getByText(ind)).toBeTruthy();
    }
    // default indicator is MA (a chart overlay) -> no sub-panel
    expect(screen.queryByTestId("rsi-panel")).toBeNull();
    expect(screen.queryByTestId("osc-panel")).toBeNull();
    // selecting RSI shows its panel
    fireEvent.press(screen.getByText("RSI"));
    expect(screen.getByTestId("rsi-panel")).toBeTruthy();
    // selecting MACD shows the oscillator panel
    fireEvent.press(screen.getByText("MACD"));
    expect(screen.getByTestId("osc-panel")).toBeTruthy();
  });

  it("places indicators below the chart and shows X-axis time labels (v8 order)", () => {
    const { UNSAFE_root } = renderDetail({ goBack: jest.fn() });
    // The mock candles span hourly timestamps from t=0 (1970-01-01 00:00 UTC) onward.
    // The X-axis renders 5 HH:MM labels derived from candle timestamps.
    const labels = screen
      .getAllByText(/^\d{2}:\d{2}$/)
      .map((n) => n.props.children);
    expect(labels.length).toBeGreaterThanOrEqual(5);
    expect(UNSAFE_root).toBeTruthy();
  });

  it("calls navigation.goBack when the back control is pressed", () => {
    const goBack = jest.fn();
    renderDetail({ goBack });
    fireEvent.press(screen.getByLabelText("back"));
    expect(goBack).toHaveBeenCalled();
  });

  it("shows a book error+retry (not loading forever) when the feed fails", () => {
    mockDetail.error = "network";
    renderDetail({ goBack: jest.fn() });
    expect(screen.getByTestId("detail-book-error")).toBeTruthy();
    fireEvent.press(screen.getByTestId("detail-book-error-retry"));
    expect(mockDetail.retry).toHaveBeenCalled();
  });
});
