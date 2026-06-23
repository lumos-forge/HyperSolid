import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Auth } from "../auth/auth";
import type { AgentManager } from "../agent/agentManager";
import type { StrategyStore } from "../strategies/store";
import type { DcaParams, DcaStrategy } from "../strategies/dca";
import type { ActivityStore } from "../strategies/activityStore";

export interface AppDeps {
  auth: Auth;
  agents: AgentManager;
  store: StrategyStore;
  activity?: ActivityStore;
  now?: () => number;
  /** Agent approval lifetime applied on confirm (default ~90 days). */
  agentTtlMs?: number;
}

interface StrategyDto {
  id: string;
  type: "dca";
  params: DcaParams;
  status: "running" | "paused";
  filledTotalUsdc: number;
  nextRunAt: number;
}

function toDto(s: DcaStrategy): StrategyDto {
  return { id: s.id, type: "dca", params: s.params, status: s.status, filledTotalUsdc: s.filledTotalUsdc, nextRunAt: s.nextRunAt };
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
  const app = Fastify({ logger: false });

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
    return deps.store.list(owner).map(toDto);
  });

  app.post("/strategies", async (req, reply) => {
    const owner = ownerOf(req, reply);
    if (!owner) return;
    const { params } = req.body as { type: "dca"; params: DcaParams };
    return toDto(deps.store.create(owner, params));
  });

  const ownedStrategy = (owner: string, id: string, reply: FastifyReply): DcaStrategy | null => {
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
    if (!ownedStrategy(owner, id, reply)) return;
    const { status } = req.body as { status: "running" | "paused" };
    deps.store.setStatus(id, status);
    return toDto(deps.store.get(id)!);
  });

  app.delete("/strategies/:id", async (req, reply) => {
    const owner = ownerOf(req, reply);
    if (!owner) return;
    const { id } = req.params as { id: string };
    if (!ownedStrategy(owner, id, reply)) return;
    deps.store.remove(id);
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
