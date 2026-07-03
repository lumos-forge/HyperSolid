import { normalizeActiveTwaps, type ActiveTwap, type TwapInfoLike } from "../lib/hyperliquid/twap";

/** Polls a user's running TWAPs (mirrors OrdersService/FillsService). */
export class TwapService {
  constructor(private info: TwapInfoLike) {}

  /** Currently-running TWAPs for an address, normalized. */
  async loadActive(address: string): Promise<ActiveTwap[]> {
    return normalizeActiveTwaps(await this.info.twapHistory(address));
  }
}
