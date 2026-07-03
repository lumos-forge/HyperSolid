import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";
import { PositionsScreen } from "./PositionsScreen";
import { useEnvStore } from "../state/envStore";
import { useWalletStore } from "../state/walletStore";
import { useMarketStore } from "../state/marketStore";
import { useLedgerStore } from "../state/ledgerStore";
import { IntentLedger } from "../lib/hyperliquid/intentLedger";
import type { PositionsService } from "../services/positionsData";
import type { FillsService } from "../services/fillsData";
import type { OrdersService } from "../services/ordersData";
import type { TwapService } from "../services/twapData";
import type { PortfolioSnapshot, Fill, OpenOrder, MarketTicker } from "../lib/hyperliquid/types";
import type { ActiveTwap } from "../lib/hyperliquid/twap";

const mockPlaceOrder = jest.fn();
const mockCancelOrder = jest.fn();
const mockCancelTwap = jest.fn();
jest.mock("../services/exchange", () => ({
  ExchangeService: jest.fn().mockImplementation(() => ({ placeOrder: mockPlaceOrder, cancelOrder: mockCancelOrder, cancelTwap: mockCancelTwap })),
}));
jest.mock("../lib/hyperliquid/client", () => ({
  createExchangeClient: jest.fn(() => ({})),
  createPositionsInfoClient: jest.fn(() => ({})),
  createFillsInfoClient: jest.fn(() => ({})),
  createOrdersInfoClient: jest.fn(() => ({})),
  createTwapInfoClient: jest.fn(() => ({})),
}));

const localWallet = { getViemAccount: () => ({}), getAddress: () => ADDR };
const ticker = (coin: string, midPx: number): MarketTicker =>
  ({ coin, midPx, szDecimals: 4, maxLeverage: 20 } as MarketTicker);

/** Tap a confirm dialog's second (Confirm) button. */
function confirmAlert() {
  const last = (Alert.alert as jest.Mock).mock.calls.at(-1);
  return last?.[2]?.[1]?.onPress?.();
}

const ADDR = "0x" + "a".repeat(40);

const portfolio: PortfolioSnapshot = {
  summary: { accountValue: 1000, totalNtlPos: 500, totalMarginUsed: 100, withdrawable: 800, totalUnrealizedPnl: 50 },
  positions: [
    { coin: "BTC", size: 0.5, side: "long", entryPx: 60000, positionValue: 31000, unrealizedPnl: 50, liquidationPx: 45000, marginUsed: 60, leverage: 10 },
  ],
};
const fills: Fill[] = [
  { coin: "ETH", px: 3000, sz: 1, side: "buy", time: 1000, closedPnl: 0, dir: "Open Long", fee: 0.3, builderFee: 0, feeToken: "USDC", oid: 1, tid: 9, hash: "0x", crossed: true },
];
const orders: OpenOrder[] = [
  { coin: "SOL", side: "sell", limitPx: 200, sz: 2, origSz: 2, oid: 7, timestamp: 1000, cloid: null, reduceOnly: false },
];
const activeTwaps: ActiveTwap[] = [
  { twapId: 7, coin: "BTC", side: "buy", sz: 1, executedSz: 0.4, executedNtl: 24000, minutes: 30, reduceOnly: false, startedAt: 1000 },
];

const fakeDeps = {
  positions: { loadPortfolio: jest.fn(async () => portfolio) } as unknown as PositionsService,
  fills: { loadRecent: jest.fn(async () => fills) } as unknown as FillsService,
  orders: { loadOpenOrders: jest.fn(async () => orders) } as unknown as OrdersService,
  twap: { loadActive: jest.fn(async () => activeTwaps) } as unknown as TwapService,
};

