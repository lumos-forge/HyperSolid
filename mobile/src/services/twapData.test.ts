import { TwapService } from "./twapData";

describe("TwapService.loadActive", () => {
  it("calls twapHistory with the address and returns normalized active twaps", async () => {
    const raw = [
      { status: { status: "activated" }, twapId: 7, state: { coin: "BTC", side: "B", sz: "1", executedSz: "0.4", executedNtl: "24000", minutes: 30, reduceOnly: false, timestamp: 1000 } },
      { status: { status: "terminated" }, twapId: 8, state: { coin: "ETH", side: "A", sz: "2", executedSz: "1", executedNtl: "1800", minutes: 20, reduceOnly: false, timestamp: 500 } },
    ];
    const info = { twapHistory: jest.fn(async () => raw) };
    const svc = new TwapService(info);
    const out = await svc.loadActive("0xabc");
    expect(info.twapHistory).toHaveBeenCalledWith("0xabc");
    expect(out).toEqual([
      { twapId: 7, coin: "BTC", side: "buy", sz: 1, executedSz: 0.4, executedNtl: 24000, minutes: 30, reduceOnly: false, startedAt: 1000 },
    ]);
  });
});
