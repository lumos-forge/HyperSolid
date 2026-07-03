import { ExchangeService, type ExchangeLike } from "./exchange";
import { buildAssetIndex } from "../lib/hyperliquid/assetId";
import type { RawMeta } from "../lib/hyperliquid/types";
import { isValidCloid } from "../lib/hyperliquid/cloid";
import { IntentLedger } from "../lib/hyperliquid/intentLedger";

const meta: RawMeta = { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 50 }] };
const index = buildAssetIndex(meta);

type FakeClient = ExchangeLike & {
  orderArg?: unknown;
  cancelArg?: unknown;
  cancelByCloidArg?: unknown;
  modifyArg?: { oid: number | `0x${string}`; order: { a: number } };
  withdrawArg?: unknown;
  approveAgentArg?: unknown;
};

function fakeClient(orderImpl?: () => Promise<unknown>): FakeClient {
  const self: FakeClient = {
    order: jest.fn(async (p: unknown) => {
      self.orderArg = p;
      return orderImpl ? orderImpl() : { status: "ok", response: { data: { statuses: [{ resting: { oid: 1 } }] } } };
    }),
    twapOrder: jest.fn(async () => ({ status: "ok", response: { data: { status: { running: { twapId: 1 } } } } })),
    twapCancel: jest.fn(async () => ({ status: "ok", response: { data: { status: "success" } } })),
    cancel: jest.fn(async (p: unknown) => {
      self.cancelArg = p;
      return { status: "ok" };
    }),
    cancelByCloid: jest.fn(async (p: unknown) => {
      self.cancelByCloidArg = p;
      return { status: "ok" };
    }),
    modify: jest.fn(async (p: { oid: number | `0x${string}`; order: { a: number } }) => {
      self.modifyArg = p;
      return { status: "ok", response: { data: { statuses: [{ resting: { oid: 2 } }] } } };
    }),
    updateLeverage: jest.fn(async () => ({ status: "ok" })),
    withdraw3: jest.fn(async (p: unknown) => {
      self.withdrawArg = p;
      return { status: "ok", response: { type: "default" } };
    }),
    approveAgent: jest.fn(async (p: unknown) => {
      self.approveAgentArg = p;
      return { status: "ok", response: { type: "default" } };
    }),
  };
  return self;
}

