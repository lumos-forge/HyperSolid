import type {
  Mids,
  PortfolioSnapshot,
  PositionsInfoLike,
  PositionsSubsLike,
  Subscription,
} from "../lib/hyperliquid/types";
import { normalizePortfolio } from "../lib/hyperliquid/positions";
import { applyMarks } from "../lib/hyperliquid/markPnl";

export class PositionsService {
  constructor(
    private info: PositionsInfoLike,
    private subs?: PositionsSubsLike,
  ) {}

  async loadPortfolio(address: string): Promise<PortfolioSnapshot> {
    const raw = await this.info.clearinghouseState(address);
    return normalizePortfolio(raw);
  }

  /**
   * Live portfolio: clearinghouseState (replace-state, snapshot-safe) merged with allMids marks
   * via applyMarks (mark-priced PnL, §4.5). Reconnect snapshots simply re-replace state and are
   * never double-counted (§4.6). Transport-level 60s ping/keepalive is the @nktkas
   * WebSocketTransport's responsibility, not this service.
   */
  async subscribeLive(
    address: string,
    onUpdate: (portfolio: PortfolioSnapshot) => void,
  ): Promise<Subscription> {
    if (!this.subs) {
      throw new Error("PositionsService: no subscription client injected");
    }
    let snapshot: PortfolioSnapshot | null = null;
    let marks: Mids = {};
    const emit = () => {
      if (snapshot) onUpdate(applyMarks(snapshot, marks));
    };

    const subState = await this.subs.clearinghouseState(address, (e) => {
      snapshot = normalizePortfolio(e.clearinghouseState);
      emit();
    });
    const subMids = await this.subs.allMids((d) => {
      marks = d.mids;
      emit();
    });

    return {
      unsubscribe: async () => {
        await subState.unsubscribe();
        await subMids.unsubscribe();
      },
    };
  }
}
