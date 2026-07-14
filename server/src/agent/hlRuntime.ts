import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import type { AgentManager } from "./agentManager";
import type { ExchangeLike } from "./placer";
import type { RestingClientLike } from "./restingExecutor";
import { makeSignerBackedExchangeClient, type SignerLike, type ExchangeTransport } from "./signerExchangeClient";
import type { BuilderInjector } from "./builderInjector";
import { assetIndexFromMeta, priceFromMids, positionSzi, type PerpMeta, type ClearinghouseState } from "./hlMeta";

/** When present, owners whose agent key is custodied by the signer (keyId records) are routed to a
 *  signer-backed client instead of a local ExchangeClient. */
export interface ClientForDelegation {
  signer: SignerLike;
  isTestnet: boolean;
}

/**
 * Wrap a local HL client so `order` attaches the builder fee for approved owners (per the injector),
 * while `cancelByCloid` / `scheduleCancel` pass straight through (no fee). Methods are called on the
 * underlying client instance so `this` is preserved. A builder already on the params is not overwritten.
 */
export function wrapClientWithBuilder(
  client: RestingClientLike,
  owner: string,
  injector: BuilderInjector,
): RestingClientLike {
  const c = client as RestingClientLike & { scheduleCancel?: (p: unknown) => Promise<unknown> };
  return {
    order: async (params: unknown) => {
      const b = await injector.builderFor(owner);
      const p = (params ?? {}) as { builder?: unknown };
      const merged = b && p.builder === undefined ? { ...(params as object), builder: b } : params;
      return c.order(merged);
    },
    cancelByCloid: (params: unknown) => c.cancelByCloid(params),
    scheduleCancel: (params: unknown) => (c as { scheduleCancel: (p: unknown) => Promise<unknown> }).scheduleCancel(params),
  } as unknown as RestingClientLike;
}

/**
 * Build the placer's `clientFor`: a per-owner HL client, but only while the owner's agent is approved
 * and unexpired. When delegation is configured and the owner is a keyId (signer-custody) record, returns
 * a signer-backed client (signs via the Go signer, submits the pre-signed action); otherwise an
 * agent-signed local ExchangeClient whose key never leaves the process. Clients are cached per owner; a
 * revoked/expired or key-less owner yields `undefined`, so the placer fails closed. When a builder
 * injector is supplied, the local client's `order` attaches the builder fee for approved owners.
 */
export function makeClientFor(
  agents: AgentManager,
  transport: HttpTransport,
  now: () => number,
  delegation?: ClientForDelegation,
  builderInjector?: BuilderInjector,
): (owner: string) => RestingClientLike | undefined {
  const cache = new Map<string, RestingClientLike>();
  return (owner: string) => {
    if (!agents.status(owner, now()).approved) return undefined;
    const cached = cache.get(owner);
    if (cached) return cached;
    if (delegation) {
      const keyId = agents.keyIdFor(owner);
      if (keyId) {
        const client = makeSignerBackedExchangeClient({
          keyId,
          signer: delegation.signer,
          transport: transport as unknown as ExchangeTransport,
          isTestnet: delegation.isTestnet,
        }) as unknown as RestingClientLike;
        cache.set(owner, client);
        return client;
      }
    }
    const key = agents.privateKeyFor(owner);
    if (!key) return undefined;
    const wallet = privateKeyToAccount(key);
    const local = new ExchangeClient({ wallet, transport }) as unknown as RestingClientLike;
    const client = builderInjector ? wrapClientWithBuilder(local, owner, builderInjector) : local;
    cache.set(owner, client);
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