describe("ExchangeService.placeOrder", () => {
  it("validates, signs/submits, and returns the cloid on success", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, index);
    const res = await svc.placeOrder({ coin: "BTC", side: "buy", size: 0.01, price: 60000 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(isValidCloid(res.cloid)).toBe(true);
    expect(client.order).toHaveBeenCalled();
  });

  it("persists cloid (pending) before signing and reconciles the ledger to open", async () => {
    const client = fakeClient();
    const ledger = new IntentLedger();
    const svc = new ExchangeService(client, index, ledger);
    const res = await svc.placeOrder({ coin: "BTC", side: "buy", size: 0.01, price: 60000 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.status?.kind).toBe("resting");
    const intent = ledger.get(res.cloid);
    expect(intent?.status).toBe("open");
    expect(intent?.oid).toBe(1);
  });

  it("reuses the same cloid on retry and never double-submits", async () => {
    const client = fakeClient();
    const ledger = new IntentLedger();
    const svc = new ExchangeService(client, index, ledger);
    const first = await svc.placeOrder({ coin: "BTC", side: "buy", size: 0.01, price: 60000 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await svc.placeOrder({
      coin: "BTC",
      side: "buy",
      size: 0.01,
      price: 60000,
      cloid: first.cloid,
    });
    expect(second.ok).toBe(true);
    expect(client.order).toHaveBeenCalledTimes(1); // deduped by cloid
  });

  it("blocks an invalid order before hitting the network (three-piece)", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, index);
    const res = await svc.placeOrder({ coin: "BTC", side: "buy", size: 0.0001, price: 50 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/\$10/);
    expect(client.order).not.toHaveBeenCalled();
  });

  it("rejects an unknown coin without calling the client", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, index);
    const res = await svc.placeOrder({ coin: "DOGE", side: "buy", size: 1, price: 1 });
    expect(res.ok).toBe(false);
    expect(client.order).not.toHaveBeenCalled();
  });

  it("maps an HL status-level rejection to a readable error and reconciles to rejected", async () => {
    const client = fakeClient(async () => ({
      status: "ok",
      response: { data: { statuses: [{ error: "minTradeNtlRejected" }] } },
    }));
    const ledger = new IntentLedger();
    const svc = new ExchangeService(client, index, ledger);
    const res = await svc.placeOrder({ coin: "BTC", side: "buy", size: 0.01, price: 60000 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/\$10/);
    expect(res.cloid && ledger.get(res.cloid)?.status).toBe("rejected");
  });

  it("surfaces thrown network errors", async () => {
    const client = fakeClient(async () => {
      throw new Error("network down");
    });
    const svc = new ExchangeService(client, index);
    const res = await svc.placeOrder({ coin: "BTC", side: "buy", size: 0.01, price: 60000 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/network down/);
  });

  it("flags a thrown receipt as uncertain and keeps the intent submitted (not rejected)", async () => {
    const client = fakeClient(async () => {
      throw new Error("network timeout");
    });
    const ledger = new IntentLedger();
    const svc = new ExchangeService(client, index, ledger);
    const res = await svc.placeOrder({ coin: "BTC", side: "buy", size: 0.01, price: 60000 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.uncertain).toBe(true);
    // §6.1/§6.2: never assume a rejection on an uncertain receipt — keep it submitted.
    expect(res.cloid && ledger.get(res.cloid)?.status).toBe("submitted");
  });

  it("retry after an uncertain receipt reuses the same cloid and re-submits", async () => {
    let calls = 0;
    const client = fakeClient(async () => {
      calls += 1;
      if (calls === 1) throw new Error("timeout");
      return { status: "ok", response: { data: { statuses: [{ resting: { oid: 7 } }] } } };
    });
    const ledger = new IntentLedger();
    const svc = new ExchangeService(client, index, ledger);
    const first = await svc.placeOrder({ coin: "BTC", side: "buy", size: 0.01, price: 60000 });
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.uncertain).toBe(true);

    const firstCloid = first.cloid!;
    const retry = await svc.placeOrder({
      coin: "BTC",
      side: "buy",
      size: 0.01,
      price: 60000,
      cloid: firstCloid,
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.cloid).toBe(firstCloid);
    expect(ledger.get(firstCloid)?.status).toBe("open");
    expect(calls).toBe(2);
  });

  it("does NOT flag a definite HL rejection as uncertain (terminal rejected)", async () => {
    const client = fakeClient(async () => ({
      status: "ok",
      response: { data: { statuses: [{ error: "minTradeNtlRejected" }] } },
    }));
    const ledger = new IntentLedger();
    const svc = new ExchangeService(client, index, ledger);
    const res = await svc.placeOrder({ coin: "BTC", side: "buy", size: 0.01, price: 60000 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.uncertain).toBeFalsy();
    expect(res.cloid && ledger.get(res.cloid)?.status).toBe("rejected");
  });
});

describe("ExchangeService.cancelOrder / setLeverage", () => {
  it("cancels by resolved asset id", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, index);
    const res = await svc.cancelOrder("BTC", 42);
    expect(res.ok).toBe(true);
    expect(client.cancelArg).toEqual({ cancels: [{ a: 0, o: 42 }] });
  });

  it("sets leverage by resolved asset id", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, index);
    const res = await svc.setLeverage("BTC", 10);
    expect(res.ok).toBe(true);
    expect(client.updateLeverage).toHaveBeenCalledWith({ asset: 0, isCross: true, leverage: 10 });
  });
});

describe("ExchangeService.cancelOrderByCloid / modifyOrder (gotchas + ledger)", () => {
  const CLOID = ("0x" + "1".repeat(32)) as `0x${string}`;

  it("cancelByCloid uses the 'asset' field and reconciles the ledger to canceled", async () => {
    const client = fakeClient();
    const ledger = new IntentLedger();
    ledger.open({ coin: "BTC", side: "buy", size: 0.01, price: 60000, cloid: CLOID });
    ledger.reconcile(CLOID, { kind: "resting", message: "挂单" });
    const svc = new ExchangeService(client, index, ledger);

    const res = await svc.cancelOrderByCloid("BTC", CLOID);
    expect(res.ok).toBe(true);
    expect(client.cancelByCloidArg).toEqual({ cancels: [{ asset: 0, cloid: CLOID }] });
    expect(ledger.get(CLOID)?.status).toBe("canceled");
  });

  it("cancelOrder by oid reconciles the matching intent to canceled", async () => {
    const client = fakeClient();
    const ledger = new IntentLedger();
    ledger.open({ coin: "BTC", side: "buy", size: 0.01, price: 60000, cloid: CLOID });
    ledger.reconcile(CLOID, { kind: "resting", oid: 42, message: "挂单" });
    const svc = new ExchangeService(client, index, ledger);

    const res = await svc.cancelOrder("BTC", 42);
    expect(res.ok).toBe(true);
    expect(ledger.get(CLOID)?.status).toBe("canceled");
  });

  it("modifyOrder submits { oid, order } with the resolved asset id", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, index);
    const res = await svc.modifyOrder(123, { coin: "BTC", side: "buy", size: 0.01, price: 61000 });
    expect(res.ok).toBe(true);
    expect(client.modifyArg?.oid).toBe(123);
    expect(client.modifyArg?.order.a).toBe(0);
  });

  it("rejects modify/cancel of an unknown coin without hitting the network", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, index);
    const m = await svc.modifyOrder(1, { coin: "DOGE", side: "buy", size: 1, price: 1 });
    expect(m.ok).toBe(false);
    expect(client.modify).not.toHaveBeenCalled();
    const c = await svc.cancelOrderByCloid("DOGE", CLOID);
    expect(c.ok).toBe(false);
    expect(client.cancelByCloid).not.toHaveBeenCalled();
  });
});

