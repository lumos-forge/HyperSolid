import { makeSignerBackedExchangeClient, type ExchangeTransport, type SignerLike } from "./signerExchangeClient";
import { SignerError } from "./signerClient";

const SIG = { r: "0xr", s: "0xs", v: 27, nonce: 42, duplicate: false };

function fakeSigner(over: Partial<SignerLike> = {}): {
  signer: SignerLike;
  signCalls: unknown[];
  reconcileCalls: unknown[];
} {
  const signCalls: unknown[] = [];
  const reconcileCalls: unknown[] = [];
  const signer: SignerLike = {
    sign: async (req) => {
      signCalls.push(req);
      return SIG;
    },
    reconcile: async (keyId, cloid, status) => {
      reconcileCalls.push({ keyId, cloid, status });
    },
    ...over,
  };
  return { signer, signCalls, reconcileCalls };
}

function fakeTransport(res: unknown): { transport: ExchangeTransport; calls: Array<{ endpoint: string; payload: unknown }> } {
  const calls: Array<{ endpoint: string; payload: unknown }> = [];
  const transport: ExchangeTransport = {
    request: async (endpoint, payload) => {
      calls.push({ endpoint, payload });
      return res;
    },
  };
  return { transport, calls };
}

const ORDER_ARG = {
  orders: [{ a: 3, b: true, p: "100.0", s: "0.5", r: false, t: { limit: { tif: "Ioc" as const } }, c: "0xcloid" }],
  grouping: "na" as const,
};

describe("makeSignerBackedExchangeClient.order", () => {
  it("signs the order (kind+params+cloid), submits the pre-signed action, reconciles filled", async () => {
    const { signer, signCalls, reconcileCalls } = fakeSigner();
    const filled = { response: { data: { statuses: [{ filled: { totalSz: "0.5", avgPx: "100" } }] } } };
    const { transport, calls } = fakeTransport(filled);
    const client = makeSignerBackedExchangeClient({ keyId: "agent:0xo", signer, transport, isTestnet: true });

    const res = await client.order(ORDER_ARG);

    expect(signCalls).toEqual([
      { keyId: "agent:0xo", kind: "order", params: { asset: 3, isBuy: true, px: "100.0", sz: "0.5", reduceOnly: false, tif: "Ioc", grouping: "na", cloid: "0xcloid" }, cloid: "0xcloid", isTestnet: true },
    ]);
    expect(calls).toEqual([
      {
        endpoint: "exchange",
        payload: {
          action: { type: "order", orders: [{ a: 3, b: true, p: "100.0", s: "0.5", r: false, t: { limit: { tif: "Ioc" } }, c: "0xcloid" }], grouping: "na" },
          signature: { r: "0xr", s: "0xs", v: 27 },
          nonce: 42,
        },
      },
    ]);
    expect(reconcileCalls).toEqual([{ keyId: "agent:0xo", cloid: "0xcloid", status: "filled" }]);
    expect(res).toBe(filled);
  });

  it("reconciles open when the order rests", async () => {
    const { signer, reconcileCalls } = fakeSigner();
    const { transport } = fakeTransport({ response: { data: { statuses: [{ resting: { oid: 7 } }] } } });
    const client = makeSignerBackedExchangeClient({ keyId: "k", signer, transport, isTestnet: false });
    await client.order(ORDER_ARG);
    expect(reconcileCalls).toEqual([{ keyId: "k", cloid: "0xcloid", status: "open" }]);
  });

  it("reconciles rejected on an error status", async () => {
    const { signer, reconcileCalls } = fakeSigner();
    const { transport } = fakeTransport({ response: { data: { statuses: [{ error: "bad" }] } } });
    const client = makeSignerBackedExchangeClient({ keyId: "k", signer, transport, isTestnet: false });
    await client.order(ORDER_ARG);
    expect(reconcileCalls).toEqual([{ keyId: "k", cloid: "0xcloid", status: "rejected" }]);
  });

  it("propagates a SignerError from sign (caller fails closed) and never submits", async () => {
    const { signer } = fakeSigner({ sign: async () => { throw new SignerError(403, "policy", "denied"); } });
    const { transport, calls } = fakeTransport({});
    const client = makeSignerBackedExchangeClient({ keyId: "k", signer, transport, isTestnet: false });
    await expect(client.order(ORDER_ARG)).rejects.toBeInstanceOf(SignerError);
    expect(calls).toEqual([]);
  });

  it("does not throw if reconcile fails (best-effort) and still returns the response", async () => {
    const { signer } = fakeSigner({ reconcile: async () => { throw new Error("reconcile down"); } });
    const filled = { response: { data: { statuses: [{ filled: { totalSz: "1", avgPx: "1" } }] } } };
    const { transport } = fakeTransport(filled);
    const client = makeSignerBackedExchangeClient({ keyId: "k", signer, transport, isTestnet: false });
    await expect(client.order(ORDER_ARG)).resolves.toBe(filled);
  });
});

