import { fetchWithTimeout } from "../lib/fetchWithTimeout";

export type StrategyType = "dca" | "twap" | "tpsl" | "grid" | "gridLimit";

export interface StrategyParamsCommon {
  /** Opt-in: while this strategy runs, arm the account-level scheduleCancel dead-man switch. */
  deadMan?: boolean;
}

export interface DcaParams extends StrategyParamsCommon {
  coin: string; side: "buy"; quoteAmountUsdc: number; intervalHours: number; maxTotalUsdc?: number;
}
export interface TwapParams extends StrategyParamsCommon {
  coin: string; side: "buy" | "sell"; totalUsdc: number; slices: number; durationHours: number;
}
export interface TpslParams extends StrategyParamsCommon {
  coin: string; takeProfitPrice?: number; stopLossPrice?: number;
}
export interface GridParams extends StrategyParamsCommon {
  coin: string; lowerPrice: number; upperPrice: number; levels: number; perLevelUsdc: number;
  mode?: "longOnly" | "symmetric";
}
export interface GridLimitParams extends StrategyParamsCommon {
  coin: string; lowerPrice: number; upperPrice: number; levels: number; perLevelUsdc: number;
  mode?: "longOnly" | "symmetric";
}
export type StrategyParams = DcaParams | TwapParams | TpslParams | GridParams | GridLimitParams;

export interface Rung {
  rung: number;
  state: "idle" | "armed" | "holding";
  buyPrice: number;
  sellPrice: number;
}

export interface Strategy {
  id: string;
  type: StrategyType;
  params: StrategyParams;
  status: "running" | "paused" | "completed" | "canceling";
  filledTotalUsdc?: number;
  nextRunAt?: number;
  slicesDone?: number;
  triggeredAt?: number;
  lastLevel?: number;
  armedCount?: number;
  holdingCount?: number;
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

  // push registration (M7 P3)
  registerPush(token: string, platform: string, locale: string) {
    return this.request<void>("/push/register", "POST", { token, platform, locale });
  }
  unregisterPush(token: string) {
    return this.request<void>("/push/unregister", "POST", { token });
  }
  getPushPrefs() {
    return this.request<{ fills: boolean; alerts: boolean; lifecycle: boolean }>("/push/prefs", "GET");
  }
  setPushPrefs(prefs: { fills?: boolean; alerts?: boolean; lifecycle?: boolean }) {
    return this.request<void>("/push/prefs", "POST", prefs);
  }
  getQuietHours() {
    return this.request<{ enabled: boolean; start: number; end: number; tz: string }>("/push/quiet-hours", "GET");
  }
  setQuietHours(qh: { enabled: boolean; start: number; end: number; tz: string }) {
    return this.request<void>("/push/quiet-hours", "POST", qh);
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
  getRungs(id: string) {
    return this.request<Rung[]>(`/strategies/${id}/rungs`, "GET");
  }
  getRecentActivity(limit?: number) {
    const q = limit ? `?limit=${limit}` : "";
    return this.request<Activity[]>(`/activity${q}`, "GET");
  }
  killSwitch() {
    return this.request<void>("/kill-switch", "POST");
  }
}
