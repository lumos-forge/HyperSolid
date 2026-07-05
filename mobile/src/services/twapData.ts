import {
  normalizeActiveTwaps,
  normalizeTwapHistory,
  normalizeSliceFills,
  groupSliceFillsByTwapId,
  type ActiveTwap,
  type TwapHistoryEntry,
  type TwapSliceFill,
  type TwapInfoLike,
  type TwapSubsLike,
} from "../lib/hyperliquid/twap";
import type { Fill, Subscription } from "../lib/hyperliquid/types";

/** Loads a user's TWAPs (active + history), slice fills, and live slice-fill updates. */
export class TwapService {
  constructor(private info: TwapInfoLike, private subs?: TwapSubsLike) {}

  /** Currently-running TWAPs for an address, normalized. */
  async loadActive(address: string): Promise<ActiveTwap[]> {
    return normalizeActiveTwaps(await this.info.twapHistory(address));
  }

  /** Finished/terminated/error TWAPs for an address, newest first. */
  async loadHistory(address: string): Promise<TwapHistoryEntry[]> {
    return normalizeTwapHistory(await this.info.twapHistory(address));
  }

  /** Slice fills for an address, grouped by twapId (newest first per group). */
  async loadSliceFills(address: string): Promise<Map<number, Fill[]>> {
    return groupSliceFillsByTwapId(normalizeSliceFills(await this.info.userTwapSliceFills(address)));
  }

  /** Subscribe to live slice fills; the callback receives normalized `TwapSliceFill[]`. */
  async subscribeSliceFills(address: string, cb: (fills: TwapSliceFill[]) => void): Promise<Subscription> {
    if (!this.subs) throw new Error("twap subscription client not configured");
    return this.subs.userTwapSliceFills(address, (event) => {
      const raw = (event as { twapSliceFills?: unknown })?.twapSliceFills;
      cb(normalizeSliceFills(raw));
    });
  }
}
