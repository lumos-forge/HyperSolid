import React from "react";
import { Alert } from "react-native";
import { render, screen, waitFor, fireEvent } from "@testing-library/react-native";
import { AccountScreen } from "./AccountScreen";
import { useWalletStore } from "../state/walletStore";
import { useEnvStore } from "../state/envStore";
import { useLocaleStore } from "../state/localeStore";
import { useRuntimeConfigStore } from "../state/runtimeConfigStore";
import type { PositionsService } from "../services/positionsData";
import type { FundingsService } from "../services/fundingsData";
import type { WalletManager } from "../wallet/walletManager";
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
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn(async () => true) }));
import * as Clipboard from "expo-clipboard";

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
    useLocaleStore.setState({ locale: "en" });
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
    expect(screen.getByText("Set up your wallet")).toBeTruthy();
    expect(screen.getByText("Create local wallet")).toBeTruthy();
    expect(screen.getByText("Restore wallet")).toBeTruthy();
    expect(screen.getByText("Enter view-only")).toBeTruthy();
    expect(screen.getByPlaceholderText("12-word recovery phrase")).toBeTruthy();
    // Plain-language explainers for each choice (onboarding clarity).
    expect(screen.getByText(/sole custodian/)).toBeTruthy();
    expect(screen.getByText(/no keys, can't trade/)).toBeTruthy();
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

  it("reveals the recovery phrase via Export & backup (biometric-gated read)", async () => {
    const phrase = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    const manager = { exportMnemonic: jest.fn(async () => phrase) } as unknown as WalletManager;
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: ADDR });
    render(<AccountScreen deps={{ ...fakeDeps, manager }} />);
    expect(screen.queryByText(phrase)).toBeNull();
    fireEvent.press(screen.getByText("Export & backup"));
    await waitFor(() => expect(screen.getByText(phrase)).toBeTruthy());
    expect(manager.exportMnemonic).toHaveBeenCalled();
    expect(screen.getByText("I've backed it up safely")).toBeTruthy();
  });

  it("surfaces a failure (and reveals nothing) when export is denied", async () => {
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const manager = { exportMnemonic: jest.fn(async () => { throw new Error("cancelled"); }) } as unknown as WalletManager;
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: ADDR });
    render(<AccountScreen deps={{ ...fakeDeps, manager }} />);
    fireEvent.press(screen.getByText("Export & backup"));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("Export failed", expect.any(String)));
    expect(screen.queryByText("I've backed it up safely")).toBeNull();
    alertSpy.mockRestore();
  });

  it("hides Export & backup for a view-only wallet", () => {
    useWalletStore.setState({ mode: "viewOnly", wallet: null, address: ADDR });
    render(<AccountScreen deps={fakeDeps} />);
    expect(screen.queryByText("Export & backup")).toBeNull();
  });

  it("shows a copyable wallet address with funding guidance in the deposit sheet", async () => {
    (Clipboard.setStringAsync as jest.Mock).mockClear();
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: ADDR });
    render(<AccountScreen deps={fakeDeps} />);
    fireEvent.press(screen.getByText("Deposit"));
    expect(screen.getByText("Fund this wallet first")).toBeTruthy();
    expect(screen.getByText(ADDR)).toBeTruthy();
    expect(screen.getByText("Copy")).toBeTruthy();
    fireEvent.press(screen.getByTestId("copy-address"));
    await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledWith(ADDR));
    await waitFor(() => expect(screen.getByText("Copied")).toBeTruthy());
  });

  it("nudges an unfunded wallet to deposit", async () => {
    const unfunded = {
      summary: { accountValue: 0, totalNtlPos: 0, totalMarginUsed: 0, withdrawable: 0, totalUnrealizedPnl: 0 },
      positions: [],
    };
    const deps = {
      positions: { loadPortfolio: jest.fn(async () => unfunded) },
      fundings: { load: jest.fn(async () => []) },
    } as unknown as typeof fakeDeps;
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: ADDR });
    render(<AccountScreen deps={deps} />);
    await waitFor(() => expect(screen.getByTestId("fund-nudge")).toBeTruthy());
    fireEvent.press(screen.getByTestId("fund-nudge"));
    await waitFor(() => expect(screen.getByTestId("deposit-panel")).toBeTruthy());
  });

  it("hides the fund nudge once the wallet has a balance", async () => {
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: ADDR });
    render(<AccountScreen deps={fakeDeps} />);
    await waitFor(() => expect(fakeDeps.positions.loadPortfolio).toHaveBeenCalled());
    expect(screen.queryByTestId("fund-nudge")).toBeNull();
  });

  it("offers a Start trading CTA that jumps to Trade once the wallet is funded", async () => {
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: ADDR });
    const navigate = jest.fn();
    render(<AccountScreen deps={fakeDeps} navigation={{ navigate }} />);
    await waitFor(() => expect(screen.getByTestId("start-trading-cta")).toBeTruthy());
    fireEvent.press(screen.getByTestId("start-trading-cta"));
    expect(navigate).toHaveBeenCalledWith("Trade");
  });

  it("refreshes the balance on demand (re-fetches the portfolio)", async () => {
    const load = jest.fn(async () => portfolio);
    const deps = {
      positions: { loadPortfolio: load },
      fundings: { load: jest.fn(async () => []) },
    } as unknown as typeof fakeDeps;
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: ADDR });
    render(<AccountScreen deps={deps} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    fireEvent.press(screen.getByTestId("refresh-balance"));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it("requires backup verification after creating a wallet (not a one-tap dismiss)", async () => {
    const phrase = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    const manager = {
      createWallet: jest.fn(async () => ({ mnemonic: phrase, wallet: { getAddress: () => ADDR } })),
    } as unknown as WalletManager;
    useWalletStore.setState({ mode: "none", wallet: null, address: null });
    render(<AccountScreen deps={{ ...fakeDeps, manager }} />);
    fireEvent.press(screen.getByText("Create local wallet"));
    await waitFor(() => expect(screen.getByText(phrase)).toBeTruthy());
    expect(screen.getByText("Continue")).toBeTruthy();
    expect(screen.queryByText("I've backed it up safely")).toBeNull();
    fireEvent.press(screen.getByText("Continue"));
    expect(screen.getByText("Confirm your backup")).toBeTruthy();
    // Escape hatch: a user who didn't memorize can return to see the phrase again.
    fireEvent.press(screen.getByTestId("verify-back"));
    expect(screen.getByText(phrase)).toBeTruthy();
    expect(screen.getByText("Continue")).toBeTruthy();
  });

  it("shows a Language row that toggles the locale (en <-> zh)", () => {
    useLocaleStore.setState({ locale: "en" });
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: ADDR });
    render(<AccountScreen deps={fakeDeps} />);
    expect(screen.getByText("Language")).toBeTruthy();
    expect(screen.getByText("English")).toBeTruthy();
    fireEvent.press(screen.getByText("English"));
    expect(screen.getByText("中文")).toBeTruthy();
    expect(useLocaleStore.getState().locale).toBe("zh");
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
