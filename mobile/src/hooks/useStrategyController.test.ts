import { renderHook, act, waitFor } from "@testing-library/react-native";
import { useStrategyController } from "./useStrategyController";

const AGENT = "0x" + "9".repeat(40);

function makeApi() {
  return {
    agentStatus: jest.fn(async () => ({ approved: false })),
    provisionAgent: jest.fn(async () => ({ agentAddress: AGENT })),
    confirmAgent: jest.fn(async () => undefined),
    revokeAgent: jest.fn(async () => undefined),
    listStrategies: jest.fn(async () => []),
    createStrategy: jest.fn(async () => ({ id: "s1", type: "dca", params: {}, status: "running" })),
    setStrategyStatus: jest.fn(async () => ({ id: "s1", type: "dca", params: {}, status: "paused" })),
    killSwitch: jest.fn(async () => undefined),
    getRecentActivity: jest.fn(async () => [] as unknown[]),
  };
}
const approveAgent = jest.fn(async () => ({ ok: true as const }));

describe("useStrategyController", () => {
  it("loads agent status + strategies on init", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useStrategyController(api as never, approveAgent, "valid_until 1"));
    await waitFor(() => expect(api.agentStatus).toHaveBeenCalled());
    expect(api.listStrategies).toHaveBeenCalled();
    expect(result.current.approved).toBe(false);
  });

  it("approveAgentFlow: provisions, signs approveAgent, confirms", async () => {
    const api = makeApi();
    approveAgent.mockClear();
    const { result } = renderHook(() => useStrategyController(api as never, approveAgent, "valid_until 1"));
    await act(async () => {
      await result.current.approveAgentFlow();
    });
    expect(api.provisionAgent).toHaveBeenCalled();
    expect(approveAgent).toHaveBeenCalledWith({ agentAddress: AGENT, agentName: "valid_until 1" });
    expect(api.confirmAgent).toHaveBeenCalledWith(AGENT);
  });

  it("does not confirm if the on-chain approval is rejected", async () => {
    const api = makeApi();
    const rejected = jest.fn(async () => ({ ok: false as const, error: "user rejected" }));
    const { result } = renderHook(() => useStrategyController(api as never, rejected, "valid_until 1"));
    await act(async () => {
      await result.current.approveAgentFlow();
    });
    expect(api.confirmAgent).not.toHaveBeenCalled();
  });

  it("createDca creates then refreshes", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useStrategyController(api as never, approveAgent, "n"));
    await act(async () => {
      await result.current.createDca({ coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 });
    });
    expect(api.createStrategy).toHaveBeenCalledWith("dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 });
    expect(api.listStrategies.mock.calls.length).toBeGreaterThan(1);
  });

  it("refresh loads recent activity into the hook", async () => {
    const api = makeApi();
    api.getRecentActivity = jest.fn(async () => [{ id: "a1", time: 1, coin: "BTC", side: "buy", sz: 0.1, px: 50000 }]);
    const { result } = renderHook(() => useStrategyController(api as never, approveAgent, "n"));
    await waitFor(() => expect(result.current.activity.length).toBe(1));
  });

  it("createTwap creates a twap then refreshes", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useStrategyController(api as never, approveAgent, "n"));
    await act(async () => {
      await result.current.createTwap({ coin: "ETH", side: "buy", totalUsdc: 300, slices: 6, durationHours: 3 });
    });
    expect(api.createStrategy).toHaveBeenCalledWith("twap", { coin: "ETH", side: "buy", totalUsdc: 300, slices: 6, durationHours: 3 });
  });
});
