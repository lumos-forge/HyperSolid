import {
  HttpTransport,
  InfoClient,
  SubscriptionClient,
  WebSocketTransport,
} from "@nktkas/hyperliquid";
import type { Network } from "../../state/envStore";
import { resolveIsTestnet } from "./network";
import type { DetailInfoLike, DetailSubsLike, InfoLike, SubsLike } from "./types";

export function createInfoClient(network: Network): InfoLike {
  const transport = new HttpTransport({ isTestnet: resolveIsTestnet(network) });
  return new InfoClient({ transport }) as unknown as InfoLike;
}

export function createSubsClient(network: Network): SubsLike {
  const transport = new WebSocketTransport({ isTestnet: resolveIsTestnet(network) });
  return new SubscriptionClient({ transport }) as unknown as SubsLike;
}

export function createDetailInfoClient(network: Network): DetailInfoLike {
  const info = new InfoClient({
    transport: new HttpTransport({ isTestnet: resolveIsTestnet(network) }),
  }) as unknown as {
    candleSnapshot(args: {
      coin: string;
      interval: string;
      startTime: number;
      endTime: number;
    }): Promise<unknown>;
  };
  return {
    candleSnapshot: (coin, interval, startTime, endTime) =>
      info.candleSnapshot({ coin, interval, startTime, endTime }) as never,
  };
}

export function createDetailSubsClient(network: Network): DetailSubsLike {
  const subs = new SubscriptionClient({
    transport: new WebSocketTransport({ isTestnet: resolveIsTestnet(network) }),
  }) as unknown as {
    l2Book(args: { coin: string }, cb: (b: unknown) => void): Promise<unknown>;
    trades(args: { coin: string }, cb: (t: unknown) => void): Promise<unknown>;
  };
  return {
    l2Book: (coin, listener) => subs.l2Book({ coin }, (b) => listener(b as never)) as never,
    trades: (coin, listener) => subs.trades({ coin }, (t) => listener(t as never)) as never,
  };
}
