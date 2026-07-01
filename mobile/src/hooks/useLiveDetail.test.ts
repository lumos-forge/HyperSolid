import { renderHook, waitFor } from "@testing-library/react-native";
import { useLiveDetail } from "./useLiveDetail";
import type { DetailDataService } from "../services/detailData";
import type { Candle, Orderbook, Subscription, Trade } from "../lib/hyperliquid/types";

const candles: Candle[] = [{ t: 1, open: 10, close: 12, high: 13, low: 9, volume: 100 }];
const ob: Orderbook = { bids: [], asks: [], spread: 1, spreadPct: 0.5 };
const trades: Trade[] = [{ px: 100, sz: 1, side: "buy", time: 5, tid: 1 }];

function fakeService(): DetailDataService & { _unsub: jest.Mock } {
  const unsub = jest.fn(async () => {});
  return {
    loadCandles: jest.fn(async () => candles),
    subscribeOrderbook: jest.fn(async (_c: string, cb: (o: Orderbook) => void): Promise<Subscription> => {
      cb(ob);
      return { unsubscribe: unsub };
    }),
    subscribeTrades: jest.fn(async (_c: string, cb: (t: Trade[]) => void): Promise<Subscription> => {
      cb(trades);
      return { unsubscribe: unsub };
    }),
    _unsub: unsub,
  } as unknown as DetailDataService & { _unsub: jest.Mock };
}

describe("useLiveDetail", () => {
  it("loads candles and live orderbook/trades", async () => {
    const svc = fakeService();
    const { result } = renderHook(() => useLiveDetail(svc, "BTC"));
    await waitFor(() => expect(result.current.candles).toHaveLength(1));
    await waitFor(() => expect(result.current.orderbook?.spread).toBe(1));
    await waitFor(() => expect(result.current.trades[0]?.side).toBe("buy"));
  });

  it("records an error when candle load fails", async () => {
    const svc = {
      loadCandles: jest.fn(async () => {
        const e = new Error("Unknown HTTP request error: boom");
        e.name = "HttpRequestError";
        throw e;
      }),
      subscribeOrderbook: jest.fn(),
      subscribeTrades: jest.fn(),
    } as unknown as DetailDataService;
    const { result } = renderHook(() => useLiveDetail(svc, "BTC"));
    await waitFor(() => expect(result.current.error).toBe("network"));
  });
});