describe("PositionsScreen", () => {
  beforeEach(() => {
    useEnvStore.setState({ network: "mainnet" });
    useWalletStore.setState({ mode: "local", wallet: null, address: null });
    useMarketStore.setState({ tickers: [ticker("BTC", 60000), ticker("SOL", 200)], loading: false, error: null });
    useLedgerStore.setState({ ledger: null, scope: null, revision: 0 });
    mockPlaceOrder.mockReset();
    mockCancelOrder.mockReset();
    mockCancelTwap.mockReset();
    jest.spyOn(Alert, "alert").mockClear();
    (fakeDeps.positions.loadPortfolio as jest.Mock).mockClear();
    (fakeDeps.fills.loadRecent as jest.Mock).mockClear();
    (fakeDeps.orders.loadOpenOrders as jest.Mock).mockClear();
    (fakeDeps.twap.loadActive as jest.Mock).mockClear();
  });

  it("shows a friendly network error with a Retry (no raw SDK string) and retries on tap", async () => {
    const httpErr = new Error("Unknown HTTP request error: TypeError: Network request failed");
    httpErr.name = "HttpRequestError";
    const loadPortfolio = jest
      .fn()
      .mockRejectedValueOnce(httpErr)
      .mockResolvedValueOnce(portfolio);
    const deps = {
      positions: { loadPortfolio } as unknown as PositionsService,
      fills: { loadRecent: jest.fn(async () => []) } as unknown as FillsService,
      orders: { loadOpenOrders: jest.fn(async () => []) } as unknown as OrdersService,
      twap: { loadActive: jest.fn(async () => []) } as unknown as TwapService,
    };
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: ADDR });
    render(<PositionsScreen deps={deps} />);
    await waitFor(() => expect(screen.getByTestId("positions-error")).toBeTruthy());
    expect(screen.getByText("Can't reach the venue")).toBeTruthy();
    expect(screen.queryByText(/Unknown HTTP request error/)).toBeNull();
    fireEvent.press(screen.getByTestId("positions-error-retry"));
    await waitFor(() => expect(screen.getByText(/BTC/)).toBeTruthy());
  });

  it("gates with a Set up wallet CTA and does not query when there is no wallet", () => {
    useWalletStore.setState({ mode: "none", wallet: null, address: null });
    const navigate = jest.fn();
    render(<PositionsScreen deps={fakeDeps} navigation={{ navigate }} />);
    expect(fakeDeps.positions.loadPortfolio).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId("gated-setup-wallet"));
    expect(navigate).toHaveBeenCalledWith("Account");
  });

  it("auto-loads the connected wallet's positions on mount (no manual Query)", async () => {
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: ADDR });
    render(<PositionsScreen deps={fakeDeps} />);
    await waitFor(() => expect(fakeDeps.positions.loadPortfolio).toHaveBeenCalledWith(ADDR));
  });

  it("renders the v8 chrome without any view-only address entry", async () => {
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: ADDR });
    render(<PositionsScreen deps={fakeDeps} />);
    expect(screen.queryByText("Query")).toBeNull();
    expect(screen.queryByText(/View-only/)).toBeNull();
    await waitFor(() => expect(fakeDeps.positions.loadPortfolio).toHaveBeenCalledWith(ADDR));
  });

  it("surfaces unconfirmed intents from the persistent ledger as a disclosure-only banner", () => {
    const ledger = new IntentLedger();
    const a = ledger.open({ coin: "BTC", side: "buy", size: 0.01, price: 60000 });
    ledger.markSubmitted(a.cloid);
    useLedgerStore.setState({ ledger, scope: "0xabc:mainnet", revision: 1 });
    render(<PositionsScreen deps={fakeDeps} />);
    expect(screen.getByTestId("unconfirmed-banner")).toBeTruthy();
    expect(screen.getByText(/1 unconfirmed/)).toBeTruthy();
    expect(screen.queryByTestId("unconfirmed-review")).toBeNull();
  });

  it("auto-loads positions/fills/orders and switches tabs", async () => {
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: ADDR });
    render(<PositionsScreen deps={fakeDeps} />);

    // positions tab (default) shows the position + summary
    await waitFor(() => expect(screen.getByText(/BTC/)).toBeTruthy());
    expect(fakeDeps.fills.loadRecent).toHaveBeenCalledWith(ADDR);
    expect(fakeDeps.orders.loadOpenOrders).toHaveBeenCalledWith(ADDR);

    // switch to History (trade fills)
    fireEvent.press(screen.getByText(/History/));
    expect(screen.getByText(/ETH/)).toBeTruthy();

    // switch to Orders
    fireEvent.press(screen.getByText(/Orders/));
    expect(screen.getByText(/Filled 2\/2/)).toBeTruthy();
  });

  it("Close places a full-size reduce-only market order opposite a long, after confirm", async () => {
    mockPlaceOrder.mockResolvedValue({ ok: true, cloid: ("0x" + "d".repeat(32)) as `0x${string}` });
    useWalletStore.setState({ mode: "local", wallet: localWallet as never, address: ADDR });
    render(<PositionsScreen deps={fakeDeps} />);
    await waitFor(() => expect(screen.getByTestId("close-BTC")).toBeTruthy());
    fireEvent.press(screen.getByTestId("close-BTC"));
    await confirmAlert();
    expect(mockPlaceOrder).toHaveBeenCalledWith(
      expect.objectContaining({ coin: "BTC", side: "sell", size: 0.5, reduceOnly: true, market: true, price: 57000 }),
    );
  });

  it("Reduce 50% places a half-size reduce-only market order", async () => {
    mockPlaceOrder.mockResolvedValue({ ok: true, cloid: ("0x" + "d".repeat(32)) as `0x${string}` });
    useWalletStore.setState({ mode: "local", wallet: localWallet as never, address: ADDR });
    render(<PositionsScreen deps={fakeDeps} />);
    await waitFor(() => expect(screen.getByTestId("reduce-BTC-50")).toBeTruthy());
    fireEvent.press(screen.getByTestId("reduce-BTC-50"));
    await confirmAlert();
    expect(mockPlaceOrder).toHaveBeenCalledWith(expect.objectContaining({ side: "sell", size: 0.25, reduceOnly: true, market: true }));
  });

  it("treats an uncertain close receipt as uncertain, not a failure", async () => {
    mockPlaceOrder.mockResolvedValue({ ok: false, uncertain: true, error: "timeout" });
    (Alert.alert as jest.Mock).mockClear();
    useWalletStore.setState({ mode: "local", wallet: localWallet as never, address: ADDR });
    render(<PositionsScreen deps={fakeDeps} />);
    await waitFor(() => expect(screen.getByTestId("close-BTC")).toBeTruthy());
    fireEvent.press(screen.getByTestId("close-BTC"));
    await confirmAlert();
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith("Uncertain receipt", expect.stringContaining("may or may not")));
    expect(Alert.alert).not.toHaveBeenCalledWith("Close failed", expect.anything());
  });

  it("does not crash when the close order throws synchronously (shows failure alert)", async () => {
    mockPlaceOrder.mockImplementation(() => { throw new Error("client boom"); });
    (Alert.alert as jest.Mock).mockClear();
    useWalletStore.setState({ mode: "local", wallet: localWallet as never, address: ADDR });
    render(<PositionsScreen deps={fakeDeps} />);
    await waitFor(() => expect(screen.getByTestId("close-BTC")).toBeTruthy());
    fireEvent.press(screen.getByTestId("close-BTC"));
    await confirmAlert();
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith("Close failed", expect.stringContaining("client boom")));
  });

  it("does not place a market close until the user confirms", async () => {
    useWalletStore.setState({ mode: "local", wallet: localWallet as never, address: ADDR });
    render(<PositionsScreen deps={fakeDeps} />);
    await waitFor(() => expect(screen.getByTestId("close-BTC")).toBeTruthy());
    fireEvent.press(screen.getByTestId("close-BTC"));
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it("exposes a cancel control that cancels the order on confirm", async () => {
    mockCancelOrder.mockResolvedValue({ ok: true, cloid: "0x" as `0x${string}` });
    useWalletStore.setState({ mode: "local", wallet: localWallet as never, address: ADDR });
    render(<PositionsScreen deps={fakeDeps} />);
    await waitFor(() => expect(screen.getByText(/Orders/)).toBeTruthy());
    fireEvent.press(screen.getByText(/Orders/));
    fireEvent.press(screen.getByTestId("cancel-7"));
    await confirmAlert();
    expect(mockCancelOrder).toHaveBeenCalledWith("SOL", 7);
  });

  it("offers a Place your first trade CTA when the connected local wallet has no positions", async () => {
    const empty = { summary: portfolio.summary, positions: [] };
    const deps = {
      positions: { loadPortfolio: jest.fn(async () => empty) },
      fills: { loadRecent: jest.fn(async () => []) },
      orders: { loadOpenOrders: jest.fn(async () => []) },
      twap: { loadActive: jest.fn(async () => []) },
    } as unknown as typeof fakeDeps;
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: ADDR });
    const navigate = jest.fn();
    render(<PositionsScreen deps={deps} navigation={{ navigate }} />);
    await waitFor(() => expect(screen.getByTestId("first-trade-cta")).toBeTruthy());
    fireEvent.press(screen.getByTestId("first-trade-cta"));
    expect(navigate).toHaveBeenCalledWith("Trade");
  });

  it("hides the first-trade CTA in view-only mode", async () => {
    const empty = { summary: portfolio.summary, positions: [] };
    const deps = {
      positions: { loadPortfolio: jest.fn(async () => empty) },
      fills: { loadRecent: jest.fn(async () => []) },
      orders: { loadOpenOrders: jest.fn(async () => []) },
      twap: { loadActive: jest.fn(async () => []) },
    } as unknown as typeof fakeDeps;
    useWalletStore.setState({ mode: "viewOnly", wallet: null, address: ADDR });
    render(<PositionsScreen deps={deps} />);
    await waitFor(() => expect(screen.getByText(/No open positions/)).toBeTruthy());
    expect(screen.queryByTestId("first-trade-cta")).toBeNull();
  });

  it("shows active TWAPs on the TWAP tab", async () => {
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: ADDR });
    render(<PositionsScreen deps={fakeDeps} />);
    await waitFor(() => expect(screen.getByText("TWAP")).toBeTruthy());
    fireEvent.press(screen.getByText("TWAP"));
    expect(await screen.findByTestId("twap-7")).toBeTruthy();
  });

  it("cancels a TWAP after confirmation", async () => {
    mockCancelTwap.mockResolvedValueOnce({ ok: true });
    useWalletStore.setState({ mode: "local", wallet: localWallet as never, address: ADDR });
    render(<PositionsScreen deps={fakeDeps} />);
    await waitFor(() => expect(screen.getByText("TWAP")).toBeTruthy());
    fireEvent.press(screen.getByText("TWAP"));
    fireEvent.press(await screen.findByTestId("twap-cancel-7"));
    await confirmAlert();
    await waitFor(() => expect(mockCancelTwap).toHaveBeenCalledWith("BTC", 7));
  });
});
