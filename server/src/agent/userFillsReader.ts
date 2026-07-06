export interface CloidFill {
  sz: number;
  px: number;
  closedPnl: number;
}

/** Minimal injectable Info surface for user fills. */
export interface UserFillsInfoLike {
  userFills(args: { user: string }): Promise<unknown>;
}

export interface UserFillsReader {
  fillsByCloid(owner: string): Promise<Map<string, CloidFill>>;
}

interface RawFill {
  cloid?: string | null;
  px?: string;
  sz?: string;
  closedPnl?: string;
}

/**
 * Poll a user's fills and index them by client order id (cloid), aggregating partial fills of the
 * same order: total size, total closedPnl, and size-weighted average price. Fills with no cloid
 * (not from our resting orders) are dropped.
 */
export function makeUserFillsReader(info: UserFillsInfoLike): UserFillsReader {
  return {
    async fillsByCloid(owner: string): Promise<Map<string, CloidFill>> {
      const raw = await info.userFills({ user: owner });
      const acc = new Map<string, { sz: number; closedPnl: number; pxSz: number }>();
      if (!Array.isArray(raw)) return new Map();
      for (const f of raw as RawFill[]) {
        if (typeof f?.cloid !== "string") continue;
        const sz = Number(f.sz ?? 0);
        const px = Number(f.px ?? 0);
        const closedPnl = Number(f.closedPnl ?? 0);
        const cur = acc.get(f.cloid) ?? { sz: 0, closedPnl: 0, pxSz: 0 };
        cur.sz += sz;
        cur.closedPnl += closedPnl;
        cur.pxSz += px * sz;
        acc.set(f.cloid, cur);
      }
      const out = new Map<string, CloidFill>();
      for (const [cloid, v] of acc) out.set(cloid, { sz: v.sz, closedPnl: v.closedPnl, px: v.sz > 0 ? v.pxSz / v.sz : 0 });
      return out;
    },
  };
}
