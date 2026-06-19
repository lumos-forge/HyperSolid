import type {
  InfoLike,
  MarketTicker,
  Mids,
  Subscription,
  SubsLike,
} from "../lib/hyperliquid/types";
import { normalizeMarkets } from "../lib/hyperliquid/normalize";

export class MarketDataService {
  constructor(private info: InfoLike, private subs: SubsLike) {}

  async loadSnapshot(): Promise<MarketTicker[]> {
    const data = await this.info.metaAndAssetCtxs();
    return normalizeMarkets(data);
  }

  async subscribeMids(onMids: (mids: Mids) => void): Promise<Subscription> {
    return this.subs.allMids((data) => onMids(data.mids));
  }
}
