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
  /** How long an APPROVED result is cached before re-checking. Bounds the window in which a revoked /
   *  reduced approval would still be attached (HL approvals are revocable) — after this, a lowered
   *  approval is re-observed and the builder dropped (fail-open). */
  positiveTtlMs?: number;
  /** How long an unapproved/unknown result is cached before re-checking (a user may approve any time). */
  negativeTtlMs?: number;
}

const DEFAULT_POSITIVE_TTL_MS = 60 * 60_000;
const DEFAULT_NEGATIVE_TTL_MS = 10 * 60_000;

/**
 * Per-owner builder-fee approval gate for the engine. `builderFor(owner)` returns the builder to attach
 * only when the owner's on-chain `maxBuilderFee` covers the configured fee. Results are cached with a
 * TTL — approved for `positiveTtlMs`, unapproved/unknown for `negativeTtlMs` — then re-checked, so an
 * owner who approves (or revokes/reduces) in the app is eventually picked up. A thrown query fails open
 * (undefined) so a builder is simply not attached that window — the order still places.
 */
export function makeBuilderInjector(deps: BuilderInjectorDeps): BuilderInjector {
  const now = deps.now ?? (() => Date.now());
  const positiveTtlMs = deps.positiveTtlMs ?? DEFAULT_POSITIVE_TTL_MS;
  const negativeTtlMs = deps.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
  const builder = { b: deps.address, f: deps.perpFeeTenthBps };
  const cache = new Map<string, { approved: boolean; at: number }>();
  return {
    async builderFor(owner: string): Promise<{ b: `0x${string}`; f: number } | undefined> {
      const key = owner.toLowerCase();
      const t = now();
      const cached = cache.get(key);
      if (cached && t - cached.at < (cached.approved ? positiveTtlMs : negativeTtlMs)) {
        return cached.approved ? builder : undefined;
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
