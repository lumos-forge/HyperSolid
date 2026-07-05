import { normalizeFill } from "./history";
import type { Fill, RawUserFill, Subscription } from "./types";

/** A currently-running TWAP, normalized from HL `twapHistory` for display + cancel. */
export interface ActiveTwap {
  twapId: number;
  coin: string;
  side: "buy" | "sell";
  sz: number;          // total base size
  executedSz: number;  // base size filled so far
  executedNtl: number; // USDC notional filled so far
  minutes: number;     // configured duration
  reduceOnly: boolean;
  startedAt: number;   // ms epoch (state.timestamp)
}

/** Minimal injectable Info surface for TWAP history + slice fills (address-scoped). */
export interface TwapInfoLike {
  twapHistory(address: string): Promise<unknown>;
  userTwapSliceFills(address: string): Promise<unknown>;
}

/** Minimal injectable WebSocket surface for live TWAP slice fills. */
export interface TwapSubsLike {
  userTwapSliceFills(address: string, listener: (event: unknown) => void): Promise<Subscription>;
}

interface RawTwap {
  status?: { status?: string };
  twapId?: unknown;
  state?: {
    coin?: string; side?: string; sz?: string; executedSz?: string;
    executedNtl?: string; minutes?: number; reduceOnly?: boolean; timestamp?: number;
  };
}

/** Keep only `activated` entries with a numeric `twapId` (others can't be cancelled), normalized. */
export function normalizeActiveTwaps(history: unknown): ActiveTwap[] {
  if (!Array.isArray(history)) return [];
  const out: ActiveTwap[] = [];
  for (const raw of history as RawTwap[]) {
    if (raw?.status?.status !== "activated") continue;
    if (typeof raw.twapId !== "number") continue;
    const s = raw.state ?? {};
    out.push({
      twapId: raw.twapId,
      coin: s.coin ?? "",
      side: s.side === "A" ? "sell" : "buy",
      sz: Number(s.sz ?? 0),
      executedSz: Number(s.executedSz ?? 0),
      executedNtl: Number(s.executedNtl ?? 0),
      minutes: Number(s.minutes ?? 0),
      reduceOnly: Boolean(s.reduceOnly),
      startedAt: Number(s.timestamp ?? 0),
    });
  }
  return out;
}

/** Fill progress as a percent in [0,100]. */
export function twapProgressPct(t: ActiveTwap): number {
  if (!(t.sz > 0)) return 0;
  return Math.max(0, Math.min(100, (t.executedSz / t.sz) * 100));
}

export type TwapStatus = "finished" | "terminated" | "error";

/** A finished/terminated/error TWAP, normalized from HL `twapHistory` for the history list. */
export interface TwapHistoryEntry {
  twapId: number | null; // some historical entries have no numeric id (not expandable)
  coin: string;
  side: "buy" | "sell";
  sz: number;
  executedSz: number;
  executedNtl: number;
  minutes: number;
  reduceOnly: boolean;
  startedAt: number;
  status: TwapStatus;
}

/** One TWAP slice fill: a standard Fill tagged with its parent twapId. */
export interface TwapSliceFill {
  twapId: number;
  fill: Fill;
}

const HISTORY_STATUSES: ReadonlySet<string> = new Set(["finished", "terminated", "error"]);
const HISTORY_LIMIT = 50;

/** Keep finished/terminated/error entries (newest first, capped), normalized for display. */
export function normalizeTwapHistory(history: unknown): TwapHistoryEntry[] {
  if (!Array.isArray(history)) return [];
  const out: TwapHistoryEntry[] = [];
  for (const raw of history as RawTwap[]) {
    const status = raw?.status?.status;
    if (typeof status !== "string" || !HISTORY_STATUSES.has(status)) continue;
    const s = raw.state ?? {};
    out.push({
      twapId: typeof raw.twapId === "number" ? raw.twapId : null,
      coin: s.coin ?? "",
      side: s.side === "A" ? "sell" : "buy",
      sz: Number(s.sz ?? 0),
      executedSz: Number(s.executedSz ?? 0),
      executedNtl: Number(s.executedNtl ?? 0),
      minutes: Number(s.minutes ?? 0),
      reduceOnly: Boolean(s.reduceOnly),
      startedAt: Number(s.timestamp ?? 0),
      status: status as TwapStatus,
    });
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out.slice(0, HISTORY_LIMIT);
}

interface RawSliceFill {
  fill?: unknown;
  twapId?: unknown;
}

/** Normalize `userTwapSliceFills`, keeping only entries with a numeric twapId. */
export function normalizeSliceFills(raw: unknown): TwapSliceFill[] {
  if (!Array.isArray(raw)) return [];
  const out: TwapSliceFill[] = [];
  for (const r of raw as RawSliceFill[]) {
    if (typeof r?.twapId !== "number") continue;
    if (!r.fill || typeof r.fill !== "object") continue;
    out.push({ twapId: r.twapId, fill: normalizeFill(r.fill as RawUserFill) });
  }
  return out;
}

/** Group slice fills by twapId, de-duplicating by `tid`, each group newest first. */
export function groupSliceFillsByTwapId(list: TwapSliceFill[]): Map<number, Fill[]> {
  const map = new Map<number, Fill[]>();
  for (const { twapId, fill } of list) {
    const arr = map.get(twapId) ?? [];
    if (arr.some((f) => f.tid === fill.tid)) continue;
    arr.push(fill);
    map.set(twapId, arr);
  }
  for (const arr of map.values()) arr.sort((a, b) => b.time - a.time);
  return map;
}
