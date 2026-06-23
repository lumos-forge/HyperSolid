import { DepositService, type ArbitrumDepositClient } from "./deposit";

const BRIDGE_MAINNET = "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7";

function fakeClient(impl?: () => Promise<string>): ArbitrumDepositClient & { arg?: unknown } {
  const self: ArbitrumDepositClient & { arg?: unknown } = {
    transferUsdc: jest.fn(async (p) => {
      self.arg = p;
      return impl ? impl() : "0xtxhash";
    }),
  };
  return self;
}

describe("DepositService.depositUsdc", () => {
  it("rejects below the 5 USDC minimum without a chain call", async () => {
    const client = fakeClient();
    const svc = new DepositService(client, "testnet");
    const res = await svc.depositUsdc({ amount: 4 });
    expect(res.ok).toBe(false);
    expect(client.transferUsdc).not.toHaveBeenCalled();
  });

  it("on mainnet, refuses to send without the second confirmation", async () => {
    const client = fakeClient();
    const svc = new DepositService(client, "mainnet");
    const res = await svc.depositUsdc({ amount: 10, confirmed: false });
    expect(res.ok).toBe(false);
    expect(client.transferUsdc).not.toHaveBeenCalled();
  });

  it("on mainnet with confirmation, transfers to the bridge in 6-decimal base units", async () => {
    const client = fakeClient();
    const svc = new DepositService(client, "mainnet");
    const res = await svc.depositUsdc({ amount: 10, confirmed: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.txHash).toBe("0xtxhash");
    expect(client.arg).toEqual({
      usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      bridge: BRIDGE_MAINNET,
      amountBaseUnits: 10_000_000n,
    });
  });

  it("on testnet, a valid deposit needs no extra confirmation", async () => {
    const client = fakeClient();
    const svc = new DepositService(client, "testnet");
    const res = await svc.depositUsdc({ amount: 5 });
    expect(res.ok).toBe(true);
    expect(client.transferUsdc).toHaveBeenCalled();
  });

  it("treats a thrown send as uncertain, not failed", async () => {
    const client = fakeClient(() => {
      throw new Error("rpc down");
    });
    const svc = new DepositService(client, "testnet");
    const res = await svc.depositUsdc({ amount: 5 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.uncertain).toBe(true);
  });
});
