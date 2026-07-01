import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { TradeActivityPanel } from "./TradeActivityPanel";
import { themes } from "../theme/tokens";

const mockLoadPortfolio = jest.fn();
const mockLoadOpenOrders = jest.fn();
const mockLoadRecent = jest.fn();
const mockLoadFunding = jest.fn();

jest.mock("../lib/hyperliquid/client", () => ({
  createPositionsInfoClient: jest.fn(() => ({})),
  createOrdersInfoClient: jest.fn(() => ({})),
  createFillsInfoClient: jest.fn(() => ({})),
  createFundingsInfoClient: jest.fn(() => ({})),
}));
jest.mock("../services/positionsData", () => ({ PositionsService: class { loadPortfolio = mockLoadPortfolio; } }));
jest.mock("../services/ordersData", () => ({ OrdersService: class { loadOpenOrders = mockLoadOpenOrders; } }));
jest.mock("../services/fillsData", () => ({ FillsService: class { loadRecent = mockLoadRecent; } }));
jest.mock("../services/fundingsData", () => ({ FundingsService: class { load = mockLoadFunding; } }));

const ADDR = "0x" + "a".repeat(40);
const t = themes.electrum;

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadPortfolio.mockResolvedValue({ summary: { accountValue: 1000, withdrawable: 800, totalNtlPos: 0, totalMarginUsed: 0, totalUnrealizedPnl: 0 }, positions: [] });
  mockLoadOpenOrders.mockResolvedValue([]);
  mockLoadRecent.mockResolvedValue([]);
  mockLoadFunding.mockResolvedValue([]);
});

describe("TradeActivityPanel", () => {
  it("loads the wallet's data and shows the positions tab by default", async () => {
    render(<TradeActivityPanel theme={t} address={ADDR} network="mainnet" />);
    await waitFor(() => expect(mockLoadPortfolio).toHaveBeenCalledWith(ADDR));
    expect(screen.getByText(/No open positions/)).toBeTruthy();
  });

  it("shows a compact retry when the portfolio load fails, then recovers", async () => {
    const httpErr = new Error("Unknown HTTP request error: down");
    httpErr.name = "HttpRequestError";
    mockLoadPortfolio.mockRejectedValueOnce(httpErr);
    render(<TradeActivityPanel theme={t} address={ADDR} network="mainnet" />);
    await waitFor(() => expect(screen.getByTestId("activity-error")).toBeTruthy());
    fireEvent.press(screen.getByTestId("activity-error-retry"));
    await waitFor(() => expect(screen.queryByTestId("activity-error")).toBeNull());
  });

  it("switches to the Balance tab and shows perp equity", async () => {
    render(<TradeActivityPanel theme={t} address={ADDR} network="mainnet" />);
    await waitFor(() => expect(mockLoadPortfolio).toHaveBeenCalled());
    fireEvent.press(screen.getByTestId("activity-tab-balance"));
    expect(screen.getByText("1000.00 USDC")).toBeTruthy();
    expect(screen.getByText("800.00 USDC")).toBeTruthy();
  });

  it("shows the TWAP empty state", async () => {
    render(<TradeActivityPanel theme={t} address={ADDR} network="mainnet" />);
    fireEvent.press(screen.getByTestId("activity-tab-twap"));
    expect(screen.getByText(/No active TWAP/)).toBeTruthy();
  });

  it("does not query without a wallet address", () => {
    render(<TradeActivityPanel theme={t} address={null} network="mainnet" />);
    expect(mockLoadPortfolio).not.toHaveBeenCalled();
  });
});
