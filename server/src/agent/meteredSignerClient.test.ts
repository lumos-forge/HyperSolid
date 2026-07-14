import { MeteredSignerClient } from "./meteredSignerClient";
import { SignerError } from "./signerClient";
import { metricsText, resetMetrics } from "../obs/metrics";

type Init = { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };
function fakeFetch(handler: (url: string, init?: Init) => { ok: boolean; status: number; body?: unknown }) {
  const f = async (url: string, init?: Init) => {
    const r = handler(url, init);
    return {
      ok: r.ok,
      status: r.status,
      json: async () => {
        if (r.body === undefined) throw new SyntaxError("Unexpected end of JSON input");
        return r.body;
      },
    };
  };
  return f as never;
}

describe("MeteredSignerClient", () => {
  beforeEach(() => resetMetrics());

  it("records an ok signer request and still returns the result", async () => {
    const f = fakeFetch(() => ({ ok: true, status: 200, body: { r: "0x1", s: "0x2", v: 27, nonce: 5, duplicate: false } }));
    const c = new MeteredSignerClient("http://signer", f);
    await expect(c.sign({ keyId: "k1", kind: "order", params: {}, cloid: "0x" + "1".repeat(32), isTestnet: true })).resolves.toMatchObject({ nonce: 5 });
    const text = await metricsText();
    expect(text).toContain('hypersolid_engine_signer_requests_total{op="sign",result="ok"} 1');
    expect(text).toContain('hypersolid_engine_signer_request_duration_seconds_count{op="sign"} 1');
  });

  it("records an error signer request and rethrows", async () => {
    const f = fakeFetch(() => ({ ok: false, status: 503, body: { error: "not leader" } }));
    const c = new MeteredSignerClient("http://signer", f);
    await expect(c.createKey({ keyId: "k1" })).rejects.toBeInstanceOf(SignerError);
    const text = await metricsText();
    expect(text).toContain('hypersolid_engine_signer_requests_total{op="createKey",result="error"} 1');
  });

  it("meters reconcile", async () => {
    const f = fakeFetch(() => ({ ok: true, status: 204 }));
    const c = new MeteredSignerClient("http://signer", f);
    await expect(c.reconcile("k1", "0x" + "1".repeat(32), "filled")).resolves.toBeUndefined();
    const text = await metricsText();
    expect(text).toContain('hypersolid_engine_signer_requests_total{op="reconcile",result="ok"} 1');
  });
});
