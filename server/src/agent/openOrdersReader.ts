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
  openCloids(owner: string): Promise<Map<string, OpenOrderInfo>>;
}

interface RawOpenOrder {
  cloid?: string | null;
  oid?: number;
  coin?: string;
  side?: "B" | "A";
  limitPx?: string;
}

/** Poll a user's open orders and index them by client order id (cloid). Null-cloid orders (not ours) are dropped. */
export function makeOpenOrdersReader(info: OpenOrdersInfoLike): OpenOrdersReader {
  return {
    async openCloids(owner: string): Promise<Map<string, OpenOrderInfo>> {
      const raw = await info.frontendOpenOrders({ user: owner });
      const out = new Map<string, OpenOrderInfo>();
      if (!Array.isArray(raw)) return out;
      for (const o of raw as RawOpenOrder[]) {
        if (typeof o?.cloid !== "string") continue;
        out.set(o.cloid, {
          oid: Number(o.oid ?? 0),
          coin: o.coin ?? "",
          side: o.side === "A" ? "sell" : "buy",
          px: Number(o.limitPx ?? 0),
        });
      }
      return out;
    },
  };
}
