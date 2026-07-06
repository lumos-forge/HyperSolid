import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Auth } from "../auth/auth";
import type { AgentManager } from "../agent/agentManager";
import type { StrategyStore } from "../strategies/store";
import type { Strategy, StrategyKind, GridLimitParams } from "../strategies/types";
import { validateParams } from "../strategies/validate";
import type { ActivityStore } from "../strategies/activityStore";
import type { AppConfigPayload } from "../config/appConfig";
import { resolveGeo, type GeoHeaderConfig } from "./geo";
import { rungCount, rungBuyPrice, rungSellPrice } from "../strategies/gridLimit";

export interface AppDeps {
  auth: Auth;
  agents: AgentManager;
  store: StrategyStore;
  activity?: ActivityStore;
  now?: () => number;
  /** Agent approval lifetime applied on confirm (default ~90 days). */
  agentTtlMs?: number;
  /** Reported by GET /health. */
  version?: string;
  /** Enable Fastify request logging (off by default). */
  logger?: boolean;
  /** Served by GET /app-config (server-delivered runtime config for the app). */
  appConfig?: AppConfigPayload;
  /** Header names to read the caller's country/region from on GET /app-config. */
  geoHeaders?: GeoHeaderConfig;
}

interface StrategyDto {
  id: string;
  type: StrategyKind;
  status: string;
  params: Strategy["params"];
  filledTotalUsdc?: number;
  nextRunAt?: number;
  slicesDone?: number;
  triggeredAt?: number;
  lastLevel?: number;
  armedCount?: number;
  holdingCount?: number;
}

function toDto(s: Strategy, store: StrategyStore): StrategyDto {
  const summary =
    s.kind === "gridLimit"
      ? (() => {
          const rungs = store.gridLimitRungs(s.id);
          return { armedCount: rungs.filter((r) => r.state === "armed").length, holdingCount: rungs.filter((r) => r.state === "holding").length };
        })()
      : {};
  return {
    id: s.id,
    type: s.kind,
    status: s.status,
    params: s.params,
    ...summary,
    ...(s.filledTotalUsdc !== undefined ? { filledTotalUsdc: s.filledTotalUsdc } : {}),
    ...(s.nextRunAt !== undefined ? { nextRunAt: s.nextRunAt } : {}),
    ...(s.slicesDone !== undefined ? { slicesDone: s.slicesDone } : {}),
    ...(s.triggeredAt !== undefined ? { triggeredAt: s.triggeredAt } : {}),
    ...(s.lastLevel !== undefined ? { lastLevel: s.lastLevel } : {}),
  };
}

