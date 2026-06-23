# Strategy App Control Plane (Phase C, sub-project 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the App-side control plane for Strategy automation — approve a trade-only HL agent, manage DCA strategies via the backend, and show status — all from the existing Strategy tab, backend mocked in tests.

**Architecture:** Add a server-delivered `strategyApiBaseUrl`, a typed `StrategyApi` HTTP client (wallet-signature auth → bearer token, agent provision/confirm/status/revoke, strategy CRUD, activity, kill-switch), a wallet-signature session helper, and wire `AgentScreen` to them. Signing reuses the on-device main key (`ExchangeService.approveAgent` already exists). Backend is mocked (injected `fetch`/`StrategyApi`) — no real network in tests.

**Tech Stack:** Expo RN + TS; zustand; viem account `signMessage`; `@nktkas/hyperliquid` (approveAgent, already wired); Jest + `@testing-library/react-native`.

**Spec:** `docs/superpowers/specs/2026-06-23-strategy-automation-design.md` (decisions locked). Backend contract lives there.

---

## Conventions (every task)

- Baseline: `cd mobile && npx tsc --noEmit` → 0; `npx jest` → green (currently **457**). Each task grows jest.
- TDD: failing test → watch fail → implement → pass → commit. Colors via tokens; ▲▼◷ geometric only; no hardcoded hex outside `tokens.ts`. No real network/keys in tests.
- Commit `--no-verify` with `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`. Push only when the user asks.

## File Structure (this plan)

- `src/state/runtimeConfigStore.ts` — add `strategyApiBaseUrl` (server-delivered).
- `src/services/appConfig.ts` — parse `strategyApiBaseUrl`.
- `src/services/strategyApi.ts` *(new)* — typed backend client (auth + agent + strategies).
- `src/services/strategyApi.test.ts` *(new)*.
- `src/wallet/walletSession.ts` *(new)* — wallet-signature session (challenge → signMessage → token).
- `src/wallet/walletSession.test.ts` *(new)*.
- `src/screens/AgentScreen.tsx` — replace the mock with real agent-approval + strategy management.

---

### Task 1: `strategyApiBaseUrl` in the server-delivered config

**Files:**
- Modify: `src/state/runtimeConfigStore.ts`
- Modify: `src/services/appConfig.ts`
- Test: `src/state/runtimeConfigStore.test.ts`, `src/services/appConfig.test.ts`

- [ ] **Step 1: Failing test** — append to `src/state/runtimeConfigStore.test.ts`:

```ts
it("exposes the server-delivered strategy API base URL", () => {
  expect(useRuntimeConfigStore.getState().strategyApiBaseUrl).toBeNull();
  useRuntimeConfigStore.getState().setConfig({
    arbitrumRpc: { mainnet: null, testnet: null },
    withdrawFeeUsdc: { mainnet: null, testnet: null },
    strategyApiBaseUrl: "https://api.example.com",
  });
  expect(useRuntimeConfigStore.getState().strategyApiBaseUrl).toBe("https://api.example.com");
});
```

- [ ] **Step 2: Run → FAIL** (`strategyApiBaseUrl` missing). `cd mobile && npx jest src/state/runtimeConfigStore.test.ts`

- [ ] **Step 3: Implement** — in `src/state/runtimeConfigStore.ts`:
  - In `AppRuntimeConfig` add `strategyApiBaseUrl: string | null;`
  - In the store initial state add `strategyApiBaseUrl: null,` and in `setConfig` add `strategyApiBaseUrl: cfg.strategyApiBaseUrl,`.

- [ ] **Step 4: Parse it** — in `src/services/appConfig.ts`: add `strategyApiBaseUrl?: string | null;` to `RawAppConfig`, and in the returned object add `strategyApiBaseUrl: raw.strategyApiBaseUrl ?? null,`. Update the two `appConfig.test.ts` assertions to also expect `strategyApiBaseUrl` (`null` when absent; the delivered value when present).

- [ ] **Step 5: Run → PASS** (`npx jest src/state/runtimeConfigStore.test.ts src/services/appConfig.test.ts`), then `npx tsc --noEmit`.

- [ ] **Step 6: Commit**

