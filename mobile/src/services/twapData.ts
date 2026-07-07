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

/** HL caps *ByTime pages; we page forward until an empty page (cap-independent). */
const SLICE_FILLS_MAX_PAGES = 25;

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

  /**
   * Active + history TWAPs from a SINGLE `twapHistory` fetch. Deriving both from one response
   * halves the request volume and guarantees a given twapId lands in exactly one list (no
   * transient active/history split-brain across two separate responses).
   */
  async loadActiveAndHistory(address: string): Promise<{ active: ActiveTwap[]; history: TwapHistoryEntry[] }> {
    const raw = await this.info.twapHistory(address);
    return { active: normalizeActiveTwaps(raw), history: normalizeTwapHistory(raw) };
  }

  /** Slice fills for an address, grouped by twapId (newest first per group). */
  async loadSliceFills(address: string): Promise<Map<number, Fill[]>> {
    return groupSliceFillsByTwapId(normalizeSliceFills(await this.info.userTwapSliceFills(address)));
  }

  /**
   * All slice fills in [startMs, endMs], paginated via userTwapSliceFillsByTime and
   * grouped by twapId (deduped by tid). Pages forward until an empty page, no cursor
   * progress, or SLICE_FILLS_MAX_PAGES — no dependency on HL's exact per-call cap.
   *
   * Paging is oldest→newest, so under extreme volume (> SLICE_FILLS_MAX_PAGES × the
   * per-call cap) the bound truncates the NEWEST fills; the live slice-fill WS
   * subscription still surfaces the most recent ones, so the UI stays current.
   */
  async loadSliceFillsByTime(address: string, startMs: number, endMs = Date.now()): Promise<Map<number, Fill[]>> {
    const all: TwapSliceFill[] = [];
    let cursor = startMs;
    for (let page = 0; page < SLICE_FILLS_MAX_PAGES; page++) {
      const norm = normalizeSliceFills(await this.info.userTwapSliceFillsByTime(address, cursor, endMs));
      if (norm.length === 0) break;
      all.push(...norm);
      // Advance strictly past the newest fill so pages don't overlap; using max()
      // (not the last element) is correct regardless of the API's return ordering.
      const maxTime = Math.max(...norm.map((f) => f.fill.time));
      // Guarantee forward progress: if the newest fill is at/behind the cursor the
      // window is exhausted (or a whole page shares one ms — see the oldest→newest
      // note above), so stop rather than re-fetch the same window.
      if (maxTime + 1 <= cursor) break;
      cursor = maxTime + 1;
    }
    return groupSliceFillsByTwapId(all);
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
