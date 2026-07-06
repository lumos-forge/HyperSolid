import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import type { AgentManager } from "./agentManager";
import type { ExchangeLike } from "./placer";
import type { RestingClientLike } from "./restingExecutor";
import { assetIndexFromMeta, priceFromMids, positionSzi, type PerpMeta, type ClearinghouseState } from "./hlMeta";

/**
 * Build the placer's `clientFor`: an agent-signed HL ExchangeClient per owner, but only while the
 * owner's agent is approved and unexpired. Clients are cached per owner; the underlying key never
 * leaves the process. A revoked/expired owner yields `undefined`, so the placer fails closed.
 */
export function makeClientFor(
  agents: AgentManager,
  transport: HttpTransport,
  now: () => number,
): (owner: string) => RestingClientLike | undefined {
  const cache = new Map<string, RestingClientLike>();
  return (owner: string) => {
    if (!agents.status(owner, now()).approved) return undefined;
    const key = agents.privateKeyFor(owner);
    if (!key) return undefined;
    let client = cache.get(owner);
    if (!client) {
      const wallet = privateKeyToAccount(key);
      client = new ExchangeClient({ wallet, transport }) as unknown as RestingClientLike;
      cache.set(owner, client);
    }
    return client;
  };
}

/** Asset/price resolvers for the placer, backed by a shared InfoClient (meta cached for `metaTtlMs`). */
export function makeResolvers(info: InfoClient, metaTtlMs = 60_000, now: () => number = () => Date.now()) {
  let metaCache: { at: number; meta: PerpMeta } | null = null;
  const getMeta = async (): Promise<PerpMeta> => {
    if (!metaCache || now() - metaCache.at > metaTtlMs) {
      metaCache = { at: now(), meta: (await info.meta()) as unknown as PerpMeta };
    }
    return metaCache.meta;
  };
  return {
    resolveAsset: async (coin: string) => assetIndexFromMeta(await getMeta(), coin),
    resolvePrice: async (coin: string) => priceFromMids((await info.allMids()) as Record<string, string>, coin),
    resolvePosition: async (owner: string, coin: string): Promise<number | undefined> => {
      const state = (await info.clearinghouseState({ user: owner })) as unknown as ClearinghouseState;
      const szi = positionSzi(state, coin);
      return szi === 0 ? undefined : szi;
    },
  };
}

/** A ready-to-use HttpTransport for the configured network. */
export function makeTransport(isTestnet: boolean): HttpTransport {
  return new HttpTransport({ isTestnet });
}

/** A shared InfoClient for the configured network. */
export function makeInfoClient(transport: HttpTransport): InfoClient {
  return new InfoClient({ transport });
}
