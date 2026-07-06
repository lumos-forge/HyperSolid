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

  it("switches to the Grid template and creates a longOnly grid by default", async () => {
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("template-grid")).toBeTruthy());
    fireEvent.press(screen.getByTestId("template-grid"));
    fireEvent.changeText(screen.getByTestId("grid-coin"), "BTC");
    fireEvent.changeText(screen.getByTestId("grid-lower"), "100");
    fireEvent.changeText(screen.getByTestId("grid-upper"), "200");
    fireEvent.changeText(screen.getByTestId("grid-levels"), "6");
    fireEvent.changeText(screen.getByTestId("grid-per-level"), "50");
    fireEvent.press(screen.getByTestId("grid-create"));
    await waitFor(() =>
      expect(mockApiFake.createStrategy).toHaveBeenCalledWith("grid", { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50, mode: "longOnly" }),
    );
  });

  it("creates a symmetric grid when the symmetric mode is selected", async () => {
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("template-grid")).toBeTruthy());
    fireEvent.press(screen.getByTestId("template-grid"));
    fireEvent.changeText(screen.getByTestId("grid-coin"), "BTC");
    fireEvent.changeText(screen.getByTestId("grid-lower"), "100");
    fireEvent.changeText(screen.getByTestId("grid-upper"), "200");
    fireEvent.changeText(screen.getByTestId("grid-levels"), "6");
    fireEvent.changeText(screen.getByTestId("grid-per-level"), "50");
    fireEvent.press(screen.getByTestId("grid-mode-symmetric"));
    fireEvent.press(screen.getByTestId("grid-create"));
    await waitFor(() =>
      expect(mockApiFake.createStrategy).toHaveBeenCalledWith("grid", { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50, mode: "symmetric" }),
    );
  });

  it("renders a grid strategy row", async () => {
    mockApiFake.listStrategies.mockResolvedValue([
      { id: "g1", type: "grid", status: "running", params: { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 }, lastLevel: 2, filledTotalUsdc: 100 },
    ]);
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("strategy-g1")).toBeTruthy());
    expect(screen.getByText("BTC Grid")).toBeTruthy();
    expect(screen.getByText("level 3/6 · $100 bought")).toBeTruthy();
  });

  it("switches to the Limit grid template and creates one", async () => {
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("template-gridLimit")).toBeTruthy());
    fireEvent.press(screen.getByTestId("template-gridLimit"));
    fireEvent.changeText(screen.getByTestId("grid-limit-coin"), "BTC");
    fireEvent.changeText(screen.getByTestId("grid-limit-lower"), "100");
    fireEvent.changeText(screen.getByTestId("grid-limit-upper"), "200");
    fireEvent.changeText(screen.getByTestId("grid-limit-levels"), "6");
    fireEvent.changeText(screen.getByTestId("grid-limit-per-level"), "50");
    fireEvent.press(screen.getByTestId("grid-limit-create"));
    await waitFor(() =>
      expect(mockApiFake.createStrategy).toHaveBeenCalledWith("gridLimit", { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 }),
    );
  });

  it("renders a gridLimit strategy row", async () => {
    mockApiFake.listStrategies.mockResolvedValue([
      { id: "gl1", type: "gridLimit", status: "running", params: { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 }, filledTotalUsdc: 12, armedCount: 3, holdingCount: 1 },
    ]);
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("strategy-gl1")).toBeTruthy());
  });

  it("shows a canceling label and no toggle for a canceling gridLimit row", async () => {
    mockApiFake.listStrategies.mockResolvedValue([
      { id: "gl2", type: "gridLimit", status: "canceling", params: { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 }, filledTotalUsdc: 0, armedCount: 0, holdingCount: 0 },
    ]);
    render(<AgentScreen />);
    fireEvent.press(screen.getByTestId("strategy-connect-btn"));
    await waitFor(() => expect(screen.getByTestId("strategy-gl2")).toBeTruthy());
    expect(screen.queryByLabelText("toggle-gl2")).toBeNull();
  });
});
