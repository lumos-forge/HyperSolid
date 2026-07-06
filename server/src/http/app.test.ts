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
    expect(created.params).toEqual(params);
    expect(created.filledTotalUsdc).toBe(0);
    expect(created.nextRunAt).toBe(1000);

    const listed = (await app.inject({ method: "GET", url: "/strategies", headers: auth })).json();
    expect(listed).toEqual([expect.objectContaining({ id: created.id, type: "dca", params, filledTotalUsdc: 0, nextRunAt: 1000 })]);

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

  it("rejects an invalid strategy with 400", async () => {
    const app = build();
    const token = await tokenFor(app);
    const auth = { authorization: `Bearer ${token}` };
    const res = await app.inject({ method: "POST", url: "/strategies", headers: auth, payload: { type: "dca", params: { coin: "BTC", side: "buy", quoteAmountUsdc: 0, intervalHours: 24 } } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects missing or null strategy bodies with 400", async () => {
    const app = build();
    const token = await tokenFor(app);
    const auth = { authorization: `Bearer ${token}` };

    expect((await app.inject({ method: "POST", url: "/strategies", headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/strategies", headers: { ...auth, "content-type": "application/json" }, payload: "null" })).statusCode).toBe(400);
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

  it("GET /activity requires auth", async () => {
    const app = build();
    const res = await app.inject({ method: "GET", url: "/activity" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("GET /activity returns owner-wide newest-first DTOs honoring limit", async () => {
    const auth0 = new Auth({ secret: "s", genNonce: () => "n", nonceTtlMs: 1e9, sessionTtlMs: 1e9 });
    const agents = new AgentManager(new MemoryAgentStore(), () => AGENT_PK);
    const store = new MemoryStrategyStore(() => 1000);
    const activity = new MemoryActivityStore();
    const app = buildApp({ auth: auth0, agents, store, activity, now: () => 1000 });
    const token = await tokenFor(app);
    const headers = { authorization: `Bearer ${token}` };

    activity.record({ strategyId: "s1", owner: account.address, time: 100, coin: "BTC", side: "buy", sz: 0.1, px: 50000 });
    activity.record({ strategyId: "s2", owner: account.address, time: 300, coin: "ETH", side: "sell", sz: 1, px: 1600 });
    activity.record({ strategyId: "s1", owner: account.address, time: 200, coin: "BTC", side: "buy", sz: 0.2, px: 51000 });

    const all = (await app.inject({ method: "GET", url: "/activity", headers })).json();
    expect(all.map((a: { time: number }) => a.time)).toEqual([300, 200, 100]);
    expect(all[0]).toEqual({ id: expect.any(String), time: 300, coin: "ETH", side: "sell", sz: 1, px: 1600 });

    const limited = (await app.inject({ method: "GET", url: "/activity?limit=1", headers })).json();
    expect(limited).toHaveLength(1);
    expect(limited[0].time).toBe(300);

    // an empty/non-numeric limit falls back to the default (returns all 3), not clamps to 1
    const empty = (await app.inject({ method: "GET", url: "/activity?limit=", headers })).json();
    expect(empty).toHaveLength(3);
    await app.close();
  });

  it("serves a public /health with version and no auth required", async () => {
    const app = build();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: "0.1.0" });
    await app.close();
  });

  it("serves public GET /app-config (the app's server-delivered runtime config)", async () => {
    const auth0 = new Auth({ secret: "s", genNonce: () => "n", nonceTtlMs: 1e9, sessionTtlMs: 1e9 });
    const agents = new AgentManager(new MemoryAgentStore(), () => AGENT_PK);
    const store = new MemoryStrategyStore(() => 1000);
    const appConfig = {
      arbitrumRpc: { mainnet: null, testnet: "https://arb-test/key" },
      withdrawFeeUsdc: { mainnet: 1, testnet: 0 },
      strategyApiBaseUrl: "https://api.example",
    };
    const app = buildApp({ auth: auth0, agents, store, appConfig });
    const res = await app.inject({ method: "GET", url: "/app-config" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(appConfig);
    await app.close();
  });

  it("adds geo to /app-config from the request country header", async () => {
    const auth0 = new Auth({ secret: "s", genNonce: () => "n", nonceTtlMs: 1e9, sessionTtlMs: 1e9 });
    const agents = new AgentManager(new MemoryAgentStore(), () => AGENT_PK);
    const store = new MemoryStrategyStore(() => 1000);
    const app = buildApp({ auth: auth0, agents, store, geoHeaders: { countryHeader: "cf-ipcountry", regionHeader: "cf-region" } });
    const res = await app.inject({ method: "GET", url: "/app-config", headers: { "cf-ipcountry": "US" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().geo).toEqual({ country: "US" });
    await app.close();
  });

  it("omits geo from /app-config when no country header is present", async () => {
    const auth0 = new Auth({ secret: "s", genNonce: () => "n", nonceTtlMs: 1e9, sessionTtlMs: 1e9 });
    const agents = new AgentManager(new MemoryAgentStore(), () => AGENT_PK);
    const store = new MemoryStrategyStore(() => 1000);
    const app = buildApp({ auth: auth0, agents, store });
    const res = await app.inject({ method: "GET", url: "/app-config" });
    expect(res.json().geo).toBeUndefined();
    await app.close();
  });

  it("accepts bodyless POSTs that still set Content-Type: application/json (as the app's client does)", async () => {
    // The mobile StrategyApi sends Content-Type: application/json even with no body for
    // provision/revoke/kill-switch; the server must not reject those with FST_ERR_CTP_EMPTY_JSON_BODY.
    const app = build();
    const token = await tokenFor(app);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const prov = await app.inject({ method: "POST", url: "/agent/provision", headers });
    expect(prov.statusCode).toBe(200);
    expect(prov.json().agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const ks = await app.inject({ method: "POST", url: "/kill-switch", headers });
    expect(ks.statusCode).toBe(204);
    await app.close();
  });

  it("creates a grid strategy and returns it", async () => {
    const app = build();
    const token = await tokenFor(app);
    const auth = { authorization: `Bearer ${token}` };
    const res = await app.inject({
      method: "POST",
      url: "/strategies",
      headers: auth,
      payload: { type: "grid", params: { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ type: "grid", status: "running", params: { levels: 6 } });
  });

  it("rejects an invalid grid (upper <= lower) with 400", async () => {
    const app = build();
    const token = await tokenFor(app);
    const auth = { authorization: `Bearer ${token}` };
    const res = await app.inject({
      method: "POST",
      url: "/strategies",
      headers: auth,
      payload: { type: "grid", params: { coin: "BTC", lowerPrice: 200, upperPrice: 100, levels: 6, perLevelUsdc: 50 } },
    });
    expect(res.statusCode).toBe(400);
  });
});

function buildWithStore() {
  const auth = new Auth({ secret: "s", genNonce: () => "n", nonceTtlMs: 1e9, sessionTtlMs: 1e9 });
  const agents = new AgentManager(new MemoryAgentStore(), () => AGENT_PK);
  const store = new MemoryStrategyStore(() => 1000);
  const app = buildApp({ auth, agents, store, now: () => 1000, agentTtlMs: 90 * 24 * 3600 * 1000 });
  return { app, store };
}

describe("gridLimit HTTP", () => {
  const glParams = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 };

  it("creates a gridLimit strategy and lists it with an armed/holding summary", async () => {
    const { app, store } = buildWithStore();
    const auth = { authorization: `Bearer ${await tokenFor(app)}` };
    const created = await app.inject({ method: "POST", url: "/strategies", headers: auth, payload: { type: "gridLimit", params: glParams } });
    expect(created.statusCode).toBe(200);
    const id = created.json().id as string;
    store.setGridLimitRung(id, { rung: 0, state: "armed", side: "buy", cloid: "0xa", px: 100, seq: 1 });
    store.setGridLimitRung(id, { rung: 1, state: "holding", side: "sell", cloid: "0xb", px: 140, seq: 2 });
    const dto = (await app.inject({ method: "GET", url: "/strategies", headers: auth })).json().find((d: any) => d.id === id);
    expect(dto).toMatchObject({ type: "gridLimit", armedCount: 1, holdingCount: 1 });
  });

  it("DELETE of a gridLimit marks it canceling (not immediately removed)", async () => {
    const { app, store } = buildWithStore();
    const auth = { authorization: `Bearer ${await tokenFor(app)}` };
    const created = await app.inject({ method: "POST", url: "/strategies", headers: auth, payload: { type: "gridLimit", params: glParams } });
    const id = created.json().id as string;
    const del = await app.inject({ method: "DELETE", url: `/strategies/${id}`, headers: auth });
    expect(del.statusCode).toBe(204);
    expect(store.get(id)!.status).toBe("canceling");
  });

  it("is idempotent: a repeat DELETE on a canceling gridLimit does not remove it mid-drain", async () => {
    const { app, store } = buildWithStore();
    const auth = { authorization: `Bearer ${await tokenFor(app)}` };
    const created = await app.inject({ method: "POST", url: "/strategies", headers: auth, payload: { type: "gridLimit", params: glParams } });
    const id = created.json().id as string;
    await app.inject({ method: "DELETE", url: `/strategies/${id}`, headers: auth });
    const del2 = await app.inject({ method: "DELETE", url: `/strategies/${id}`, headers: auth });
    expect(del2.statusCode).toBe(204);
    expect(store.get(id)!.status).toBe("canceling"); // still present + canceling, not removed
  });

  it("rejects a PATCH on a canceling gridLimit so a delete cannot be undone", async () => {
    const { app, store } = buildWithStore();
    const auth = { authorization: `Bearer ${await tokenFor(app)}` };
    const created = await app.inject({ method: "POST", url: "/strategies", headers: auth, payload: { type: "gridLimit", params: glParams } });
    const id = created.json().id as string;
    await app.inject({ method: "DELETE", url: `/strategies/${id}`, headers: auth }); // -> canceling
    const patch = await app.inject({ method: "PATCH", url: `/strategies/${id}`, headers: auth, payload: { status: "running" } });
    expect(patch.statusCode).toBe(409);
    expect(store.get(id)!.status).toBe("canceling");
  });
});
