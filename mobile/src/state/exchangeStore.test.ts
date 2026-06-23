import { useExchangeStore } from "./exchangeStore";
import { buildAssetIndex } from "../lib/hyperliquid/assetId";
import type { RawMeta } from "../lib/hyperliquid/types";
import { IntentLedger } from "../lib/hyperliquid/intentLedger";
import type { ExchangeLike } from "../services/exchange";

const meta: RawMeta = { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 50 }] };
const index = buildAssetIndex(meta);

function fakeClient(): { client: ExchangeLike; order: jest.Mock } {
  const order = jest.fn(async () => ({
    status: "ok",
    response: { data: { statuses: [{ resting: { oid: 1 } }] } },
  }));
  const client: ExchangeLike = {
    order,
    cancel: jest.fn(),
    cancelByCloid: jest.fn(),
    modify: jest.fn(),
    updateLeverage: jest.fn(),
    withdraw3: jest.fn(),
  };
  return { client, order };
}

describe("exchangeStore", () => {
  beforeEach(() => useExchangeStore.getState().reset());

  it("starts with no service", () => {
    expect(useExchangeStore.getState().service).toBeNull();
  });

  it("init builds a singleton service bound to the injected persistent ledger", () => {
    const { client } = fakeClient();
    useExchangeStore.getState().init(client, index, new IntentLedger());
    expect(useExchangeStore.getState().service).not.toBeNull();
  });

  it("dedupes a reused cloid across submits because the persistent ledger is shared", async () => {
    const { client, order } = fakeClient();
    const ledger = new IntentLedger();
    useExchangeStore.getState().init(client, index, ledger);
    const svc = useExchangeStore.getState().service!;
    const cloid = ("0x" + "1".repeat(32)) as `0x${string}`;

    const first = await svc.placeOrder({ coin: "BTC", side: "buy", size: 0.01, price: 60000, cloid });
    expect(first.ok).toBe(true);
    // A retry that reuses the SAME cloid on the singleton service must NOT re-submit.
    const second = await svc.placeOrder({ coin: "BTC", side: "buy", size: 0.01, price: 60000, cloid });
    expect(second.ok).toBe(true);
    expect(order).toHaveBeenCalledTimes(1);
    expect(ledger.get(cloid)?.status).toBe("open");
  });

  it("reset clears the service", () => {
    const { client } = fakeClient();
    useExchangeStore.getState().init(client, index, new IntentLedger());
    useExchangeStore.getState().reset();
    expect(useExchangeStore.getState().service).toBeNull();
  });
});
