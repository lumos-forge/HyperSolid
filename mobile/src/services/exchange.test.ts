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
};

function fakeClient(orderImpl?: () => Promise<unknown>): FakeClient {
  const self: FakeClient = {
    order: jest.fn(async (p: unknown) => {
      self.orderArg = p;
      return orderImpl ? orderImpl() : { status: "ok", response: { data: { statuses: [{ resting: { oid: 1 } }] } } };
    }),
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
