import { PositionsService } from "./positionsData";
import type {
  PositionsInfoLike,
  PositionsSubsLike,
  RawClearinghouseState,
  PortfolioSnapshot,
  Mids,
  Subscription,
} from "../lib/hyperliquid/types";

const raw: RawClearinghouseState = {
  marginSummary: { accountValue: "1000", totalNtlPos: "500", totalMarginUsed: "100" },
  withdrawable: "800",
  assetPositions: [
    {
      position: {
        coin: "BTC",
        szi: "0.5",
        entryPx: "60000",
        positionValue: "31000",
        unrealizedPnl: "1000",
        liquidationPx: "45000",
        marginUsed: "60",
        leverage: { type: "cross", value: 10 },
      },
    },
  ],
};

class FakeInfo implements PositionsInfoLike {
  clearinghouseState = jest.fn(async (_a: string): Promise<RawClearinghouseState> => raw);
}

type ChListener = (e: { clearinghouseState: RawClearinghouseState }) => void;
type MidsListener = (d: { mids: Mids }) => void;

class FakeSubs implements PositionsSubsLike {
  chListener?: ChListener;
  midsListener?: MidsListener;
  unsubCh = jest.fn(async () => {});
  unsubMids = jest.fn(async () => {});
  clearinghouseState = jest.fn(async (_a: string, l: ChListener): Promise<Subscription> => {
    this.chListener = l;
    return { unsubscribe: this.unsubCh };
  });
  allMids = jest.fn(async (l: MidsListener): Promise<Subscription> => {
    this.midsListener = l;
    return { unsubscribe: this.unsubMids };
  });
}

describe("PositionsService", () => {
  it("loads and normalizes a portfolio for an address", async () => {
    const info = new FakeInfo();
    const svc = new PositionsService(info);
    const out = await svc.loadPortfolio("0xabc");
    expect(info.clearinghouseState).toHaveBeenCalledWith("0xabc");
    expect(out.summary.accountValue).toBe(1000);
    expect(out.positions[0].coin).toBe("BTC");
  });
});

describe("PositionsService.subscribeLive", () => {
  it("emits a normalized portfolio on each clearinghouseState event", async () => {
    const subs = new FakeSubs();
    const svc = new PositionsService(new FakeInfo(), subs);
    const updates: PortfolioSnapshot[] = [];
    await svc.subscribeLive("0xabc", (p) => updates.push(p));
    expect(subs.clearinghouseState).toHaveBeenCalledWith("0xabc", expect.any(Function));

    subs.chListener!({ clearinghouseState: raw });
    expect(updates).toHaveLength(1);
    expect(updates[0].positions[0].coin).toBe("BTC");
  });

  it("merges allMids marks (mark-priced PnL) once a snapshot exists", async () => {
    const subs = new FakeSubs();
    const svc = new PositionsService(new FakeInfo(), subs);
    const updates: PortfolioSnapshot[] = [];
    await svc.subscribeLive("0xabc", (p) => updates.push(p));

    // marks before any snapshot -> no emit
    subs.midsListener!({ mids: { BTC: "64000" } });
    expect(updates).toHaveLength(0);

    subs.chListener!({ clearinghouseState: raw }); // emit with current marks
    const last = updates[updates.length - 1];
    expect(last.positions[0].unrealizedPnl).toBe(2000); // (64000-60000)*0.5
    expect(last.positions[0].positionValue).toBe(32000);
  });

  it("does NOT double-count on snapshot replay (replace-state, §4.6)", async () => {
    const subs = new FakeSubs();
    const svc = new PositionsService(new FakeInfo(), subs);
    const updates: PortfolioSnapshot[] = [];
    await svc.subscribeLive("0xabc", (p) => updates.push(p));

    subs.chListener!({ clearinghouseState: raw });
    subs.chListener!({ clearinghouseState: raw }); // reconnect snapshot replay
    const last = updates[updates.length - 1];
    expect(last.summary.totalUnrealizedPnl).toBe(1000); // not doubled to 2000
  });

  it("unsubscribes both feeds", async () => {
    const subs = new FakeSubs();
    const svc = new PositionsService(new FakeInfo(), subs);
    const handle = await svc.subscribeLive("0xabc", () => {});
    await handle.unsubscribe();
    expect(subs.unsubCh).toHaveBeenCalled();
    expect(subs.unsubMids).toHaveBeenCalled();
  });

  it("throws if no subscription client was injected", async () => {
    const svc = new PositionsService(new FakeInfo());
    await expect(svc.subscribeLive("0xabc", () => {})).rejects.toThrow();
  });
});
