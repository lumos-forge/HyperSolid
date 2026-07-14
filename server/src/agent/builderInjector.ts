/** Narrow info surface: the approved builder fee rate (tenth-bps) for a user+builder. */
export interface BuilderInfoLike {
  maxBuilderFee(params: { user: `0x${string}`; builder: `0x${string}` }): Promise<number>;
}

/** The builder to attach to an order (@nktkas order `builder` sibling), or undefined when not approved. */
export interface BuilderInjector {
  builderFor(owner: string): Promise<{ b: `0x${string}`; f: number } | undefined>;
}

export interface BuilderInjectorDeps {
  info: BuilderInfoLike;
  address: `0x${string}`;
  perpFeeTenthBps: number;
  now?: () => number;
  /** How long an unapproved/unknown result is cached before re-checking (a user may approve any time). */
  negativeTtlMs?: number;
}

const DEFAULT_NEGATIVE_TTL_MS = 10 * 60_000;

/**
 * Per-owner builder-fee approval gate for the engine. `builderFor(owner)` returns the builder to attach
 * only when the owner's on-chain `maxBuilderFee` covers the configured fee. Approved results are cached
 * for the process lifetime (approval is effectively permanent); unapproved/unknown results are cached
 * for `negativeTtlMs` then re-checked (so an owner who approves in the app is picked up). A thrown query
 * fails open (undefined) so a builder is simply not attached that window — the order still places.
 */
export function makeBuilderInjector(deps: BuilderInjectorDeps): BuilderInjector {
  const now = deps.now ?? (() => Date.now());
  const negativeTtlMs = deps.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
  const builder = { b: deps.address, f: deps.perpFeeTenthBps };
  const cache = new Map<string, { approved: boolean; at: number }>();
  return {
    async builderFor(owner: string): Promise<{ b: `0x${string}`; f: number } | undefined> {
      const key = owner.toLowerCase();
      const t = now();
      const cached = cache.get(key);
      if (cached) {
        if (cached.approved) return builder;
        if (t - cached.at < negativeTtlMs) return undefined;
      }
      let approved = false;
      try {
        const rate = await deps.info.maxBuilderFee({ user: key as `0x${string}`, builder: deps.address });
        approved = rate >= deps.perpFeeTenthBps;
      } catch {
        approved = false; // fail-open: place without a builder this window
      }
      cache.set(key, { approved, at: t });
      return approved ? builder : undefined;
    },
  };
}