/**
 * The App↔backend HTTP contract (Fastify). Auth routes are public; everything else requires a bearer
 * session token and derives `owner` from it (never the body), so a caller can only touch its own
 * agent + strategies. Returns a configured instance — `index.ts` wires real deps and listens; tests
 * use `inject`.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const now = deps.now ?? (() => Date.now());
  const agentTtlMs = deps.agentTtlMs ?? 90 * 24 * 3600 * 1000;
  const version = deps.version ?? "0.1.0";
  const app = Fastify({ logger: deps.logger ?? false });

  // The app's client sends Content-Type: application/json even for bodyless POSTs (provision/revoke/
  // kill-switch); treat an empty JSON body as {} instead of FST_ERR_CTP_EMPTY_JSON_BODY.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = (body as string).trim();
    if (text.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  // --- health (public) ---
  app.get("/health", async () => ({ ok: true, version }));

  // --- runtime config the app fetches at startup (public; values are non-secret keyed endpoints) ---
  const appConfig: AppConfigPayload =
    deps.appConfig ?? { arbitrumRpc: { mainnet: null, testnet: null }, withdrawFeeUsdc: { mainnet: null, testnet: null }, strategyApiBaseUrl: null };
  const geoHeaders: GeoHeaderConfig = deps.geoHeaders ?? { countryHeader: "cf-ipcountry", regionHeader: "cf-region" };
  app.get("/app-config", async (req) => {
    const geo = resolveGeo(req.headers, geoHeaders);
    return geo ? { ...appConfig, geo } : appConfig;
  });

  const ownerOf = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    const owner = token ? deps.auth.verify(token, now()) : null;
    if (!owner) {
      reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    return owner;
  };

  // --- public auth routes ---
  app.post("/auth/challenge", async (req) => {
    const { owner } = req.body as { owner: string };
    return deps.auth.challenge(owner, now());
  });

  app.post("/auth/session", async (req, reply) => {
    const { owner, nonce, signature } = req.body as { owner: string; nonce: string; signature: string };
    try {
      return await deps.auth.session(owner, nonce, signature, now());
    } catch (e) {
      return reply.code(401).send({ error: (e as Error).message });
    }
  });

  // --- agent ---
  app.post("/agent/provision", async (req, reply) => {
    const owner = ownerOf(req, reply);
    if (!owner) return;
    return deps.agents.provision(owner);
  });

  app.post("/agent/confirm", async (req, reply) => {
    const owner = ownerOf(req, reply);
    if (!owner) return;
    const { agentAddress } = req.body as { agentAddress: string };
    try {
      deps.agents.confirm(owner, agentAddress, now() + agentTtlMs);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    return reply.code(204).send();
  });

  app.get("/agent/status", async (req, reply) => {
    const owner = ownerOf(req, reply);
    if (!owner) return;
    return deps.agents.status(owner, now());
  });

  app.post("/agent/revoke", async (req, reply) => {
    const owner = ownerOf(req, reply);
    if (!owner) return;
    deps.agents.revoke(owner);
    return reply.code(204).send();
  });

  // --- strategies ---
  app.get("/strategies", async (req, reply) => {
    const owner = ownerOf(req, reply);
    if (!owner) return;
    return deps.store.list(owner).map((s) => toDto(s, deps.store));
  });

  app.post("/strategies", async (req, reply) => {
    const owner = ownerOf(req, reply);
    if (!owner) return;
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return reply.code(400).send({ error: "invalid strategy body" });
    }
    const { type, params } = req.body as { type: StrategyKind; params: unknown };
    const v = validateParams(type, params);
    if (!v.ok) return reply.code(400).send({ error: v.error });
    return toDto(deps.store.create(owner, type, v.params), deps.store);
  });

  const ownedStrategy = (owner: string, id: string, reply: FastifyReply): Strategy | null => {
    const s = deps.store.get(id);
    if (!s || s.owner.toLowerCase() !== owner.toLowerCase()) {
      reply.code(404).send({ error: "not found" });
      return null;
    }
    return s;
  };

  app.patch("/strategies/:id", async (req, reply) => {
    const owner = ownerOf(req, reply);
    if (!owner) return;
    const { id } = req.params as { id: string };
    const s = ownedStrategy(owner, id, reply);
    if (!s) return;
    // A canceling strategy is being deleted (its resting orders are draining); reject status changes
    // so a stray PATCH can't resurrect it (canceling->running would re-arm; canceling->paused would
    // leave it alive forever since the removal condition never fires again).
    if (s.status === "canceling") return reply.code(409).send({ error: "strategy is canceling" });
    const { status } = req.body as { status: "running" | "paused" };
    deps.store.setStatus(id, status);
    return toDto(deps.store.get(id)!, deps.store);
  });

  app.delete("/strategies/:id", async (req, reply) => {
    const owner = ownerOf(req, reply);
    if (!owner) return;
    const { id } = req.params as { id: string };
    const s = ownedStrategy(owner, id, reply);
    if (!s) return;
    if (s.kind === "gridLimit") {
      // Async drain-then-remove: mark for cancellation; the scheduler cancels resting orders and
      // removes the strategy once nothing is left resting. A repeat DELETE is an idempotent no-op so
      // an in-flight drain is never short-circuited into orphaning live orders.
      if (s.status !== "canceling") deps.store.setStatus(id, "canceling");
    } else {
      deps.store.remove(id);
    }
    return reply.code(204).send();
  });

  app.get("/strategies/:id/activity", async (req, reply) => {
    const owner = ownerOf(req, reply);
    if (!owner) return;
    const { id } = req.params as { id: string };
    if (!ownedStrategy(owner, id, reply)) return;
    return (deps.activity?.list(owner, id) ?? []).map((a) => ({
      id: a.id,
      time: a.time,
      coin: a.coin,
      side: a.side,
      sz: a.sz,
      px: a.px,
    }));
  });

  app.get("/strategies/:id/rungs", async (req, reply) => {
    const owner = ownerOf(req, reply);
    if (!owner) return;
    const { id } = req.params as { id: string };
    const s = ownedStrategy(owner, id, reply);
    if (!s) return;
    if (s.kind !== "gridLimit") return [];
    const p = s.params as GridLimitParams;
    const state = new Map(deps.store.gridLimitRungs(id).map((r) => [r.rung, r.state]));
    const out: Array<{ rung: number; state: string; buyPrice: number; sellPrice: number }> = [];
    for (let i = 0; i < rungCount(p); i++) {
      out.push({ rung: i, state: state.get(i) ?? "idle", buyPrice: rungBuyPrice(p, i), sellPrice: rungSellPrice(p, i) });
    }
    return out;
  });

  // --- owner-wide recent activity feed ---
  app.get("/activity", async (req, reply) => {
    const owner = ownerOf(req, reply);
    if (!owner) return;
    const raw = Number((req.query as { limit?: string }).limit);
    const limit = Number.isFinite(raw) && raw >= 1 ? Math.min(200, Math.floor(raw)) : 50;
    return (deps.activity?.listRecent(owner, limit) ?? []).map((a) => ({
      id: a.id, time: a.time, coin: a.coin, side: a.side, sz: a.sz, px: a.px,
    }));
  });

  // --- kill switch: hard-stop the owner's automation by pausing every running strategy ---
  app.post("/kill-switch", async (req, reply) => {
    const owner = ownerOf(req, reply);
    if (!owner) return;
    for (const s of deps.store.list(owner)) {
      if (s.status === "running") deps.store.setStatus(s.id, "paused");
    }
    return reply.code(204).send();
  });

  return app;
}
