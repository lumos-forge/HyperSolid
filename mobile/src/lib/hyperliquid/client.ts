import {
  ExchangeClient,
  HttpTransport,
  InfoClient,
  SubscriptionClient,
  WebSocketTransport,
} from "@nktkas/hyperliquid";
import type { Network } from "../../state/envStore";
import { resolveIsTestnet } from "./network";
import type { DetailInfoLike, DetailSubsLike, InfoLike, PositionsInfoLike, SubsLike, FillsInfoLike, OrdersInfoLike, FundingsInfoLike, OrderStatusInfoLike, RawOrderStatus } from "./types";
import type { ExchangeLike } from "../../services/exchange";
import type { TwapInfoLike, TwapSubsLike } from "./twap";

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
    l2Book(args: { coin: string; nSigFigs?: number }, cb: (b: unknown) => void): Promise<unknown>;
    trades(args: { coin: string }, cb: (t: unknown) => void): Promise<unknown>;
  };
  return {
    l2Book: (coin, listener, nSigFigs) =>
      subs.l2Book({ coin, nSigFigs }, (b) => listener(b as never)) as never,
    trades: (coin, listener) => subs.trades({ coin }, (t) => listener(t as never)) as never,
  };
}

export function createPositionsInfoClient(network: Network): PositionsInfoLike {
  const info = new InfoClient({
    transport: new HttpTransport({ isTestnet: resolveIsTestnet(network) }),
  }) as unknown as {
    clearinghouseState(args: { user: string }): Promise<unknown>;
  };
  return {
    clearinghouseState: (address) => info.clearinghouseState({ user: address }) as never,
  };
}

export function createFillsInfoClient(network: Network): FillsInfoLike {
  const info = new InfoClient({
    transport: new HttpTransport({ isTestnet: resolveIsTestnet(network) }),
  }) as unknown as {
    userFills(args: { user: string }): Promise<unknown>;
    userFillsByTime(args: { user: string; startTime: number; endTime: number }): Promise<unknown>;
  };
  return {
    userFills: (address) => info.userFills({ user: address }) as never,
    userFillsByTime: (address, startTime, endTime) =>
      info.userFillsByTime({ user: address, startTime, endTime }) as never,
  };
}

export function createOrdersInfoClient(network: Network): OrdersInfoLike {
  const info = new InfoClient({
    transport: new HttpTransport({ isTestnet: resolveIsTestnet(network) }),
  }) as unknown as {
    openOrders(args: { user: string }): Promise<unknown>;
  };
  return {
    openOrders: (address) => info.openOrders({ user: address }) as never,
  };
}

export function createTwapInfoClient(network: Network): TwapInfoLike {
  const info = new InfoClient({
    transport: new HttpTransport({ isTestnet: resolveIsTestnet(network) }),
  }) as unknown as {
    twapHistory(args: { user: string }): Promise<unknown>;
    userTwapSliceFills(args: { user: string }): Promise<unknown>;
  };
  return {
    twapHistory: (address) => info.twapHistory({ user: address }) as never,
    userTwapSliceFills: (address) => info.userTwapSliceFills({ user: address }) as never,
  };
}

export function createTwapSubsClient(network: Network): TwapSubsLike {
  const subs = new SubscriptionClient({
    transport: new WebSocketTransport({ isTestnet: resolveIsTestnet(network) }),
  }) as unknown as {
    userTwapSliceFills(args: { user: string }, cb: (e: unknown) => void): Promise<unknown>;
  };
  return {
    userTwapSliceFills: (address, listener) =>
      subs.userTwapSliceFills({ user: address }, (e) => listener(e as never)) as never,
  };
}

export function createFundingsInfoClient(network: Network): FundingsInfoLike {
  const info = new InfoClient({
    transport: new HttpTransport({ isTestnet: resolveIsTestnet(network) }),
  }) as unknown as {
    userFunding(args: { user: string; startTime: number; endTime?: number }): Promise<unknown>;
  };
  return {
    userFunding: (address, startTime, endTime) =>
      info.userFunding({ user: address, startTime, endTime }) as never,
  };
}

export function createOrderStatusInfoClient(network: Network): OrderStatusInfoLike {
  const info = new InfoClient({
    transport: new HttpTransport({ isTestnet: resolveIsTestnet(network) }),
  }) as unknown as {
    orderStatus(args: { user: string; oid: number | `0x${string}` }): Promise<RawOrderStatus>;
  };
  return {
    orderStatus: (user, oid) => info.orderStatus({ user, oid }) as never,
  };
}

/**
 * ExchangeClient signs L1/user actions with the provided viem account (EIP-712).
 * `wallet` is the viem account from LocalWalletService.getViemAccount().
 */
export function createExchangeClient(network: Network, wallet: unknown): ExchangeLike {
  const transport = new HttpTransport({ isTestnet: resolveIsTestnet(network) });
  return new ExchangeClient({ wallet: wallet as never, transport }) as unknown as ExchangeLike;
}
