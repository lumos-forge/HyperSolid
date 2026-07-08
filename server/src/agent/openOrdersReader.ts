export interface OpenOrderInfo {
  oid: number;
  coin: string;
  side: "buy" | "sell";
  px: number;
}

/** Minimal injectable Info surface for open orders. */
export interface OpenOrdersInfoLike {
  frontendOpenOrders(args: { user: string }): Promise<unknown>;
}

export interface OpenOrdersReader {
  openOrders(owner: string): Promise<{ byCloid: Map<string, OpenOrderInfo>; total: number }>;
}

interface RawOpenOrder {
  cloid?: string | null;
  oid?: number;
  coin?: string;
  side?: "B" | "A";
  limitPx?: string;
}

/** Poll a user's open orders: index cloid-tagged ones by cloid, and report the TOTAL open-order
 * count (including non-cloid manual orders) — the HL per-address quota measure. */
export function makeOpenOrdersReader(info: OpenOrdersInfoLike): OpenOrdersReader {
  return {
    async openOrders(owner: string): Promise<{ byCloid: Map<string, OpenOrderInfo>; total: number }> {
      const raw = await info.frontendOpenOrders({ user: owner });
      const byCloid = new Map<string, OpenOrderInfo>();
      if (!Array.isArray(raw)) return { byCloid, total: 0 };
      for (const o of raw as RawOpenOrder[]) {
        if (typeof o?.cloid !== "string") continue;
        byCloid.set(o.cloid, {
          oid: Number(o.oid ?? 0),
          coin: o.coin ?? "",
          side: o.side === "A" ? "sell" : "buy",
          px: Number(o.limitPx ?? 0),
        });
      }
      return { byCloid, total: raw.length };
    },
  };
}
