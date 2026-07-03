import { generatePrivateKey } from "viem/accounts";
import { Auth } from "./auth/auth";
import { AgentManager } from "./agent/agentManager";
import { SqliteAgentStore } from "./agent/sqliteAgentStore";
import { deriveKey } from "./agent/secretBox";
import { SqliteStrategyStore } from "./strategies/sqliteStore";
import { SqliteActivityStore } from "./strategies/activityStore";
import type { StrategyStore } from "./strategies/store";
import { appConfigFromEnv, geoHeadersFromEnv } from "./config/appConfig";
import { makeClientFor, makeResolvers, makeTransport, makeInfoClient } from "./agent/hlRuntime";
import { makeHlPlacer } from "./agent/placer";
import { tick } from "./engine/scheduler";
import { buildApp } from "./http/app";

export const VERSION = "0.1.0";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}

/** Parse `PER_COIN_CAPS` JSON (e.g. {"BTC":500}) into numeric caps; ignores malformed input. */
function parsePerCoinCaps(raw: string | undefined): Record<string, number> | undefined {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const caps: Record<string, number> = {};
    for (const [coin, v] of Object.entries(obj)) {
      if (typeof v === "number" && Number.isFinite(v)) caps[coin] = v;
    }
    return Object.keys(caps).length ? caps : undefined;
  } catch {
    // eslint-disable-next-line no-console
    console.error("ignoring malformed PER_COIN_CAPS");
    return undefined;
  }
}

/**
 * Composition root: wire auth + agent custody + strategy store + the agent-signed HL placer, start the
 * scheduler interval, and serve the contract. Secrets come from env (never hard-coded); the network
 * defaults to testnet so a misconfig can't trade real funds. Run with `ts-node`/compiled `dist`.
 */
export async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  const isTestnet = process.env.HL_NETWORK !== "mainnet";
  const authSecret = requireEnv("AUTH_SECRET");
  const agentEncKey = deriveKey(requireEnv("AGENT_ENC_KEY"));
  const slippageBps = Number(process.env.SLIPPAGE_BPS ?? 50);
  const maxNotionalUsdc = Number(process.env.MAX_NOTIONAL_USDC ?? 1000);
  const perCoinMaxNotionalUsdc = parsePerCoinCaps(process.env.PER_COIN_CAPS);
  const dailyMaxNotionalUsdc = process.env.DAILY_MAX_NOTIONAL_USDC
    ? Number(process.env.DAILY_MAX_NOTIONAL_USDC)
    : undefined;
  const tickMs = Number(process.env.TICK_MS ?? 60_000);
  const dbPath = process.env.DB_PATH ?? "strategies.db";

  const now = () => Date.now();
  const auth = new Auth({ secret: authSecret });
  const agents = new AgentManager(SqliteAgentStore.open(dbPath, agentEncKey), generatePrivateKey);
  const store: StrategyStore = SqliteStrategyStore.open(dbPath, now);
  const activity = SqliteActivityStore.open(dbPath);

  const transport = makeTransport(isTestnet);
  const info = makeInfoClient(transport);
  const resolvers = makeResolvers(info, 60_000, now);
  const placer = makeHlPlacer({
    clientFor: makeClientFor(agents, transport, now),
    ...resolvers,
    slippageBps,
  });

  const killSwitch = process.env.GLOBAL_KILL === "1";
  const timer = setInterval(() => {
    void tick(
      store,
      placer,
      { maxNotionalUsdc, perCoinMaxNotionalUsdc, dailyMaxNotionalUsdc },
      killSwitch,
      now(),
      activity,
      { resolveMark: resolvers.resolvePrice, resolvePosition: resolvers.resolvePosition },
    ).catch((e) =>
      // eslint-disable-next-line no-console
      console.error("scheduler tick failed", e),
    );
  }, tickMs);
  timer.unref?.();

  const app = buildApp({ auth, agents, store, activity, now, version: VERSION, logger: process.env.LOG_REQUESTS === "1", appConfig: appConfigFromEnv(process.env), geoHeaders: geoHeadersFromEnv(process.env) });
  await app.listen({ port, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(`strategy backend listening on :${port} (testnet=${isTestnet})`);
}

if (require.main === module) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
}
