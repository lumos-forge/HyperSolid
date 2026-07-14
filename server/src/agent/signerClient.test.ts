import { SignerClient, SignerError } from "./signerClient";

type Init = { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };
function fakeFetch(handler: (url: string, init?: Init) => { ok: boolean; status: number; body?: unknown }) {
  const calls: { url: string; init?: Init }[] = [];
  const f = async (url: string, init?: Init) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return {
      ok: r.ok,
      status: r.status,
      // Mimic real fetch: json() on an empty body throws (e.g. a 204 No Content).
      json: async () => {
        if (r.body === undefined) throw new SyntaxError("Unexpected end of JSON input");
        return r.body;
      },
    };
  };
  return { f: f as never, calls };
}

describe("SignerClient", () => {
  it("createKey posts to /v1/keys and returns the address", async () => {
    const { f, calls } = fakeFetch(() => ({ ok: true, status: 200, body: { keyId: "k1", agentAddress: "0xabc" } }));
    const c = new SignerClient("http://signer", f);
    await expect(c.createKey({ keyId: "k1", ownerAddress: "0xowner", allowedKinds: ["order"] })).resolves.toEqual({ keyId: "k1", agentAddress: "0xabc" });
    expect(calls[0].url).toBe("http://signer/v1/keys");
    expect(calls[0].init?.method).toBe("POST");
  });

  it("maps 503 to a retryable notLeader error", async () => {
    const { f } = fakeFetch(() => ({ ok: false, status: 503, body: { error: "not leader" } }));
    const c = new SignerClient("http://signer", f);
    await expect(c.createKey({ keyId: "k1" })).rejects.toMatchObject({ code: "notLeader", retryable: true, status: 503 });
  });

  it("deleteKey issues a DELETE and resolves on 204", async () => {
    const { f, calls } = fakeFetch(() => ({ ok: true, status: 204 }));
    const c = new SignerClient("http://signer", f);
    await expect(c.deleteKey("k1")).resolves.toBeUndefined();
    expect(calls[0].url).toBe("http://signer/v1/keys/k1");
    expect(calls[0].init?.method).toBe("DELETE");
  });

  it("sign returns the signature and maps error statuses", async () => {
    const okFetch = fakeFetch(() => ({ ok: true, status: 200, body: { r: "0x1", s: "0x2", v: 27, nonce: 5, duplicate: false } }));
    const c = new SignerClient("http://signer", okFetch.f);
    await expect(c.sign({ keyId: "k1", kind: "order", params: {}, cloid: "0x" + "1".repeat(32), isTestnet: true }))
      .resolves.toEqual({ r: "0x1", s: "0x2", v: 27, nonce: 5, duplicate: false });
    expect(okFetch.calls[0].url).toBe("http://signer/v1/sign/l1");

    const cases: Array<[number, string, string, boolean]> = [
      [403, "denied", "policy", false],
      [404, "unknown keyId", "notFound", false],
      [409, "cloid reuse mismatch", "cloidReuse", false],
      [409, "fenced", "fenced", true],
      [429, "rate limit exceeded", "rateLimit", true],
      [500, "sign failed", "server", true],
    ];
    for (const [status, msg, code, retryable] of cases) {
      const { f } = fakeFetch(() => ({ ok: false, status, body: { error: msg } }));
      const cc = new SignerClient("http://signer", f);
      await expect(cc.sign({ keyId: "k1", kind: "order", params: {}, cloid: "0x1", isTestnet: false }))
        .rejects.toMatchObject({ code, retryable, status });
    }
  });

  it("maps a thrown fetch (network/timeout) to a retryable network error", async () => {
    const f = (async () => { throw new Error("boom"); }) as never;
    const c = new SignerClient("http://signer", f);
    await expect(c.sign({ keyId: "k1", kind: "order", params: {}, cloid: "0x1", isTestnet: false }))
      .rejects.toMatchObject({ code: "network", retryable: true });
  });

  it("reconcile posts to /v1/reconcile and resolves on 200", async () => {
    const { f, calls } = fakeFetch(() => ({ ok: true, status: 200, body: { status: "submitted" } }));
    const c = new SignerClient("http://signer", f);
    await expect(c.reconcile("k1", "0xcloid", "submitted")).resolves.toBeUndefined();
    expect(calls[0].url).toBe("http://signer/v1/reconcile");
  });

  it("maps reconcile's 409 invalid transition to a non-retryable code", async () => {
    const { f } = fakeFetch(() => ({ ok: false, status: 409, body: { error: "invalid transition" } }));
    const c = new SignerClient("http://signer", f);
    await expect(c.reconcile("k1", "0xcloid", "filled")).rejects.toMatchObject({ code: "invalidTransition", retryable: false, status: 409 });
  });
});
