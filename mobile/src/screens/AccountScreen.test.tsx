import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react-native";
import { AccountScreen } from "./AccountScreen";
import { useWalletStore } from "../state/walletStore";
import { useEnvStore } from "../state/envStore";
import { useRuntimeConfigStore } from "../state/runtimeConfigStore";
import type { PositionsService } from "../services/positionsData";
import type { FundingsService } from "../services/fundingsData";
import type { PortfolioSnapshot, FundingEvent } from "../lib/hyperliquid/types";

const mockWithdraw = jest.fn(async () => ({ ok: true }));
const mockDeposit = jest.fn(async () => ({ ok: true, txHash: "0xdeadbeefcafe" }));
jest.mock("../lib/hyperliquid/client", () => ({
  createPositionsInfoClient: jest.fn(() => ({})),
  createFundingsInfoClient: jest.fn(() => ({})),
  createExchangeClient: jest.fn(() => ({})),
}));
const mockBalances = jest.fn(async () => ({ usdc: 500, eth: 0.01 }));
jest.mock("../lib/arbitrum/client", () => ({
  createArbitrumDepositClient: jest.fn(() => ({})),
  fetchArbitrumBalances: (...args: unknown[]) => mockBalances(...(args as [])),
}));
jest.mock("../services/exchange", () => ({
  ExchangeService: jest.fn().mockImplementation(() => ({ withdrawUsdc: mockWithdraw })),
}));
jest.mock("../services/deposit", () => ({
  DepositService: jest.fn().mockImplementation(() => ({ depositUsdc: mockDeposit })),
}));

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
    mockWithdraw.mockClear();
    mockDeposit.mockClear();
    mockBalances.mockClear();
    mockBalances.mockResolvedValue({ usdc: 500, eth: 0.01 });
    useRuntimeConfigStore.setState({
      arbitrumRpc: { mainnet: "https://arb-mainnet/key", testnet: "https://arb-testnet/key" },
      withdrawFeeUsdc: { mainnet: null, testnet: null },
    });
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

  it("opens the deposit form, shows balances, and enforces a mainnet two-step confirmation", async () => {
    // mainnet (set in beforeEach): first press reviews, second press sends.
    const localWallet = { getViemAccount: () => ({}), getAddress: () => ADDR } as never;
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: ADDR });
    render(<AccountScreen deps={fakeDeps} />);
    fireEvent.press(screen.getByText("Deposit"));
    expect(screen.getByTestId("deposit-panel")).toBeTruthy();
    // balances loaded from the (mocked) Arbitrum read
    await waitFor(() => expect(screen.getByTestId("deposit-available")).toHaveTextContent(/500\.00 USDC/));
    fireEvent.changeText(screen.getByTestId("deposit-amount"), "10");

    // first confirm = review (no send yet)
    fireEvent.press(screen.getByTestId("deposit-confirm"));
    expect(mockDeposit).not.toHaveBeenCalled();
    expect(screen.getByTestId("deposit-mainnet-confirm")).toBeTruthy();

    // second confirm = sign + send, confirmed=true, available passed for the balance check
    fireEvent.press(screen.getByTestId("deposit-confirm"));
    await waitFor(() => expect(mockDeposit).toHaveBeenCalled());
    expect(mockDeposit).toHaveBeenCalledWith({ amount: 10, available: 500, confirmed: true });
  });

  it("warns when the wallet has too little ETH for gas", async () => {
    mockBalances.mockResolvedValue({ usdc: 500, eth: 0 });
    const localWallet = { getViemAccount: () => ({}), getAddress: () => ADDR } as never;
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: ADDR });
    render(<AccountScreen deps={fakeDeps} />);
    fireEvent.press(screen.getByText("Deposit"));
    await waitFor(() => expect(screen.getByTestId("deposit-gas-warning")).toBeTruthy());
  });

  it("deposits in one step on testnet (no second confirmation)", async () => {
    useEnvStore.setState({ network: "testnet" });
    const localWallet = { getViemAccount: () => ({}), getAddress: () => ADDR } as never;
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: ADDR });
    render(<AccountScreen deps={fakeDeps} />);
    fireEvent.press(screen.getByText("Deposit"));
    await waitFor(() => expect(screen.getByTestId("deposit-available")).toBeTruthy());
    fireEvent.changeText(screen.getByTestId("deposit-amount"), "5");
    fireEvent.press(screen.getByTestId("deposit-confirm"));
    await waitFor(() => expect(mockDeposit).toHaveBeenCalledWith({ amount: 5, available: 500, confirmed: false }));
  });

  it("blocks deposit until the server delivers the Arbitrum RPC", async () => {
    useEnvStore.setState({ network: "testnet" });
    useRuntimeConfigStore.setState({ arbitrumRpc: { mainnet: null, testnet: null } });
    const localWallet = { getViemAccount: () => ({}), getAddress: () => ADDR } as never;
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: ADDR });
    render(<AccountScreen deps={fakeDeps} />);
    fireEvent.press(screen.getByText("Deposit"));
    fireEvent.changeText(screen.getByTestId("deposit-amount"), "5");
    fireEvent.press(screen.getByTestId("deposit-confirm"));
    expect(mockDeposit).not.toHaveBeenCalled();
  });

  it("withdraws via the service after the mainnet two-step confirm, showing fee + net", async () => {
    const localWallet = { getViemAccount: () => ({}), getAddress: () => ADDR } as never;
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: ADDR });
    render(<AccountScreen deps={fakeDeps} />);
    await waitFor(() => expect(fakeDeps.positions.loadPortfolio).toHaveBeenCalled());
    fireEvent.press(screen.getByText("Withdraw"));
    fireEvent.changeText(screen.getByTestId("withdraw-amount"), "100");
    // fee line: default 1 USDC fee -> receive ~99
    expect(screen.getByTestId("withdraw-fee")).toHaveTextContent(/Fee 1 USDC/);
    expect(screen.getByTestId("withdraw-fee")).toHaveTextContent(/99\.00 USDC/);

    // mainnet first press = review (no service call)
    fireEvent.press(screen.getByTestId("withdraw-confirm"));
    expect(mockWithdraw).not.toHaveBeenCalled();
    expect(screen.getByTestId("withdraw-mainnet-confirm")).toBeTruthy();

    // second press = sign
    fireEvent.press(screen.getByTestId("withdraw-confirm"));
    await waitFor(() => expect(mockWithdraw).toHaveBeenCalled());
    expect(mockWithdraw).toHaveBeenCalledWith({ destination: ADDR, amount: 100, withdrawable: 800 });
  });

  it("does not show deposit/withdraw actions in view-only mode", () => {
    useWalletStore.setState({ mode: "viewOnly", wallet: null, address: ADDR });
    render(<AccountScreen deps={fakeDeps} />);
    expect(screen.queryByText("Deposit")).toBeNull();
    expect(screen.queryByText("Withdraw")).toBeNull();
  });
});
