import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { AgentScreen } from "./AgentScreen";
import { useWalletStore } from "../state/walletStore";
import { useEnvStore } from "../state/envStore";
import { useRuntimeConfigStore } from "../state/runtimeConfigStore";

const AGENT = "0x" + "9".repeat(40);

const mockApiFake = {
  challenge: jest.fn(async () => ({ nonce: "n" })),
  session: jest.fn(async () => ({ token: "tok" })),
  agentStatus: jest.fn(async () => ({ approved: false })),
  provisionAgent: jest.fn(async () => ({ agentAddress: AGENT })),
  confirmAgent: jest.fn(async () => undefined),
  revokeAgent: jest.fn(async () => undefined),
  listStrategies: jest.fn(async () => [] as unknown[]),
  createStrategy: jest.fn(async () => ({ id: "s1", type: "dca", params: {}, status: "running" })),
  setStrategyStatus: jest.fn(async () => ({ id: "s1", type: "dca", params: {}, status: "paused" })),
  killSwitch: jest.fn(async () => undefined),
  getRecentActivity: jest.fn(async () => [] as unknown[]),
};
const mockApproveAgent = jest.fn(async () => ({ ok: true as const }));
const mockOpenSession = jest.fn(async () => "tok");

jest.mock("../services/strategyApi", () => ({ StrategyApi: jest.fn().mockImplementation(() => mockApiFake) }));
jest.mock("../wallet/walletSession", () => ({ openStrategySession: (...a: unknown[]) => mockOpenSession(...(a as [])) }));
jest.mock("../services/exchange", () => ({
  ExchangeService: jest.fn().mockImplementation(() => ({ approveAgent: mockApproveAgent })),
}));
jest.mock("../lib/hyperliquid/client", () => ({ createExchangeClient: jest.fn(() => ({})) }));

const localWallet = { getViemAccount: () => ({ signMessage: jest.fn() }), getAddress: () => AGENT } as never;

describe("AgentScreen", () => {
  beforeEach(() => {
    Object.values(mockApiFake).forEach((f) => f.mockClear?.());
    mockApproveAgent.mockClear();
    mockOpenSession.mockClear();
    mockApiFake.agentStatus.mockResolvedValue({ approved: false });
    mockApiFake.listStrategies.mockResolvedValue([]);
    mockApiFake.getRecentActivity.mockResolvedValue([]);
    useEnvStore.setState({ network: "testnet" });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: AGENT });
    useRuntimeConfigStore.setState({
      arbitrumRpc: { mainnet: null, testnet: null },
      withdrawFeeUsdc: { mainnet: null, testnet: null },
      strategyApiBaseUrl: "https://api.example.com",
    });
  });

  it("gates when there is no local wallet", () => {
    useWalletStore.setState({ mode: "none", wallet: null, address: null });
    render(<AgentScreen />);
    expect(screen.getByTestId("strategy-gated")).toBeTruthy();
  });

  it("offers a Set up wallet CTA that jumps to the Wallet tab when gated (no wallet)", () => {
    useWalletStore.setState({ mode: "none", wallet: null, address: null });
    const navigate = jest.fn();
    render(<AgentScreen navigation={{ navigate }} />);
    fireEvent.press(screen.getByTestId("gated-setup-wallet"));
    expect(navigate).toHaveBeenCalledWith("Account");
  });

  it("gates when the server has not delivered the strategy API base URL", () => {
    useRuntimeConfigStore.setState({
      arbitrumRpc: { mainnet: null, testnet: null },
      withdrawFeeUsdc: { mainnet: null, testnet: null },
      strategyApiBaseUrl: null,
    });
    render(<AgentScreen />);
    expect(screen.getByTestId("strategy-gated")).toBeTruthy();
  });

  it("connects via wallet signature, then shows the agent approval CTA", async () => {
    render(<AgentScreen />);
    expect(screen.getByTestId("strategy-connect")).toBeTruthy();
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(mockOpenSession).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("agent-approve")).toBeTruthy());
  });

  it("leads with the strategy value + a DCA preview before asking to connect", () => {
    render(<AgentScreen />);
    // value proposition and a concrete strategy preview are shown pre-connect
    expect(screen.getByText(/autopilot/i)).toBeTruthy();
    expect(screen.getByTestId("strategy-preview-dca")).toBeTruthy();
    expect(screen.getByText("Recurring buy (DCA)")).toBeTruthy();
    // connect is demoted to a "Connect to enable" CTA, not the headline
    expect(screen.getByText("Connect to enable")).toBeTruthy();
  });

  it("authorizes the trading agent (provision -> sign -> confirm)", async () => {
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("agent-approve")).toBeTruthy());
    fireEvent.press(screen.getByTestId("agent-approve"));
    await waitFor(() => expect(mockApiFake.provisionAgent).toHaveBeenCalled());
    expect(mockApproveAgent).toHaveBeenCalledWith(expect.objectContaining({ agentAddress: AGENT }));
    expect(mockApiFake.confirmAgent).toHaveBeenCalledWith(AGENT);
  });

  it("creates a DCA strategy from the form", async () => {
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("new-dca")).toBeTruthy());
    fireEvent.changeText(screen.getByTestId("dca-amount"), "50");
    fireEvent.changeText(screen.getByTestId("dca-interval"), "24");
    fireEvent.press(screen.getByTestId("dca-create"));
    await waitFor(() =>
      expect(mockApiFake.createStrategy).toHaveBeenCalledWith("dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 }),
    );
  });

  it("switches to the TWAP template and creates a TWAP", async () => {
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("template-twap")).toBeTruthy());
    fireEvent.press(screen.getByTestId("template-twap"));
    fireEvent.changeText(screen.getByTestId("twap-coin"), "ETH");
    fireEvent.changeText(screen.getByTestId("twap-total"), "300");
    fireEvent.changeText(screen.getByTestId("twap-slices"), "6");
    fireEvent.changeText(screen.getByTestId("twap-duration"), "3");
    fireEvent.press(screen.getByTestId("twap-create"));
    await waitFor(() =>
      expect(mockApiFake.createStrategy).toHaveBeenCalledWith("twap", { coin: "ETH", side: "buy", totalUsdc: 300, slices: 6, durationHours: 3 }),
    );
  });

  it("switches to the TP/SL template and creates a stop-only tpsl", async () => {
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("template-tpsl")).toBeTruthy());
    fireEvent.press(screen.getByTestId("template-tpsl"));
    fireEvent.changeText(screen.getByTestId("tpsl-coin"), "BTC");
    fireEvent.changeText(screen.getByTestId("tpsl-tp"), "110");
    fireEvent.press(screen.getByTestId("tpsl-create"));
    await waitFor(() =>
      expect(mockApiFake.createStrategy).toHaveBeenCalledWith("tpsl", { coin: "BTC", takeProfitPrice: 110 }),
    );
  });

  it("shows recent activity rows once connected", async () => {
    mockApiFake.getRecentActivity.mockResolvedValue([
      { id: "a1", time: 1710000000000, coin: "BTC", side: "buy", sz: 0.01, px: 50000 },
    ]);
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("activity-a1")).toBeTruthy());
  });
});
