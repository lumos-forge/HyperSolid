import { generatePrivateKey } from "viem/accounts";
import { Auth } from "./auth/auth";
import { AgentManager } from "./agent/agentManager";
import { SqliteAgentStore } from "./agent/sqliteAgentStore";
import { deriveKey } from "./agent/secretBox";
import { SqliteStrategyStore } from "./strategies/sqliteStore";
import { SqliteActivityStore } from "./strategies/activityStore";
import { SqlitePushTokenStore } from "./push/pushTokenStore";
import { Expo } from "expo-server-sdk";
import { Notifier } from "./push/notifier";
import { NotifyingActivityStore } from "./push/notifyingActivityStore";
import { deadManAlertNotification, deadManRecoveredNotification } from "./push/notifications";
import type { StrategyStore } from "./strategies/store";
import { appConfigFromEnv, geoHeadersFromEnv } from "./config/appConfig";
import { makeClientFor, makeResolvers, makeTransport, makeInfoClient } from "./agent/hlRuntime";
import { makeHlPlacer } from "./agent/placer";
import { makeShadowVerifier } from "./agent/signerShadow";
import { makeRestingExecutor } from "./agent/restingExecutor";
import { makeOpenOrdersReader } from "./agent/openOrdersReader";
import { makeUserFillsReader } from "./agent/userFillsReader";
import { makeDeadManExecutor, type DeadManClientLike } from "./agent/deadManExecutor";
import { tick } from "./engine/scheduler";
import { makeDeadManBudget, deadManHeartbeat, makeDeadManHealth, deadManClearAll, staleDeadManOwners } from "./engine/deadMan";
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
  const maxOpenOrders = process.env.MAX_OPEN_ORDERS ? Number(process.env.MAX_OPEN_ORDERS) : undefined;
  const tickMs = Number(process.env.TICK_MS ?? 60_000);
  const dbPath = process.env.DB_PATH ?? "strategies.db";

  const now = () => Date.now();
  const auth = new Auth({ secret: authSecret });
  const agents = new AgentManager(SqliteAgentStore.open(dbPath, agentEncKey), generatePrivateKey);
  const store: StrategyStore = SqliteStrategyStore.open(dbPath, now);
  const pushTokens = SqlitePushTokenStore.open(dbPath);
  const notifier = new Notifier({ expo: new Expo(), store: pushTokens });
  const activity = new NotifyingActivityStore(SqliteActivityStore.open(dbPath), notifier);

  const transport = makeTransport(isTestnet);
  const info = makeInfoClient(transport);
  const resolvers = makeResolvers(info, 60_000, now);
  const clientFor = makeClientFor(agents, transport, now);
  const signerShadowUrl = process.env.SIGNER_SHADOW_URL;
  const shadowVerify = signerShadowUrl
    ? makeShadowVerifier({ url: signerShadowUrl, isTestnet })
    : undefined;
  const placer = makeHlPlacer({
    clientFor,
    ...resolvers,
    slippageBps,
    shadowVerify,
  });
  const restingExec = makeRestingExecutor({ clientFor, resolveAsset: resolvers.resolveAsset, shadowVerify });
  const ordersReader = makeOpenOrdersReader(info as unknown as { frontendOpenOrders(a: { user: string }): Promise<unknown> });
  const userFillsReader = makeUserFillsReader(info as unknown as { userFills(a: { user: string }): Promise<unknown> });

  const killSwitch = process.env.GLOBAL_KILL === "1";
  const deadManTtlMs = process.env.DEADMAN_TTL_MS ? Number(process.env.DEADMAN_TTL_MS) : undefined;
  // The dead-man TTL must be comfortably larger than the tick interval: the heartbeat only refreshes
  // the scheduled cancel every tick, so a TTL <= tickMs would let the switch fire during healthy
  // operation (cancelling all orders and burning the HL 10/day trigger budget). Require >= 3x tick
  // and >= 10s (HL's 5s minimum with margin).
  const deadManEnabled =
    deadManTtlMs !== undefined &&
    Number.isFinite(deadManTtlMs) &&
    deadManTtlMs >= 10_000 &&
    deadManTtlMs >= 3 * tickMs;
  if (deadManTtlMs !== undefined && !deadManEnabled) {
    // eslint-disable-next-line no-console
    console.warn(
      `dead-man switch disabled: DEADMAN_TTL_MS=${deadManTtlMs} must be finite, >= 10000, and >= 3x TICK_MS (${tickMs})`,
    );
  }
  const deadManExecutor = makeDeadManExecutor({
    clientFor: clientFor as unknown as (owner: string) => DeadManClientLike | undefined,
    shadowVerify,
  });
  const deadManBudget = makeDeadManBudget();
  const deadManHealth = makeDeadManHealth();
  const activeOwners = () => [...new Set(
    store.listAll()
      .filter((s) => s.status === "running" && (s.params as { deadMan?: boolean }).deadMan === true)
      .map((s) => s.owner),
  )];
  if (deadManEnabled) {
    const runningOwners = store.listAll().filter((s) => s.status === "running").map((s) => s.owner);
    const stale = staleDeadManOwners(runningOwners, activeOwners());
    await deadManClearAll({ activeOwners: () => stale, executor: deadManExecutor });
  }
  const timer = setInterval(() => {
    void tick(
      store,
      placer,
      { maxNotionalUsdc, perCoinMaxNotionalUsdc, dailyMaxNotionalUsdc, maxOpenOrders },
      killSwitch,
      now(),
      activity,
      { resolveMark: resolvers.resolvePrice, resolvePosition: resolvers.resolvePosition },
      restingExec,
      ordersReader,
      userFillsReader,
    ).catch((e) =>
      // eslint-disable-next-line no-console
      console.error("scheduler tick failed", e),
    );
    if (deadManEnabled) {
      void deadManHeartbeat({
        activeOwners,
        budget: deadManBudget,
        executor: deadManExecutor,
        now,
        ttlMs: deadManTtlMs as number,
        health: deadManHealth,
        onHealthEvent: (owner, ev) => {
          if (ev.kind === "alert") {
            // eslint-disable-next-line no-console
            console.error(`dead-man arm failing for ${owner}: ${ev.consecutiveFailures} consecutive unprotected heartbeats`);
            void notifier.notify(owner, (l) => deadManAlertNotification(ev, l)).catch(() => {});
          } else if (ev.kind === "recovered") {
            // eslint-disable-next-line no-console
            console.error(`dead-man arm recovered for ${owner}`);
            void notifier.notify(owner, (l) => deadManRecoveredNotification(l)).catch(() => {});
          }
        },
      }).catch((e) =>
        // eslint-disable-next-line no-console
        console.error("dead-man heartbeat failed", e),
      );
    }
  }, tickMs);
  timer.unref?.();

  const app = buildApp({ auth, agents, store, activity, pushTokens, now, version: VERSION, logger: process.env.LOG_REQUESTS === "1", appConfig: appConfigFromEnv(process.env), geoHeaders: geoHeadersFromEnv(process.env) });
  await app.listen({ port, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(`strategy backend listening on :${port} (testnet=${isTestnet})`);

  const shutdown = async () => {
    clearInterval(timer);
    if (deadManEnabled) {
      await deadManClearAll({ activeOwners, executor: deadManExecutor });
    }
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

if (require.main === module) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
}