describe("ExchangeService.placeBracket", () => {
  it("submits an entry plus TP and SL legs through the same idempotency pipeline", async () => {
    const client = fakeClient();
    const ledger = new IntentLedger();
    const svc = new ExchangeService(client, index, ledger);
    const res = await svc.placeBracket({
      entry: { coin: "BTC", side: "buy", size: 0.01, price: 60000 },
      takeProfit: { triggerPx: 66000 },
      stopLoss: { triggerPx: 58000 },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(isValidCloid(res.cloid)).toBe(true);
    // entry + TP + SL = 3 order tuples in a single grouped submission
    const arg = client.orderArg as { orders: unknown[]; grouping: string };
    expect(arg.orders).toHaveLength(3);
    expect(arg.grouping).toBe("normalTpsl");
    expect(ledger.get(res.cloid)?.status).toBe("open");
  });

  it("reuses the entry cloid on retry and never double-submits the bracket", async () => {
    const client = fakeClient(() => {
      throw new Error("network down");
    });
    const ledger = new IntentLedger();
    const svc = new ExchangeService(client, index, ledger);
    const first = await svc.placeBracket({
      entry: { coin: "BTC", side: "buy", size: 0.01, price: 60000 },
      stopLoss: { triggerPx: 58000 },
    });
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.uncertain).toBe(true);
    expect(first.cloid).toBeDefined();
    const okClient = fakeClient();
    const svc2 = new ExchangeService(okClient, index, ledger);
    const retry = await svc2.placeBracket({
      entry: { coin: "BTC", side: "buy", size: 0.01, price: 60000, cloid: first.cloid },
      stopLoss: { triggerPx: 58000 },
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.cloid).toBe(first.cloid);
  });

  it("rejects an unknown asset without hitting the network", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, index);
    const res = await svc.placeBracket({
      entry: { coin: "DOGE", side: "buy", size: 1, price: 1 },
      stopLoss: { triggerPx: 0.9 },
    });
    expect(res.ok).toBe(false);
    expect(client.order).not.toHaveBeenCalled();
  });
});

describe("ExchangeService.withdrawUsdc", () => {
  const ADDR = "0x" + "1".repeat(40);

  it("submits a valid withdrawal with the amount as a string", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, index);
    const res = await svc.withdrawUsdc({ destination: ADDR, amount: 100, withdrawable: 800 });
    expect(res.ok).toBe(true);
    expect(client.withdraw3).toHaveBeenCalled();
    expect(client.withdrawArg).toEqual({ destination: ADDR, amount: "100" });
  });

  it("rejects an invalid destination without hitting the network", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, index);
    const res = await svc.withdrawUsdc({ destination: "0xabc", amount: 100, withdrawable: 800 });
    expect(res.ok).toBe(false);
    expect(client.withdraw3).not.toHaveBeenCalled();
  });

  it("rejects a non-positive or over-balance amount without hitting the network", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, index);
    expect((await svc.withdrawUsdc({ destination: ADDR, amount: 0, withdrawable: 800 })).ok).toBe(false);
    expect((await svc.withdrawUsdc({ destination: ADDR, amount: 900, withdrawable: 800 })).ok).toBe(false);
    expect(client.withdraw3).not.toHaveBeenCalled();
  });

  it("rejects an amount at or below the flat fee (would deliver ~0)", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, index);
    expect((await svc.withdrawUsdc({ destination: ADDR, amount: 1, withdrawable: 800, fee: 1 })).ok).toBe(false);
    expect((await svc.withdrawUsdc({ destination: ADDR, amount: 0.5, withdrawable: 800, fee: 1 })).ok).toBe(false);
    expect(client.withdraw3).not.toHaveBeenCalled();
    expect((await svc.withdrawUsdc({ destination: ADDR, amount: 5, withdrawable: 800, fee: 1 })).ok).toBe(true);
  });

  it("treats a thrown (network/timeout) receipt as uncertain, not failed", async () => {
    const client = fakeClient();
    client.withdraw3 = jest.fn(async () => {
      throw new Error("network down");
    });
    const svc = new ExchangeService(client, index);
    const res = await svc.withdrawUsdc({ destination: ADDR, amount: 100, withdrawable: 800 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.uncertain).toBe(true);
  });
});

