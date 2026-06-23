import { privateKeyToAccount } from "viem/accounts";
import { buildApp } from "./app";
import { Auth } from "../auth/auth";
import { AgentManager, MemoryAgentStore } from "../agent/agentManager";
import { MemoryStrategyStore } from "../strategies/store";
import { MemoryActivityStore } from "../strategies/activityStore";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const AGENT_PK = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as const;
const account = privateKeyToAccount(PK);

function build() {
  const auth = new Auth({ secret: "s", genNonce: () => "n", nonceTtlMs: 1e9, sessionTtlMs: 1e9 });
  const agents = new AgentManager(new MemoryAgentStore(), () => AGENT_PK);
  const store = new MemoryStrategyStore(() => 1000);
  return buildApp({ auth, agents, store, now: () => 1000, agentTtlMs: 90 * 24 * 3600 * 1000 });
}

async function tokenFor(app: ReturnType<typeof build>): Promise<string> {
  const ch = await app.inject({ method: "POST", url: "/auth/challenge", payload: { owner: account.address } });
  const { nonce } = ch.json();
  const signature = await account.signMessage({ message: nonce });
  const se = await app.inject({ method: "POST", url: "/auth/session", payload: { owner: account.address, nonce, signature } });
  return se.json().token as string;
}

describe("HTTP app", () => {
  it("rejects authed routes without a bearer token", async () => {
    const app = build();
    const res = await app.inject({ method: "GET", url: "/strategies" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("runs the agent provision → confirm → status lifecycle for the authed owner", async () => {
    const app = build();
    const token = await tokenFor(app);
    const auth = { authorization: `Bearer ${token}` };

    const prov = await app.inject({ method: "POST", url: "/agent/provision", headers: auth });
    const { agentAddress } = prov.json();
    expect(agentAddress).toBe(privateKeyToAccount(AGENT_PK).address);

    expect((await app.inject({ method: "GET", url: "/agent/status", headers: auth })).json().approved).toBe(false);

    const conf = await app.inject({ method: "POST", url: "/agent/confirm", headers: auth, payload: { agentAddress } });
    expect(conf.statusCode).toBe(204);

    const st = (await app.inject({ method: "GET", url: "/agent/status", headers: auth })).json();
    expect(st.approved).toBe(true);
    expect(st.validUntil).toBe(1000 + 90 * 24 * 3600 * 1000);
    await app.close();
  });

  it("creates, lists, toggles, kill-switches, and deletes strategies scoped to the owner", async () => {
    const app = build();
    const token = await tokenFor(app);
    const auth = { authorization: `Bearer ${token}` };
    const params = { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 };

    const created = (await app.inject({ method: "POST", url: "/strategies", headers: auth, payload: { type: "dca", params } })).json();
    expect(created.type).toBe("dca");
    expect(created.status).toBe("running");

    expect((await app.inject({ method: "GET", url: "/strategies", headers: auth })).json()).toHaveLength(1);

    const patched = (await app.inject({ method: "PATCH", url: `/strategies/${created.id}`, headers: auth, payload: { status: "paused" } })).json();
    expect(patched.status).toBe("paused");

    // re-run a strategy, then kill-switch must pause everything
    await app.inject({ method: "PATCH", url: `/strategies/${created.id}`, headers: auth, payload: { status: "running" } });
    expect((await app.inject({ method: "POST", url: "/kill-switch", headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/strategies", headers: auth })).json()[0].status).toBe("paused");

    expect((await app.inject({ method: "DELETE", url: `/strategies/${created.id}`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/strategies", headers: auth })).json()).toHaveLength(0);
    await app.close();
  });

  it("404s when patching a strategy the caller does not own", async () => {
    const app = build();
    const token = await tokenFor(app);
    const auth = { authorization: `Bearer ${token}` };
    const res = await app.inject({ method: "PATCH", url: "/strategies/does-not-exist", headers: auth, payload: { status: "paused" } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns recorded activity (DTO) for an owned strategy", async () => {
    const auth0 = new Auth({ secret: "s", genNonce: () => "n", nonceTtlMs: 1e9, sessionTtlMs: 1e9 });
    const agents = new AgentManager(new MemoryAgentStore(), () => AGENT_PK);
    const store = new MemoryStrategyStore(() => 1000);
    const activity = new MemoryActivityStore();
    const app = buildApp({ auth: auth0, agents, store, activity, now: () => 1000 });
    const token = await tokenFor(app);
    const headers = { authorization: `Bearer ${token}` };

    const created = (await app.inject({ method: "POST", url: "/strategies", headers, payload: { type: "dca", params: { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 } } })).json();
    activity.record({ strategyId: created.id, owner: account.address, time: 1500, coin: "BTC", side: "buy", sz: 0.001, px: 50000 });

    const list = (await app.inject({ method: "GET", url: `/strategies/${created.id}/activity`, headers })).json();
    expect(list).toEqual([{ id: expect.any(String), time: 1500, coin: "BTC", side: "buy", sz: 0.001, px: 50000 }]);
    await app.close();
  });

  it("serves a public /health with version and no auth required", async () => {
    const app = build();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: "0.1.0" });
    await app.close();
  });
});
