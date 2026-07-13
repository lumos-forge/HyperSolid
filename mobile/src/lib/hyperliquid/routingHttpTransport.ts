import { HttpTransport } from "@nktkas/hyperliquid";
import type { Network } from "../../state/envStore";
import type { TrafficType } from "../routing/selectRoute";
import { resolveApiUrl } from "../routing/resolveApiUrl";
import { hlRestBase } from "../routing/detectEnv";
import { markCooldown } from "../routing/proxyCooldown";
import { resolveIsTestnet } from "./network";

/** Minimal transport contract the SDK clients accept (structurally an IRequestTransport). */
interface RequestTransport {
  isTestnet: boolean;
  request<T>(endpoint: "info" | "exchange" | "explorer", payload: unknown, signal?: AbortSignal): Promise<T>;
}

/** A proxy-attributable failure: 429 / gateway 5xx, or a network/timeout error (no response).
 *  A normal HL error response (e.g. 400/422) means the proxy worked → not a proxy failure. */
export function isProxyFailure(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  if (typeof status === "number") return status === 429 || status === 502 || status === 503 || status === 504;
  return true;
}

/** Resolves the base per-request (respecting cooldown); on a proxy failure marks a cooldown and
 *  retries once directly. Direct requests are not retried. */
export class RoutingHttpTransport implements RequestTransport {
  isTestnet: boolean;
  constructor(private network: Network, private traffic: TrafficType) {
    this.isTestnet = resolveIsTestnet(network);
  }
  async request<T>(endpoint: "info" | "exchange" | "explorer", payload: unknown, signal?: AbortSignal): Promise<T> {
    const base = resolveApiUrl(this.network, this.traffic);
    const direct = hlRestBase(this.network);
    try {
      return await new HttpTransport({ isTestnet: this.isTestnet, apiUrl: base }).request<T>(endpoint, payload, signal);
    } catch (e) {
      if (base !== direct && isProxyFailure(e)) {
        markCooldown(base);
        return await new HttpTransport({ isTestnet: this.isTestnet, apiUrl: direct }).request<T>(endpoint, payload, signal);
      }
      throw e;
    }
  }
}
