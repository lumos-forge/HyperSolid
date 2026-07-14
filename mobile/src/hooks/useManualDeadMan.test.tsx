import { renderHook } from "@testing-library/react-native";
import { AppState } from "react-native";
import { useManualDeadMan } from "./useManualDeadMan";
import { useDeadManStore } from "../state/deadManStore";
import { useWalletStore } from "../state/walletStore";

const mockScheduleCancel = jest.fn(async (_time?: number) => ({ ok: true as const }));
jest.mock("../services/exchange", () => ({ ExchangeService: jest.fn().mockImplementation(() => ({ scheduleCancel: mockScheduleCancel })) }));
jest.mock("../lib/hyperliquid/client", () => ({ createExchangeClient: jest.fn(() => ({})) }));

const localWallet = { getAddress: () => "0xabc", getViemAccount: () => ({}) } as never;

function setAppState(state: string) {
  (AppState as unknown as { currentState: string }).currentState = state;
}
let listener: ((s: string) => void) | null = null;
beforeAll(() => {
  jest.spyOn(AppState, "addEventListener").mockImplementation(((_e: string, cb: (s: string) => void) => {
    listener = cb;
    return { remove: () => { listener = null; } };
  }) as never);
});

beforeEach(() => {
  jest.useFakeTimers();
  mockScheduleCancel.mockClear();
  setAppState("active");
  useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
  useDeadManStore.setState({ enabled: false, ttlMinutes: 2 });
});
afterEach(() => jest.useRealTimers());

describe("useManualDeadMan", () => {
  it("does nothing while disabled", () => {
    renderHook(() => useManualDeadMan());
    expect(mockScheduleCancel).not.toHaveBeenCalled();
  });

  it("arms immediately when enabled + active + local wallet", () => {
    useDeadManStore.setState({ enabled: true, ttlMinutes: 2 });
    renderHook(() => useManualDeadMan());
    expect(mockScheduleCancel).toHaveBeenCalledTimes(1);
    expect(mockScheduleCancel.mock.calls[0][0]).toBeGreaterThan(Date.now()); // armed with a future time
  });

  it("refreshes on the heartbeat and stops on background", () => {
    useDeadManStore.setState({ enabled: true, ttlMinutes: 2 });
    renderHook(() => useManualDeadMan());
    expect(mockScheduleCancel).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60_000); // heartbeat = ttl/2 = 60s
    expect(mockScheduleCancel).toHaveBeenCalledTimes(2);
    listener?.("background");
    jest.advanceTimersByTime(120_000);
    expect(mockScheduleCancel).toHaveBeenCalledTimes(2); // no more arms after background
  });

  it("clears the schedule (no time) when disabled", () => {
    useDeadManStore.setState({ enabled: true, ttlMinutes: 2 });
    const { rerender } = renderHook(() => useManualDeadMan());
    mockScheduleCancel.mockClear();
    useDeadManStore.setState({ enabled: false });
    rerender({});
    expect(mockScheduleCancel).toHaveBeenLastCalledWith(); // cleanup clear (no time arg)
  });
});