```bash
git add mobile/src/state/runtimeConfigStore.ts mobile/src/state/runtimeConfigStore.test.ts mobile/src/services/appConfig.ts mobile/src/services/appConfig.test.ts
git commit --no-verify -m "feat(mobile): server-delivered strategyApiBaseUrl in runtime config

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: `StrategyApi` backend client

**Files:**
- Create: `src/services/strategyApi.ts`
- Test: `src/services/strategyApi.test.ts`

- [ ] **Step 1: Failing test** — `src/services/strategyApi.test.ts`:

```ts
import { StrategyApi } from "./strategyApi";

function res(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe("StrategyApi", () => {
  it("requests a challenge and exchanges a signature for a token", async () => {
    const fetchImpl = jest.fn(async () => res({ token: "jwt-123" })) as unknown as typeof fetch;
    const api = new StrategyApi("https://api/", null, fetchImpl);
    const out = await api.session("0xowner", "nonce-1", "0xsig");
    expect(out.token).toBe("jwt-123");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api/auth/session",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends the bearer token and parses strategies", async () => {
    const fetchImpl = jest.fn(async () => res([{ id: "s1", type: "dca", params: {}, status: "running" }])) as unknown as typeof fetch;
    const api = new StrategyApi("https://api", "tok", fetchImpl);
    const list = await api.listStrategies();
    expect(list).toHaveLength(1);
    const init = (fetchImpl.mock.calls[0][1] ?? {}) as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("creates a DCA strategy with the params in the body", async () => {
    const fetchImpl = jest.fn(async () => res({ id: "s2", type: "dca", params: {}, status: "running" })) as unknown as typeof fetch;
    const api = new StrategyApi("https://api", "tok", fetchImpl);
    await api.createStrategy({ coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 });
    const init = (fetchImpl.mock.calls[0][1] ?? {}) as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      type: "dca",
      params: { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 },
    });
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl = jest.fn(async () => res({}, false, 401)) as unknown as typeof fetch;
    const api = new StrategyApi("https://api", "tok", fetchImpl);
    await expect(api.listStrategies()).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run → FAIL** (module missing). `cd mobile && npx jest src/services/strategyApi.test.ts`

- [ ] **Step 3: Implement** — `src/services/strategyApi.ts`:

```ts
export interface DcaParams {
  coin: string;
  side: "buy";
  quoteAmountUsdc: number;
  intervalHours: number;
  maxTotalUsdc?: number;
}

export interface Strategy {
  id: string;
  type: "dca";
  params: DcaParams;
  status: "running" | "paused";
  filledTotalUsdc?: number;
  nextRunAt?: number;
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
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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
  createStrategy(params: DcaParams) {
    return this.request<Strategy>("/strategies", "POST", { type: "dca", params });
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
```

- [ ] **Step 4: Run → PASS** (`npx jest src/services/strategyApi.test.ts`), then `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/services/strategyApi.ts mobile/src/services/strategyApi.test.ts
git commit --no-verify -m "feat(mobile): StrategyApi backend client (auth + agent + strategies)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Wallet-signature session helper

**Files:**
- Create: `src/wallet/walletSession.ts`
- Test: `src/wallet/walletSession.test.ts`

The session flow: `challenge(owner)` → sign the nonce with the on-device main key (`account.signMessage({ message })`) → `session(owner, nonce, signature)` → token. `account` is the viem account from `LocalWalletService.getViemAccount()`.

- [ ] **Step 1: Failing test** — `src/wallet/walletSession.test.ts`:

```ts
import { openStrategySession } from "./walletSession";

const api = {
  challenge: jest.fn(async () => ({ nonce: "nonce-xyz" })),
  session: jest.fn(async () => ({ token: "tok-abc" })),
};
const account = { signMessage: jest.fn(async () => "0xsig") };

describe("openStrategySession", () => {
  it("challenges, signs the nonce with the main key, and returns the token", async () => {
    const token = await openStrategySession(api as never, account as never, "0xowner");
    expect(api.challenge).toHaveBeenCalledWith("0xowner");
    expect(account.signMessage).toHaveBeenCalledWith({ message: "nonce-xyz" });
    expect(api.session).toHaveBeenCalledWith("0xowner", "nonce-xyz", "0xsig");
    expect(token).toBe("tok-abc");
  });
});
```

- [ ] **Step 2: Run → FAIL**. `cd mobile && npx jest src/wallet/walletSession.test.ts`

- [ ] **Step 3: Implement** — `src/wallet/walletSession.ts`:

```ts
import type { StrategyApi } from "../services/strategyApi";

interface SignerAccount {
  signMessage(args: { message: string }): Promise<string>;
}

/** Open a backend session by signing the challenge nonce with the on-device main key (spec §Auth). */
export async function openStrategySession(
  api: StrategyApi,
  account: SignerAccount,
  owner: string,
): Promise<string> {
  const { nonce } = await api.challenge(owner);
  const signature = await account.signMessage({ message: nonce });
  const { token } = await api.session(owner, nonce, signature);
  return token;
}
```

- [ ] **Step 4: Run → PASS**, then `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/wallet/walletSession.ts mobile/src/wallet/walletSession.test.ts
git commit --no-verify -m "feat(mobile): wallet-signature strategy session helper

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Wire `AgentScreen` to real agent approval + strategy management

Replace the v8 mock shell. Build the screen from the pieces above + the existing `ExchangeService.approveAgent`. Because this is screen wiring with several async flows, build it behind a small `useStrategyController` hook so the logic is testable without the full UI.

**Files:**
- Create: `src/hooks/useStrategyController.ts`
- Test: `src/hooks/useStrategyController.test.ts`
- Modify: `src/screens/AgentScreen.tsx` (+ `src/screens/AgentScreen.test.tsx`)

- [ ] **Step 1: Failing test (controller)** — `src/hooks/useStrategyController.test.ts`:

```ts
import { renderHook, act, waitFor } from "@testing-library/react-native";
import { useStrategyController } from "./useStrategyController";

const api = {
  agentStatus: jest.fn(async () => ({ approved: false })),
  provisionAgent: jest.fn(async () => ({ agentAddress: "0x" + "9".repeat(40) })),
  confirmAgent: jest.fn(async () => undefined),
  listStrategies: jest.fn(async () => []),
  createStrategy: jest.fn(async () => ({ id: "s1", type: "dca", params: {}, status: "running" })),
  setStrategyStatus: jest.fn(async () => ({ id: "s1", type: "dca", params: {}, status: "paused" })),
  killSwitch: jest.fn(async () => undefined),
};
const approveAgent = jest.fn(async () => ({ ok: true }));

describe("useStrategyController", () => {
  it("loads agent status + strategies on init", async () => {
    const { result } = renderHook(() => useStrategyController(api as never, approveAgent, "valid_until 1"));
    await waitFor(() => expect(api.agentStatus).toHaveBeenCalled());
    expect(api.listStrategies).toHaveBeenCalled();
    expect(result.current.approved).toBe(false);
  });

  it("approveAgentFlow: provisions, signs approveAgent, confirms", async () => {
    const { result } = renderHook(() => useStrategyController(api as never, approveAgent, "valid_until 1"));
    await act(async () => { await result.current.approveAgentFlow(); });
    expect(api.provisionAgent).toHaveBeenCalled();
    expect(approveAgent).toHaveBeenCalledWith({ agentAddress: "0x" + "9".repeat(40), agentName: "valid_until 1" });
    expect(api.confirmAgent).toHaveBeenCalledWith("0x" + "9".repeat(40));
  });
});
```

- [ ] **Step 2: Run → FAIL**. `cd mobile && npx jest src/hooks/useStrategyController.test.ts`

- [ ] **Step 3: Implement** — `src/hooks/useStrategyController.ts`:

```ts
import { useCallback, useEffect, useState } from "react";
import type { StrategyApi, Strategy, DcaParams, AgentStatus } from "../services/strategyApi";
import type { ApproveAgentResult } from "../services/exchange";

type ApproveAgentFn = (req: { agentAddress: string; agentName?: string }) => Promise<ApproveAgentResult>;

export function useStrategyController(api: StrategyApi, approveAgent: ApproveAgentFn, agentName: string) {
  const [status, setStatus] = useState<AgentStatus>({ approved: false });
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [s, list] = await Promise.all([api.agentStatus(), api.listStrategies()]);
    setStatus(s);
    setStrategies(list);
  }, [api]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const approveAgentFlow = useCallback(async () => {
    setBusy(true);
    try {
      const { agentAddress } = await api.provisionAgent();
      const res = await approveAgent({ agentAddress, agentName });
      if (!res.ok) return res;
      await api.confirmAgent(agentAddress);
      await refresh();
      return res;
    } finally {
      setBusy(false);
    }
  }, [api, approveAgent, agentName, refresh]);

  const createDca = useCallback(async (params: DcaParams) => {
    await api.createStrategy(params);
    await refresh();
  }, [api, refresh]);

  const toggle = useCallback(async (s: Strategy) => {
    await api.setStrategyStatus(s.id, s.status === "running" ? "paused" : "running");
    await refresh();
  }, [api, refresh]);

  const killAll = useCallback(async () => {
    await api.killSwitch();
    await refresh();
  }, [api, refresh]);

  return { approved: status.approved, status, strategies, busy, approveAgentFlow, createDca, toggle, killAll, refresh };
}
```

(Note: import `useCallback` from "react" — fix the import line to `import { useCallback, useEffect, useState } from "react";`.)

- [ ] **Step 4: Run → PASS**, then `npx tsc --noEmit`.

- [ ] **Step 5: Commit the controller**

```bash
git add mobile/src/hooks/useStrategyController.ts mobile/src/hooks/useStrategyController.test.ts
git commit --no-verify -m "feat(mobile): useStrategyController (agent approval + strategy management)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 6: Wire AgentScreen** — build the `StrategyApi` from `strategyApiBaseUrl` + a session token (open a session on first interaction via `openStrategySession` with `useWalletStore`'s account), instantiate `useStrategyController`, and render:
  - **Agent card:** if `!approved` → CTA "Authorize trading agent" → `approveAgentFlow()` (handle uncertain/failed via Alert, like withdraw); if approved → show `status.agentAddress` (short) + a Revoke action (`api.revokeAgent` then refresh).
  - **Strategies:** map `strategies` to the existing v8 `StrategyCard` look; the Toggle calls `toggle(s)`.
  - **New DCA:** the "New strategy" CTA opens a form (coin, amount, interval) → `createDca(...)`.
  - **Kill switch:** a destructive action → `killAll()`.
  - Reuse v8 styling (SurfaceCard, ChangeText, Icon, tokens). Update `AgentScreen.test.tsx`: mock `../services/strategyApi`, `../wallet/walletSession`, `../services/exchange`; assert the unapproved CTA calls the approve flow, the strategy list renders from the (mocked) API, and New-DCA calls `createStrategy`. Gate it behind a connected local wallet + a delivered `strategyApiBaseUrl`; show a clear "Strategy automation needs a local wallet + server config" state otherwise.

- [ ] **Step 7: Full gates + commit**

```bash
cd mobile && npx tsc --noEmit && npx jest
git add mobile/src/screens/AgentScreen.tsx mobile/src/screens/AgentScreen.test.tsx
git commit --no-verify -m "feat(mobile): wire Strategy tab to real agent approval + DCA management

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Self-Review

- **Spec coverage:** `strategyApiBaseUrl` ✓ T1; StrategyApi (auth/agent/strategies/activity/kill) ✓ T2; wallet-signature session ✓ T3; `ExchangeService.approveAgent` ✓ (already shipped, `5ad894a`); AgentScreen real wiring (approve/revoke, list, create-DCA, toggle, kill) ✓ T4. Backend execution = separate plan (`2026-06-23-strategy-backend-design.md`).
- **Placeholders:** T1–T3 carry complete code + commands. T4 splits the testable logic into `useStrategyController` (full code) and leaves the screen JSX as structured wiring (reusing existing v8 components) — acceptable for UI assembly over already-defined primitives.
- **Type consistency:** `DcaParams`/`Strategy`/`Activity`/`AgentStatus` defined in T2 are reused by T3/T4; `approveAgent({agentAddress, agentName})` matches the shipped `ExchangeService.approveAgent`; `strategyApiBaseUrl` key matches across store/appConfig.

## Progress

> Append one line per task: `YYYY-MM-DD · Task N · tests · one-line result`
