import { TwapService } from "./twapData";

describe("TwapService.loadActive", () => {
  it("calls twapHistory with the address and returns normalized active twaps", async () => {
    const raw = [
      { status: { status: "activated" }, twapId: 7, state: { coin: "BTC", side: "B", sz: "1", executedSz: "0.4", executedNtl: "24000", minutes: 30, reduceOnly: false, timestamp: 1000 } },
      { status: { status: "terminated" }, twapId: 8, state: { coin: "ETH", side: "A", sz: "2", executedSz: "1", executedNtl: "1800", minutes: 20, reduceOnly: false, timestamp: 500 } },
    ];
    const info = { twapHistory: jest.fn(async () => raw), userTwapSliceFills: jest.fn() };
    const svc = new TwapService(info);
    const out = await svc.loadActive("0xabc");
    expect(info.twapHistory).toHaveBeenCalledWith("0xabc");
    expect(out).toEqual([
      { twapId: 7, coin: "BTC", side: "buy", sz: 1, executedSz: 0.4, executedNtl: 24000, minutes: 30, reduceOnly: false, startedAt: 1000 },
    ]);
  });
});

describe("TwapService.loadHistory", () => {
  it("returns only finished/terminated/error entries, normalized", async () => {
    const raw = [
      { status: { status: "activated" }, twapId: 7, state: { coin: "BTC", side: "B", sz: "1", executedSz: "0.4", executedNtl: "24000", minutes: 30, reduceOnly: false, timestamp: 1000 } },
      { status: { status: "finished" }, twapId: 8, state: { coin: "ETH", side: "A", sz: "2", executedSz: "2", executedNtl: "5000", minutes: 20, reduceOnly: false, timestamp: 500 } },
    ];
    const info = { twapHistory: jest.fn(async () => raw), userTwapSliceFills: jest.fn() };
    const out = await new TwapService(info).loadHistory("0xabc");
    expect(info.twapHistory).toHaveBeenCalledWith("0xabc");
    expect(out).toEqual([{ twapId: 8, coin: "ETH", side: "sell", sz: 2, executedSz: 2, executedNtl: 5000, minutes: 20, reduceOnly: false, startedAt: 500, status: "finished" }]);
  });
});

describe("TwapService.loadSliceFills", () => {
  it("groups normalized slice fills by twapId", async () => {
    const raw = [
      { twapId: 8, fill: { coin: "ETH", px: "3000", sz: "0.5", side: "A", time: 200, startPosition: "0", dir: "Close Long", closedPnl: "1", hash: "0x", oid: 1, crossed: true, fee: "0.1", tid: 5, feeToken: "USDC", twapId: 8 } },
    ];
    const info = { twapHistory: jest.fn(), userTwapSliceFills: jest.fn(async () => raw) };
    const map = await new TwapService(info).loadSliceFills("0xabc");
    expect(info.userTwapSliceFills).toHaveBeenCalledWith("0xabc");
    expect(map.get(8)).toMatchObject([{ tid: 5, coin: "ETH", side: "sell", px: 3000, sz: 0.5 }]);
  });
});

describe("TwapService.subscribeSliceFills", () => {
  it("normalizes the event's twapSliceFills before invoking the callback", async () => {
    let captured: ((e: unknown) => void) | null = null;
    const unsub = { unsubscribe: jest.fn(async () => {}) };
    const subs = { userTwapSliceFills: jest.fn(async (_addr: string, cb: (e: unknown) => void) => { captured = cb; return unsub; }) };
    const info = { twapHistory: jest.fn(), userTwapSliceFills: jest.fn() };
    const cb = jest.fn();
    const sub = await new TwapService(info, subs).subscribeSliceFills("0xabc", cb);
    expect(subs.userTwapSliceFills).toHaveBeenCalledWith("0xabc", expect.any(Function));
    captured!({ twapSliceFills: [{ twapId: 8, fill: { coin: "ETH", px: "3000", sz: "0.5", side: "A", time: 200, startPosition: "0", dir: "x", closedPnl: "0", hash: "0x", oid: 1, crossed: true, fee: "0", tid: 5, feeToken: "USDC", twapId: 8 } }], isSnapshot: true });
    expect(cb).toHaveBeenCalledWith([expect.objectContaining({ twapId: 8, fill: expect.objectContaining({ tid: 5, side: "sell" }) })]);
    expect(sub).toBe(unsub);
  });

  it("throws if no subscription client was configured", async () => {
    const info = { twapHistory: jest.fn(), userTwapSliceFills: jest.fn() };
    await expect(new TwapService(info).subscribeSliceFills("0xabc", jest.fn())).rejects.toThrow();
  });
});

describe("TwapService.loadActiveAndHistory", () => {
  it("derives both active and history from a single twapHistory call", async () => {
    const raw = [
      { status: { status: "activated" }, twapId: 7, state: { coin: "BTC", side: "B", sz: "1", executedSz: "0.4", executedNtl: "24000", minutes: 30, reduceOnly: false, timestamp: 1000 } },
      { status: { status: "finished" }, twapId: 8, state: { coin: "ETH", side: "A", sz: "2", executedSz: "2", executedNtl: "5000", minutes: 20, reduceOnly: false, timestamp: 500 } },
    ];
    const info = { twapHistory: jest.fn(async () => raw), userTwapSliceFills: jest.fn() };
    const out = await new TwapService(info).loadActiveAndHistory("0xabc");
    expect(info.twapHistory).toHaveBeenCalledTimes(1);
    expect(out.active.map((a) => a.twapId)).toEqual([7]);
    expect(out.history.map((h) => h.twapId)).toEqual([8]);
  });
});
