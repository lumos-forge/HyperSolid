import { WebSocketTransport } from "@nktkas/hyperliquid";
import type { Network } from "../../state/envStore";
import type { TrafficType } from "../routing/selectRoute";
import { resolveWsUrl } from "../routing/resolveApiUrl";
import { hlRestBase } from "../routing/detectEnv";
import { markCooldown } from "../routing/proxyCooldown";
import { resolveIsTestnet } from "./network";

interface Subscription {
  unsubscribe(): Promise<void>;
  failureSignal: AbortSignal;
}
interface SubscriptionTransport {
  isTestnet: boolean;
  subscribe<T>(channel: string, payload: unknown, listener: (data: CustomEvent<T>) => void): Promise<Subscription>;
}

/** `wss://host/ws` → the http base used as the cooldown key (matches routedBase/markCooldown). */
export function wsToHttpBase(wsUrl: string): string {
  return wsUrl.replace(/^wss/, "https").replace(/\/ws$/, "");
}

/** Wraps a single WebSocketTransport at the routed WS endpoint; on a subscription failure
 *  (failureSignal abort) for a proxied endpoint, marks the proxy for cooldown so later
 *  requests/clients route direct. */
export class RoutingWsTransport implements SubscriptionTransport {
  isTestnet: boolean;
  private inner: WebSocketTransport;
  private wsUrl: string;
  private directWs: string;
  constructor(network: Network, traffic: TrafficType) {
    this.isTestnet = resolveIsTestnet(network);
    this.wsUrl = resolveWsUrl(network, traffic);
    this.directWs = `${hlRestBase(network).replace(/^http/, "ws")}/ws`;
    this.inner = new WebSocketTransport({ isTestnet: this.isTestnet, url: this.wsUrl });
  }
  async subscribe<T>(channel: string, payload: unknown, listener: (data: CustomEvent<T>) => void): Promise<Subscription> {
    const sub = await (this.inner as unknown as SubscriptionTransport).subscribe<T>(channel, payload, listener);
    if (this.wsUrl !== this.directWs) {
      sub.failureSignal.addEventListener("abort", () => markCooldown(wsToHttpBase(this.wsUrl)), { once: true });
    }
    return sub;
  }
}