describe("ExchangeService.approveAgent", () => {
  const AGENT = "0x" + "9".repeat(40);

  it("signs an agent approval with the address and name", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, index);
    const res = await svc.approveAgent({ agentAddress: AGENT, agentName: "hypersolid valid_until 123" });
    expect(res.ok).toBe(true);
    expect(client.approveAgent).toHaveBeenCalled();
    expect(client.approveAgentArg).toEqual({ agentAddress: AGENT, agentName: "hypersolid valid_until 123" });
  });

  it("defaults a missing agent name to null", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, index);
    await svc.approveAgent({ agentAddress: AGENT });
    expect(client.approveAgentArg).toEqual({ agentAddress: AGENT, agentName: null });
  });

  it("rejects an invalid agent address without hitting the network", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, index);
    const res = await svc.approveAgent({ agentAddress: "0xabc" });
    expect(res.ok).toBe(false);
    expect(client.approveAgent).not.toHaveBeenCalled();
  });

  it("treats a thrown receipt as uncertain, not failed", async () => {
    const client = fakeClient();
    client.approveAgent = jest.fn(async () => {
      throw new Error("network down");
    });
    const svc = new ExchangeService(client, index);
    const res = await svc.approveAgent({ agentAddress: AGENT });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.uncertain).toBe(true);
  });
});

describe("placeScale", () => {
  it("submits N laddered limit orders via one order action", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, index);
    const r = await svc.placeScale({ coin: "BTC", side: "buy", totalSize: 0.03, startPx: 60000, endPx: 61000, count: 3 });
    expect(r.ok).toBe(true);
    const params = (client.order as jest.Mock).mock.calls[0][0];
    expect(params.orders).toHaveLength(3);
    expect(params.orders.map((o: { p: string }) => o.p)).toEqual(["60000", "60500", "61000"]);
  });

  it("rejects an unknown asset before signing", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, index);
    const r = await svc.placeScale({ coin: "DOGE", side: "buy", totalSize: 1, startPx: 1, endPx: 2, count: 2 });
    expect(r.ok).toBe(false);
    expect(client.order).not.toHaveBeenCalled();
  });
});

describe("placeTwap", () => {
  it("submits a native twapOrder with the built twap params", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, index);
    const r = await svc.placeTwap({ coin: "BTC", side: "buy", size: 0.01, minutes: 30, randomize: true });
    expect(r.ok).toBe(true);
    expect(client.twapOrder).toHaveBeenCalledWith({ twap: { a: 0, b: true, s: "0.01", r: false, m: 30, t: true } });
  });

  it("reports an uncertain receipt when twapOrder throws", async () => {
    const client = fakeClient();
    (client.twapOrder as jest.Mock).mockRejectedValueOnce(new Error("网络超时"));
    const svc = new ExchangeService(client, index);
    const r = await svc.placeTwap({ coin: "BTC", side: "sell", size: 0.01, minutes: 30 });
    expect(r).toEqual({ ok: false, error: expect.any(String), uncertain: true });
  });

  it("rejects an unknown asset without calling the venue", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, index);
    const r = await svc.placeTwap({ coin: "DOGE", side: "buy", size: 1, minutes: 30 });
    expect(r.ok).toBe(false);
    expect(client.twapOrder).not.toHaveBeenCalled();
  });
});

describe("cancelTwap", () => {
  it("cancels by asset id + twap id", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, index);
    const r = await svc.cancelTwap("BTC", 42);
    expect(r.ok).toBe(true);
    expect(client.twapCancel).toHaveBeenCalledWith({ a: 0, t: 42 });
  });
  it("fails safe on an unknown coin without signing", async () => {
    const client = fakeClient();
    const svc = new ExchangeService(client, index);
    const r = await svc.cancelTwap("NOPE", 42);
    expect(r.ok).toBe(false);
    expect(client.twapCancel).not.toHaveBeenCalled();
  });
  it("reports an uncertain receipt when twapCancel throws", async () => {
    const client = fakeClient();
    (client.twapCancel as jest.Mock).mockRejectedValueOnce(new Error("网络超时"));
    const svc = new ExchangeService(client, index);
    const r = await svc.cancelTwap("BTC", 42);
    expect(r).toMatchObject({ ok: false, uncertain: true });
  });
});
