import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { PositionsScreen } from "./PositionsScreen";
import { useEnvStore } from "../state/envStore";
import { useWalletStore } from "../state/walletStore";
import { useLedgerStore } from "../state/ledgerStore";
import { IntentLedger } from "../lib/hyperliquid/intentLedger";
import type { PositionsService } from "../services/positionsData";
import type { FillsService } from "../services/fillsData";
import type { OrdersService } from "../services/ordersData";
import type { PortfolioSnapshot, Fill, OpenOrder } from "../lib/hyperliquid/types";

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

const fakeDeps = {
  positions: { loadPortfolio: jest.fn(async () => portfolio) } as unknown as PositionsService,
  fills: { loadRecent: jest.fn(async () => fills) } as unknown as FillsService,
  orders: { loadOpenOrders: jest.fn(async () => orders) } as unknown as OrdersService,
};

describe("PositionsScreen", () => {
  beforeEach(() => {
    useEnvStore.setState({ network: "mainnet" });
    useWalletStore.setState({ mode: "none", wallet: null, address: null });
    useLedgerStore.setState({ ledger: null, scope: null, revision: 0 });
  });

  it("renders the v8 chrome, view-only banner and query control", () => {
    render(<PositionsScreen />);
    expect(screen.getByText("Positions")).toBeTruthy();
    expect(screen.getByText(/View-only/)).toBeTruthy();
    expect(screen.getByText("Query")).toBeTruthy();
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

  it("shows a format error for an invalid address without hitting the network", () => {
    render(<PositionsScreen deps={fakeDeps} />);
    fireEvent.changeText(screen.getByPlaceholderText("0x… wallet address"), "not-an-address");
    fireEvent.press(screen.getByText("Query"));
    expect(screen.getByText(/地址格式无效/)).toBeTruthy();
    expect(fakeDeps.positions.loadPortfolio).not.toHaveBeenCalled();
    expect(fakeDeps.fills.loadRecent).not.toHaveBeenCalled();
  });

  it("prefills the connected wallet address (own address, read-only)", () => {
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: ADDR });
    render(<PositionsScreen deps={fakeDeps} />);
    expect(screen.getByDisplayValue(ADDR)).toBeTruthy();
  });

  it("loads positions/fills/orders on query and switches tabs", async () => {
    render(<PositionsScreen deps={fakeDeps} />);
    fireEvent.changeText(screen.getByPlaceholderText("0x… wallet address"), ADDR);
    fireEvent.press(screen.getByText("Query"));

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

  it("offers a Place your first trade CTA when the connected wallet has no positions", async () => {
    const empty = { summary: portfolio.summary, positions: [] };
    const deps = {
      positions: { loadPortfolio: jest.fn(async () => empty) },
      fills: { loadRecent: jest.fn(async () => []) },
      orders: { loadOpenOrders: jest.fn(async () => []) },
    } as unknown as typeof fakeDeps;
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: ADDR });
    const navigate = jest.fn();
    render(<PositionsScreen deps={deps} navigation={{ navigate }} />);
    fireEvent.press(screen.getByText("Query"));
    await waitFor(() => expect(screen.getByTestId("first-trade-cta")).toBeTruthy());
    fireEvent.press(screen.getByTestId("first-trade-cta"));
    expect(navigate).toHaveBeenCalledWith("Trade");
  });

  it("hides the first-trade CTA when viewing someone else's address", async () => {
    const empty = { summary: portfolio.summary, positions: [] };
    const deps = {
      positions: { loadPortfolio: jest.fn(async () => empty) },
      fills: { loadRecent: jest.fn(async () => []) },
      orders: { loadOpenOrders: jest.fn(async () => []) },
    } as unknown as typeof fakeDeps;
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: ADDR });
    render(<PositionsScreen deps={deps} />);
    const other = "0x" + "b".repeat(40);
    fireEvent.changeText(screen.getByPlaceholderText("0x… wallet address"), other);
    fireEvent.press(screen.getByText("Query"));
    await waitFor(() => expect(screen.getByText(/No open positions/)).toBeTruthy());
    expect(screen.queryByTestId("first-trade-cta")).toBeNull();
  });
});
