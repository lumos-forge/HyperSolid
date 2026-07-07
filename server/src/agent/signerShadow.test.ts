import { makeShadowVerifier, SHADOW_NONCE } from "./signerShadow";
import { createL1ActionHash } from "@nktkas/hyperliquid/signing";

const orderParams = { asset: 0, isBuy: true, px: "50000", sz: "0.01", reduceOnly: false, tif: "Ioc", grouping: "na", cloid: "0x00000000000000000000000000000001" };

function expectedLocalHash(): string {
  const o: Record<string, unknown> = { a: 0, b: true, p: "50000", s: "0.01", r: false, t: { limit: { tif: "Ioc" } }, c: "0x00000000000000000000000000000001" };
  return createL1ActionHash({ action: { type: "order", orders: [o], grouping: "na" }, nonce: SHADOW_NONCE });
}

const cancelParams = { cancels: [{ asset: 0, cloid: "0x00000000000000000000000000000001" }] };

function expectedCancelHash(): string {
  return createL1ActionHash({
    action: { type: "cancelByCloid", cancels: [{ asset: 0, cloid: "0x00000000000000000000000000000001" }] },
    nonce: SHADOW_NONCE,
  });
}

const flush = () => new Promise((r) => setImmediate(r));

function fetchReturning(hash: string, ok = true, status = 200) {
  return jest.fn(async () => ({ ok, status, json: async () => ({ actionHash: hash }) }));
}

describe("makeShadowVerifier", () => {
  it("no warn when hashes match (real @nktkas hash)", async () => {
    const warn = jest.fn();
    const f = fetchReturning(expectedLocalHash());
    const verify = makeShadowVerifier({ url: "http://x", fetchImpl: f as never, logger: { warn, debug: jest.fn() } });
    verify("order", orderParams);
    await flush();
    expect(f).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns on mismatch", async () => {
    const warn = jest.fn();
    const f = fetchReturning("0xdeadbeef");
    const verify = makeShadowVerifier({ url: "http://x", fetchImpl: f as never, logger: { warn, debug: jest.fn() } });
    verify("order", orderParams);
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("swallows fetch rejection", async () => {
    const warn = jest.fn();
    const f = jest.fn(async () => { throw new Error("network"); });
    const verify = makeShadowVerifier({ url: "http://x", fetchImpl: f as never, logger: { warn, debug: jest.fn() } });
    expect(() => verify("order", orderParams)).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("no-op for unsupported kind (no fetch)", async () => {
    const f = fetchReturning("0x00");
    const verify = makeShadowVerifier({ url: "http://x", fetchImpl: f as never });
    verify("updateLeverage", { asset: 0, isCross: true, leverage: 5 });
    await flush();
    expect(f).not.toHaveBeenCalled();
  });

  it("no warn for a matching cancelByCloid (real @nktkas hash)", async () => {
    const warn = jest.fn();
    const f = fetchReturning(expectedCancelHash());
    const verify = makeShadowVerifier({ url: "http://x", fetchImpl: f as never, logger: { warn, debug: jest.fn() } });
    verify("cancelByCloid", cancelParams);
    await flush();
    expect(f).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("aborts and swallows a hung fetch after the timeout", async () => {
    const warn = jest.fn();
    const f = jest.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const verify = makeShadowVerifier({ url: "http://x", fetchImpl: f as never, timeoutMs: 20, logger: { warn, debug: jest.fn() } });
    verify("order", orderParams);
    await new Promise((r) => setTimeout(r, 150));
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
