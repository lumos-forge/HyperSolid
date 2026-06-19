import { ExchangeService, type ExchangeLike } from "./exchange";
import { buildAssetIndex } from "../lib/hyperliquid/assetId";
import type { RawMeta } from "../lib/hyperliquid/types";
import { isValidCloid } from "../lib/hyperliquid/cloid";

const meta: RawMeta = { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 50 }] };
const index = buildAssetIndex(meta);

function fakeClient(orderImpl?: () => Promise<unknown>): ExchangeLike & {
  orderArg?: unknown;
  cancelArg?: unknown;
} {
  const self: ExchangeLike & { orderArg?: unknown; cancelArg?: unknown } = {
    order: jest.fn(async (p: unknown) => {
      self.orderArg = p;
      return orderImpl ? orderImpl() : { status: "ok", response: { data: { statuses: [{ resting: { oid: 1 } }] } } };
    }),
    cancel: jest.fn(async (p: unknown) => {
      self.cancelArg = p;
      return { status: "ok" };
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

  it("maps an HL status-level rejection to a readable error", async () => {
    const client = fakeClient(async () => ({
      status: "ok",
      response: { data: { statuses: [{ error: "minTradeNtlRejected" }] } },
    }));
    const svc = new ExchangeService(client, index);
    const res = await svc.placeOrder({ coin: "BTC", side: "buy", size: 0.01, price: 60000 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/\$10/);
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