describe("makeSignerBackedExchangeClient.cancelByCloid", () => {
  it("signs cancelByCloid with a derived cloid and submits the action (no reconcile)", async () => {
    const { signer, signCalls, reconcileCalls } = fakeSigner();
    const { transport, calls } = fakeTransport({ ok: true });
    const client = makeSignerBackedExchangeClient({ keyId: "k", signer, transport, isTestnet: true });

    await client.cancelByCloid({ cancels: [{ asset: 2, cloid: "0xaa" }, { asset: 5, cloid: "0xbb" }] });

    const call = signCalls[0] as { keyId: string; kind: string; params: unknown; cloid: string; isTestnet: boolean };
    expect(call.kind).toBe("cancelByCloid");
    expect(call.params).toEqual({ cancels: [{ asset: 2, cloid: "0xaa" }, { asset: 5, cloid: "0xbb" }] });
    expect(call.cloid).toMatch(/^0x[0-9a-f]{32}$/);
    expect(calls[0]).toEqual({
      endpoint: "exchange",
      payload: {
        action: { type: "cancelByCloid", cancels: [{ asset: 2, cloid: "0xaa" }, { asset: 5, cloid: "0xbb" }] },
        signature: { r: "0xr", s: "0xs", v: 27 },
        nonce: 42,
      },
    });
    expect(reconcileCalls).toEqual([]);
  });

  it("derives the same cloid for the same cancel set and a different one otherwise", async () => {
    const { signer, signCalls } = fakeSigner();
    const { transport } = fakeTransport({});
    const client = makeSignerBackedExchangeClient({ keyId: "k", signer, transport, isTestnet: true });
    await client.cancelByCloid({ cancels: [{ asset: 1, cloid: "0x1" }] });
    await client.cancelByCloid({ cancels: [{ asset: 1, cloid: "0x1" }] });
    await client.cancelByCloid({ cancels: [{ asset: 2, cloid: "0x2" }] });
    const cloids = signCalls.map((c) => (c as { cloid: string }).cloid);
    expect(cloids[0]).toBe(cloids[1]);
    expect(cloids[0]).not.toBe(cloids[2]);
  });
});

describe("makeSignerBackedExchangeClient.scheduleCancel", () => {
  it("signs scheduleCancel with a time and submits the action", async () => {
    const { signer, signCalls, reconcileCalls } = fakeSigner();
    const { transport, calls } = fakeTransport({});
    const client = makeSignerBackedExchangeClient({ keyId: "k", signer, transport, isTestnet: false });
    await client.scheduleCancel({ time: 1_700_000_000_000 });
    const call = signCalls[0] as { kind: string; params: unknown; cloid: string };
    expect(call.kind).toBe("scheduleCancel");
    expect(call.params).toEqual({ time: 1_700_000_000_000 });
    expect(call.cloid).toMatch(/^0x[0-9a-f]{32}$/);
    expect(calls[0].payload).toEqual({
      action: { type: "scheduleCancel", time: 1_700_000_000_000 },
      signature: { r: "0xr", s: "0xs", v: 27 },
      nonce: 42,
    });
    expect(reconcileCalls).toEqual([]);
  });

  it("signs a bare scheduleCancel (clear) when no time is given", async () => {
    const { signer, signCalls } = fakeSigner();
    const { transport, calls } = fakeTransport({});
    const client = makeSignerBackedExchangeClient({ keyId: "k", signer, transport, isTestnet: false });
    await client.scheduleCancel({});
    expect((signCalls[0] as { params: unknown }).params).toEqual({});
    expect((calls[0].payload as { action: unknown }).action).toEqual({ type: "scheduleCancel" });
  });
});
