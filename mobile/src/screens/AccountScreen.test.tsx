import React from "react";
import { render, screen, waitFor } from "@testing-library/react-native";
import { AccountScreen } from "./AccountScreen";
import { useWalletStore } from "../state/walletStore";
import { useEnvStore } from "../state/envStore";
import type { PositionsService } from "../services/positionsData";
import type { FundingsService } from "../services/fundingsData";
import type { PortfolioSnapshot, FundingEvent } from "../lib/hyperliquid/types";

const ADDR = "0x7f3aabcdef0123456789abcdefabcdef0123c2e9";

const portfolio: PortfolioSnapshot = {
  summary: { accountValue: 1000, totalNtlPos: 500, totalMarginUsed: 100, withdrawable: 800, totalUnrealizedPnl: 50 },
  positions: [],
};
const fundingEvents: FundingEvent[] = [
  { coin: "BTC", time: 200, usdc: -0.25, szi: 0.01, fundingRate: 0.0000125, hash: "0x" },
  { coin: "ETH", time: 100, usdc: 0.1, szi: 1, fundingRate: 0.00001, hash: "0x" },
];

const fakeDeps = {
  positions: { loadPortfolio: jest.fn(async () => portfolio) } as unknown as PositionsService,
  fundings: { load: jest.fn(async () => fundingEvents) } as unknown as FundingsService,
};

describe("AccountScreen", () => {
  beforeEach(() => {
    useEnvStore.setState({ network: "mainnet" });
    useWalletStore.setState({ mode: "none", wallet: null, address: null });
    fakeDeps.positions.loadPortfolio = jest.fn(async () => portfolio);
    fakeDeps.fundings.load = jest.fn(async () => fundingEvents);
  });

  it("renders the onboarding state with create / restore / view-only actions", () => {
    render(<AccountScreen />);
    expect(screen.getByText("Wallet")).toBeTruthy();
    expect(screen.getByText("Welcome to HyperSolid")).toBeTruthy();
    expect(screen.getByText("Create local wallet")).toBeTruthy();
    expect(screen.getByText("Restore wallet")).toBeTruthy();
    expect(screen.getByText("Enter view-only")).toBeTruthy();
    expect(screen.getByPlaceholderText("12-word recovery phrase")).toBeTruthy();
  });

  it("renders the connected state with wallet card, deposit/withdraw and sign-out", () => {
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: ADDR });
    render(<AccountScreen deps={fakeDeps} />);
    expect(screen.getByText("Local wallet")).toBeTruthy();
    expect(screen.getByText("Non-custodial")).toBeTruthy();
    expect(screen.getByText("Deposit")).toBeTruthy();
    expect(screen.getByText("Withdraw")).toBeTruthy();
    expect(screen.getByText("Sign out / switch wallet")).toBeTruthy();
    expect(screen.getByText("Network")).toBeTruthy();
  });

  it("labels the view-only connected state correctly", () => {
    useWalletStore.setState({ mode: "viewOnly", wallet: null, address: "0xabc" });
    render(<AccountScreen deps={fakeDeps} />);
    expect(screen.getByText("View-only")).toBeTruthy();
  });

  it("loads + shows account summary (margin ratio) and funding total for a connected wallet", async () => {
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: ADDR });
    render(<AccountScreen deps={fakeDeps} />);
    await waitFor(() => expect(fakeDeps.positions.loadPortfolio).toHaveBeenCalledWith(ADDR));
    expect(screen.getByText("Account summary")).toBeTruthy();
    expect(screen.getByText("Margin ratio")).toBeTruthy();
    expect(screen.getByText(/10\.0%/)).toBeTruthy(); // 100 / 1000
    expect(screen.getByText("Funding")).toBeTruthy();
    expect(screen.getByText(/-0\.15/)).toBeTruthy(); // total -0.25 + 0.10
  });

  it("does not load for an invalid address (view-only 0xabc)", () => {
    useWalletStore.setState({ mode: "viewOnly", wallet: null, address: "0xabc" });
    render(<AccountScreen deps={fakeDeps} />);
    expect(fakeDeps.positions.loadPortfolio).not.toHaveBeenCalled();
  });
});
