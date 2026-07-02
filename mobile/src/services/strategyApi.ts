import { fetchWithTimeout } from "../lib/fetchWithTimeout";

export type StrategyType = "dca" | "twap" | "tpsl";

export interface DcaParams {
  coin: string; side: "buy"; quoteAmountUsdc: number; intervalHours: number; maxTotalUsdc?: number;
}
export interface TwapParams {
  coin: string; side: "buy" | "sell"; totalUsdc: number; slices: number; durationHours: number;
}
export interface TpslParams {
  coin: string; takeProfitPrice?: number; stopLossPrice?: number;
}
export type StrategyParams = DcaParams | TwapParams | TpslParams;

export interface Strategy {
  id: string;
  type: StrategyType;
  params: StrategyParams;
  status: "running" | "paused" | "completed";
  filledTotalUsdc?: number;
  nextRunAt?: number;
  slicesDone?: number;
  triggeredAt?: number;
}

export interface Activity {
  id: string;
  time: number;
  coin: string;
  side: string;
  sz: number;
  px: number;
}

export interface AgentStatus {
  approved: boolean;
  agentAddress?: string;
  validUntil?: number;
}

/** Typed client for the strategy backend (contract: spec §App↔Backend). Inject `fetch` in tests. */
export class StrategyApi {
  constructor(
    private baseUrl: string,
    private token: string | null,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await fetchWithTimeout(
      `${this.baseUrl.replace(/\/$/, "")}${path}`,
      {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      10_000,
      this.fetchImpl,
    );
    if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status}`);
    return (await res.json().catch(() => ({}))) as T;
  }

  // auth (wallet-signature session)
  challenge(owner: string) {
    return this.request<{ nonce: string }>("/auth/challenge", "POST", { owner });
  }
  session(owner: string, nonce: string, signature: string) {
    return this.request<{ token: string }>("/auth/session", "POST", { owner, nonce, signature });
  }

  // agent
  provisionAgent() {
    return this.request<{ agentAddress: string }>("/agent/provision", "POST");
  }
  confirmAgent(agentAddress: string) {
    return this.request<void>("/agent/confirm", "POST", { agentAddress });
  }
  agentStatus() {
    return this.request<AgentStatus>("/agent/status", "GET");
  }
  revokeAgent() {
    return this.request<void>("/agent/revoke", "POST");
  }

  // strategies
  listStrategies() {
    return this.request<Strategy[]>("/strategies", "GET");
  }
  createStrategy(type: StrategyType, params: StrategyParams) {
    return this.request<Strategy>("/strategies", "POST", { type, params });
  }
  setStrategyStatus(id: string, status: "running" | "paused") {
    return this.request<Strategy>(`/strategies/${id}`, "PATCH", { status });
  }
  deleteStrategy(id: string) {
    return this.request<void>(`/strategies/${id}`, "DELETE");
  }
  getActivity(id: string) {
    return this.request<Activity[]>(`/strategies/${id}/activity`, "GET");
  }
  killSwitch() {
    return this.request<void>("/kill-switch", "POST");
  }
}
