# Manual-Trader Client-Side Dead-Man Switch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in client-side dead-man for manual traders: while the app is foregrounded it keeps an HL `scheduleCancel` armed (`now + TTL`, TTL ∈ {1,2,5} min); on background/kill it fires and cancels all resting orders. ≤10/day budget-guarded, fail-safe.

**Architecture:** A persisted `deadManStore` (enabled + TTL) drives an app-wide `useManualDeadMan` hook that arms `scheduleCancel` via the local-wallet `ExchangeService` on a heartbeat, stops on background, and clears on disable. A pure `deadManBudget` enforces the HL 10/day counting cap.

**Tech Stack:** React Native (Expo), zustand + expo-secure-store, `@nktkas/hyperliquid`, AppState, Jest.

**Spec:** `docs/superpowers/specs/2026-07-14-manual-deadman-design.md`

---

## Background / invariants (read first)

- HL `scheduleCancel({ time })`: `time ≥ now+5s` cancels ALL resting orders at `time`; omitting `time`
  clears the schedule. Refreshing a still-future schedule is free; a counting arm is capped at 10/day.
- The manual trader's **local wallet** signs it — same non-custodial wallet that signs manual orders.
  `TradeScreen`/`AccountScreen` build a client via `createExchangeClient(network, local.getViemAccount())`
  and `new ExchangeService(client, buildAssetIndex({ universe: [] }))` (scheduleCancel needs no asset index).
- App-wide hooks are mounted in `App.tsx` (`useLiveMarkets`, `useAutoLock`, `useNetworkStatus`); stores
  are hydrated there (`useLockPrefsStore.getState().hydrate()` …). AppState pattern: see `useAutoLock.ts`.
- Persisted-preference store pattern: `routingStore.ts` (SecureStore, sync setter + best-effort persist + `hydrate`).
- The pure budget semantics already exist server-side (`server/src/engine/deadMan.ts` `decideBudget`/`nextBudget`); port them to a mobile `lib/deadManBudget.ts`.
- Conventions: user-facing strings in `i18n/messages.ts` (en+zh parity via `messages.test.ts`); theme tokens only (no hardcoded hex); validate `cd mobile && npx tsc --noEmit && npm test`.

**Files:**
- Create: `mobile/src/state/deadManStore.ts` (+ test), `mobile/src/lib/deadManBudget.ts` (+ test), `mobile/src/hooks/useManualDeadMan.ts` (+ test)
- Modify: `mobile/src/services/exchange.ts` (+ `exchange.test.ts`), `mobile/src/state/exchangeStore.test.ts` (fake client), `mobile/App.tsx`, `mobile/src/screens/SettingsScreen.tsx`, `mobile/src/i18n/messages.ts`

---

## Task 1: Store + budget + `scheduleCancel` service

### 1a. `deadManStore`

**Files:** Create `mobile/src/state/deadManStore.ts`, `mobile/src/state/deadManStore.test.ts`

- [ ] **Step 1: Create the store**

```ts
import { create } from "zustand";
import * as SecureStore from "expo-secure-store";

export const DEADMAN_TTL_OPTIONS = [1, 2, 5] as const;
export type DeadManTtl = (typeof DEADMAN_TTL_OPTIONS)[number];
const DEFAULT_TTL: DeadManTtl = 2;
const ENABLED_KEY = "hypersolid.pref.deadman.enabled";
const TTL_KEY = "hypersolid.pref.deadman.ttlMinutes";
const opts = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;

interface DeadManState {
  enabled: boolean;
  ttlMinutes: DeadManTtl;
  setEnabled: (v: boolean) => void;
  setTtlMinutes: (m: DeadManTtl) => void;
  hydrate: () => Promise<void>;
}

/**
 * Manual-trader dead-man preference (opt-in, default OFF). When enabled, the app keeps an HL
 * scheduleCancel armed while foregrounded so all resting orders auto-cancel `ttlMinutes` after the app
 * closes. Device-bound persistence, hydrated once at launch (mirrors routingStore).
 */
export const useDeadManStore = create<DeadManState>((set) => ({
  enabled: false,
  ttlMinutes: DEFAULT_TTL,
  setEnabled: (enabled) => {
    set({ enabled });
    void SecureStore.setItemAsync(ENABLED_KEY, enabled ? "1" : "0", opts).catch(() => {});
  },
  setTtlMinutes: (ttlMinutes) => {
    set({ ttlMinutes });
    void SecureStore.setItemAsync(TTL_KEY, String(ttlMinutes), opts).catch(() => {});
  },
  hydrate: async () => {
    try {
      const e = await SecureStore.getItemAsync(ENABLED_KEY);
      const t = await SecureStore.getItemAsync(TTL_KEY);
      const ttl = t ? Number(t) : DEFAULT_TTL;
      set({
        enabled: e === "1",
        ttlMinutes: (DEADMAN_TTL_OPTIONS as readonly number[]).includes(ttl) ? (ttl as DeadManTtl) : DEFAULT_TTL,
      });
    } catch {
      /* best-effort: keep defaults */
    }
  },
}));
```

- [ ] **Step 2: Test** (`deadManStore.test.ts`) — mock `expo-secure-store`:

```ts
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "x",
  setItemAsync: jest.fn(async () => {}),
  getItemAsync: jest.fn(async () => null),
}));
import * as SecureStore from "expo-secure-store";
import { useDeadManStore, DEADMAN_TTL_OPTIONS } from "./deadManStore";

describe("deadManStore", () => {
  beforeEach(() => useDeadManStore.setState({ enabled: false, ttlMinutes: 2 }));

  it("defaults to disabled, 2 min", () => {
    expect(useDeadManStore.getState().enabled).toBe(false);
    expect(useDeadManStore.getState().ttlMinutes).toBe(2);
  });

  it("persists enable + ttl", () => {
    useDeadManStore.getState().setEnabled(true);
    useDeadManStore.getState().setTtlMinutes(5);
    expect(useDeadManStore.getState().enabled).toBe(true);
    expect(useDeadManStore.getState().ttlMinutes).toBe(5);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("hypersolid.pref.deadman.enabled", "1", expect.anything());
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("hypersolid.pref.deadman.ttlMinutes", "5", expect.anything());
  });

  it("hydrates a persisted value and rejects an out-of-range ttl", async () => {
    (SecureStore.getItemAsync as jest.Mock).mockImplementation(async (k: string) =>
      k.endsWith("enabled") ? "1" : "9");
    await useDeadManStore.getState().hydrate();
    expect(useDeadManStore.getState().enabled).toBe(true);
    expect(DEADMAN_TTL_OPTIONS).toContain(useDeadManStore.getState().ttlMinutes);
    expect(useDeadManStore.getState().ttlMinutes).toBe(2); // 9 rejected → default
  });
});
```

### 1b. `deadManBudget`

**Files:** Create `mobile/src/lib/deadManBudget.ts`, `mobile/src/lib/deadManBudget.test.ts`

- [ ] **Step 3: Create the pure budget**

```ts
export const DEADMAN_MAX_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Per-owner arm budget: the UTC day, that day's counting-arm count, and the armed-until time (ms). */
export interface ArmBudget {
  day: number;
  count: number;
  armedUntil: number;
}
export type ArmDecision = { skip: true } | { skip: false; time: number; counts: boolean };

/** A still-future schedule → free refresh; else a counting new-arm unless the day's 10 is exhausted. */
export function decideArm(prev: ArmBudget | undefined, nowMs: number, ttlMs: number): ArmDecision {
  const time = nowMs + ttlMs;
  const day = Math.floor(nowMs / DAY_MS);
  const count = prev && prev.day === day ? prev.count : 0;
  const armedUntil = prev ? prev.armedUntil : 0;
  if (armedUntil > nowMs) return { skip: false, time, counts: false };
  if (count >= DEADMAN_MAX_PER_DAY) return { skip: true };
  return { skip: false, time, counts: true };
}

/** Commit a successful arm: armedUntil=time; increment the day's counter iff counts (reset on new day). */
export function nextArm(prev: ArmBudget | undefined, nowMs: number, time: number, counts: boolean): ArmBudget {
  const day = Math.floor(nowMs / DAY_MS);
  const base = prev && prev.day === day ? prev.count : 0;
  return { day, count: base + (counts ? 1 : 0), armedUntil: time };
}
```

- [ ] **Step 4: Test** (`deadManBudget.test.ts`):

```ts
import { decideArm, nextArm, DEADMAN_MAX_PER_DAY } from "./deadManBudget";

describe("deadManBudget", () => {
  it("first arm counts; a still-future refresh is free", () => {
    const d0 = decideArm(undefined, 0, 60_000);
    expect(d0).toEqual({ skip: false, time: 60_000, counts: true });
    const b0 = nextArm(undefined, 0, 60_000, true);
    expect(decideArm(b0, 10_000, 60_000)).toEqual({ skip: false, time: 70_000, counts: false });
  });

  it("skips once the daily budget is exhausted", () => {
    let b = nextArm(undefined, 0, 1_000, true);
    let t = 2_000;
    for (let i = 1; i < DEADMAN_MAX_PER_DAY; i++) {
      const d = decideArm(b, t, 1_000);
      expect(d.skip).toBe(false);
      if (!d.skip) b = nextArm(b, t, d.time, d.counts);
      t += 2_000;
    }
    expect(decideArm(b, t, 1_000)).toEqual({ skip: true });
  });

  it("resets the counter on a new UTC day", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const b = nextArm(undefined, 0, 1_000, true);
    expect(decideArm(b, DAY + 1, 10_000)).toEqual({ skip: false, time: DAY + 1 + 10_000, counts: true });
  });
});
```

### 1c. `ExchangeService.scheduleCancel`

**Files:** Modify `mobile/src/services/exchange.ts`, `mobile/src/services/exchange.test.ts`, `mobile/src/state/exchangeStore.test.ts`

- [ ] **Step 5: Add to `ExchangeLike` + result type + method (`exchange.ts`)**

Add to the `ExchangeLike` interface:

```ts
  scheduleCancel(params: { time?: number }): Promise<unknown>;
```

Add a result type near `ApproveBuilderFeeResult`:

```ts
/** Result of arming/clearing the dead-man scheduleCancel. Uncertain receipt is never assumed ok. */
export type ScheduleCancelResult =
  | { ok: true; response?: unknown }
  | { ok: false; error: string; uncertain?: boolean };
```

Add the method (after `approveBuilderFee`):

```ts
  /**
   * Arm (with `time`) or clear (omit `time`) the account's HL scheduleCancel — the manual dead-man.
   * Signed by the local wallet. A thrown receipt is uncertain (never assumed ok), so the caller retries.
   */
  async scheduleCancel(time?: number): Promise<ScheduleCancelResult> {
    try {
      const response = await this.client.scheduleCancel(time === undefined ? {} : { time });
      return { ok: true, response };
    } catch (e) {
      return { ok: false, error: errorMessage(e), uncertain: true };
    }
  }
```

- [ ] **Step 6: Update the fake clients + add tests**

In `exchange.test.ts`, add `scheduleCancelArg?` to `FakeClient` and `scheduleCancel` to `fakeClient()`:

```ts
    scheduleCancel: jest.fn(async (p: unknown) => {
      self.scheduleCancelArg = p;
      return { status: "ok" };
    }),
```

Add tests:

```ts
describe("ExchangeService.scheduleCancel", () => {
  it("arms with a time", async () => {
    const client = fakeClient();
    const res = await new ExchangeService(client, index).scheduleCancel(1_700_000_000_000);
    expect(res.ok).toBe(true);
    expect(client.scheduleCancelArg).toEqual({ time: 1_700_000_000_000 });
  });
  it("clears with no time", async () => {
    const client = fakeClient();
    await new ExchangeService(client, index).scheduleCancel();
    expect(client.scheduleCancelArg).toEqual({});
  });
  it("reports an uncertain receipt on throw", async () => {
    const client = fakeClient();
    (client.scheduleCancel as jest.Mock).mockRejectedValueOnce(new Error("net"));
    const res = await new ExchangeService(client, index).scheduleCancel(1);
    expect(res).toMatchObject({ ok: false, uncertain: true });
  });
});
```

In `exchangeStore.test.ts`, add `scheduleCancel: jest.fn(),` to the fake `client` object (so it still satisfies `ExchangeLike`).

- [ ] **Step 7: Verify Task 1**

Run: `cd mobile && npx jest src/state/deadManStore.test.ts src/lib/deadManBudget.test.ts src/services/exchange.test.ts src/state/exchangeStore.test.ts && npx tsc --noEmit`
Expected: PASS + clean.

- [ ] **Step 8: Commit**

```bash
git add mobile/src/state/deadManStore.ts mobile/src/state/deadManStore.test.ts mobile/src/lib/deadManBudget.ts mobile/src/lib/deadManBudget.test.ts mobile/src/services/exchange.ts mobile/src/services/exchange.test.ts mobile/src/state/exchangeStore.test.ts
git commit -m "feat(deadman): manual dead-man store, budget, and scheduleCancel service

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: `useManualDeadMan` hook + app-wide mount

**Files:** Create `mobile/src/hooks/useManualDeadMan.ts`, `mobile/src/hooks/useManualDeadMan.test.tsx`; modify `mobile/App.tsx`

- [ ] **Step 1: Write the hook**

Create `mobile/src/hooks/useManualDeadMan.ts`:

```ts
import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useDeadManStore } from "../state/deadManStore";
import { useWalletStore } from "../state/walletStore";
import { useEnvStore } from "../state/envStore";
import { createExchangeClient } from "../lib/hyperliquid/client";
import { buildAssetIndex } from "../lib/hyperliquid/assetId";
import { ExchangeService } from "../services/exchange";
import { decideArm, nextArm, type ArmBudget } from "../lib/deadManBudget";
import type { LocalWalletService } from "../wallet/localWallet";

/** Heartbeat interval: half the TTL, floored at 20s — strictly < TTL so refreshes stay free. */
export function heartbeatMs(ttlMs: number): number {
  return Math.max(20_000, Math.floor(ttlMs / 2));
}

function makeService(network: ReturnType<typeof useEnvStore.getState>["network"]): ExchangeService | null {
  const { mode, wallet } = useWalletStore.getState();
  if (mode !== "local" || !wallet) return null;
  const local = wallet as Partial<LocalWalletService>;
  if (typeof local.getViemAccount !== "function") return null;
  return new ExchangeService(createExchangeClient(network, local.getViemAccount()), buildAssetIndex({ universe: [] }));
}

/**
 * Manual-trader dead-man (opt-in). While enabled + foregrounded + a local wallet is connected, keeps an
 * HL scheduleCancel armed (`now + ttl`) on a heartbeat (< ttl → refreshes are free, ≤10/day budget-
 * guarded). On background the interval stops so the armed schedule fires (cancels all resting orders) if
 * the app stays gone past the ttl. On disable / wallet change / unmount it clears the schedule so there's
 * no surprise cancellation while the user is active. Fail-safe: an arm error just skips the tick.
 */
export function useManualDeadMan(): void {
  const enabled = useDeadManStore((s) => s.enabled);
  const ttlMinutes = useDeadManStore((s) => s.ttlMinutes);
  const mode = useWalletStore((s) => s.mode);
  const address = useWalletStore((s) => s.address);
  const network = useEnvStore((s) => s.network);
  const budgetRef = useRef<ArmBudget | undefined>(undefined);

  // A new wallet/network is a new HL account → reset the arm budget.
  useEffect(() => {
    budgetRef.current = undefined;
  }, [address, network]);

  useEffect(() => {
    if (!(enabled && mode === "local" && address)) return;
    const service = makeService(network);
    if (!service) return;
    const ttlMs = ttlMinutes * 60_000;

    async function arm(): Promise<void> {
      const now = Date.now();
      const d = decideArm(budgetRef.current, now, ttlMs);
      if (d.skip) return;
      const res = await service!.scheduleCancel(d.time);
      if (res.ok) budgetRef.current = nextArm(budgetRef.current, now, d.time, d.counts);
    }

    let timer: ReturnType<typeof setInterval> | null = null;
    function start(): void {
      if (timer) return;
      void arm();
      timer = setInterval(() => void arm(), heartbeatMs(ttlMs));
    }
    function stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }

    if (AppState.currentState === "active") start();
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (next === "active") start();
      else stop(); // background/inactive → leave the armed schedule to fire
    });

    return () => {
      sub.remove();
      stop();
      // Disable / wallet change / unmount while the user is present → clear (no surprise cancellation).
      void service.scheduleCancel().catch(() => undefined);
    };
  }, [enabled, ttlMinutes, mode, address, network]);
}
```

> If the `LocalWalletService` import path differs, match `TradeScreen.tsx`'s import (it uses the same `getViemAccount` cast). If `getViemAccount`'s return type doesn't satisfy `createExchangeClient`, cast the account as `TradeScreen` does.

- [ ] **Step 2: Test the hook** (`useManualDeadMan.test.tsx`)

```ts
import { renderHook } from "@testing-library/react-native";
import { AppState } from "react-native";
import { useManualDeadMan } from "./useManualDeadMan";
import { useDeadManStore } from "../state/deadManStore";
import { useWalletStore } from "../state/walletStore";

const scheduleCancel = jest.fn(async () => ({ ok: true as const }));
jest.mock("../services/exchange", () => ({ ExchangeService: jest.fn().mockImplementation(() => ({ scheduleCancel })) }));
jest.mock("../lib/hyperliquid/client", () => ({ createExchangeClient: jest.fn(() => ({})) }));

const localWallet = { getAddress: () => "0xabc", getViemAccount: () => ({}) } as never;

function setAppState(state: string) {
  (AppState as unknown as { currentState: string }).currentState = state;
}
let listener: ((s: string) => void) | null = null;
beforeAll(() => {
  jest.spyOn(AppState, "addEventListener").mockImplementation(((_e: string, cb: (s: string) => void) => {
    listener = cb;
    return { remove: () => { listener = null; } };
  }) as never);
});

beforeEach(() => {
  jest.useFakeTimers();
  scheduleCancel.mockClear();
  setAppState("active");
  useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
  useDeadManStore.setState({ enabled: false, ttlMinutes: 2 });
});
afterEach(() => jest.useRealTimers());

describe("useManualDeadMan", () => {
  it("does nothing while disabled", () => {
    renderHook(() => useManualDeadMan());
    expect(scheduleCancel).not.toHaveBeenCalled();
  });

  it("arms immediately when enabled + active + local wallet", () => {
    useDeadManStore.setState({ enabled: true, ttlMinutes: 2 });
    renderHook(() => useManualDeadMan());
    expect(scheduleCancel).toHaveBeenCalledTimes(1);
    expect(scheduleCancel.mock.calls[0][0]).toBeGreaterThan(Date.now()); // armed with a future time
  });

  it("refreshes on the heartbeat and stops on background", () => {
    useDeadManStore.setState({ enabled: true, ttlMinutes: 2 });
    renderHook(() => useManualDeadMan());
    expect(scheduleCancel).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60_000); // heartbeat = ttl/2 = 60s
    expect(scheduleCancel).toHaveBeenCalledTimes(2);
    listener?.("background");
    jest.advanceTimersByTime(120_000);
    expect(scheduleCancel).toHaveBeenCalledTimes(2); // no more arms after background
  });

  it("clears the schedule (no time) when disabled", () => {
    useDeadManStore.setState({ enabled: true, ttlMinutes: 2 });
    const { rerender } = renderHook(() => useManualDeadMan());
    scheduleCancel.mockClear();
    useDeadManStore.setState({ enabled: false });
    rerender({});
    expect(scheduleCancel).toHaveBeenCalledWith(undefined); // cleanup clear
  });
});
```

> `renderHook` triggers effects synchronously. If `scheduleCancel` (async) hasn't resolved before an assertion, the call count still reflects invocation (the mock is called synchronously inside `arm`). Adjust `advanceTimersByTime`/`await` if the harness needs it.

- [ ] **Step 3: Mount app-wide in `App.tsx`**

Add the import and hydrate + mount alongside the others:

```ts
import { useManualDeadMan } from "./src/hooks/useManualDeadMan";
import { useDeadManStore } from "./src/state/deadManStore";
```

In the launch hydrate effect (next to `useLockPrefsStore.getState().hydrate()`):

```ts
    void useDeadManStore.getState().hydrate();
```

Next to `useAutoLock();`:

```ts
  useManualDeadMan();
```

- [ ] **Step 4: Verify Task 2**

Run: `cd mobile && npx jest src/hooks/useManualDeadMan.test.tsx && npx tsc --noEmit`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/hooks/useManualDeadMan.ts mobile/src/hooks/useManualDeadMan.test.tsx mobile/App.tsx
git commit -m "feat(deadman): app-wide manual dead-man hook (arm/refresh/stop/clear)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Settings toggle + TTL picker + i18n

**Files:** Modify `mobile/src/i18n/messages.ts`, `mobile/src/screens/SettingsScreen.tsx`

- [ ] **Step 1: i18n keys (en + zh, keep parity)**

In `messages.ts`, add to BOTH maps (near the other `settings.*`/`account.*` keys):

en:
```ts
    "deadMan.title": "Auto-cancel on app close",
    "deadMan.desc": "Cancel all your resting orders automatically if the app stays closed. Signed by your wallet — a safety net if you lose the app.",
    "deadMan.ttl": "Cancel after",
    "deadMan.ttlMinutes": "{n} min",
    "deadMan.on": "Auto-cancel enabled",
    "deadMan.off": "Auto-cancel disabled",
```

zh:
```ts
    "deadMan.title": "关闭 App 时自动撤单",
    "deadMan.desc": "App 保持关闭时自动撤销你所有挂单。由你的钱包签名——丢失 App 时的安全兜底。",
    "deadMan.ttl": "多久后撤单",
    "deadMan.ttlMinutes": "{n} 分钟",
    "deadMan.on": "已启用自动撤单",
    "deadMan.off": "已关闭自动撤单",
```

- [ ] **Step 2: Add the toggle + TTL picker to `SettingsScreen`**

Add imports:

```ts
import { useDeadManStore, DEADMAN_TTL_OPTIONS, type DeadManTtl } from "../state/deadManStore";
```

Read the store in the component:

```ts
  const deadManEnabled = useDeadManStore((s) => s.enabled);
  const deadManTtl = useDeadManStore((s) => s.ttlMinutes);
```

Extend the `Picker` union type (find `type Picker = …`) to include `"deadManTtl"`.

Add handlers:

```ts
  function onToggleDeadMan() {
    useDeadManStore.getState().setEnabled(!deadManEnabled);
    useToastStore.getState().show(t(!deadManEnabled ? "deadMan.on" : "deadMan.off"), "info");
  }
```

In the security/safety group of the JSX (near the biometric `SettingRow`), add the toggle row + a TTL row shown when enabled. Use the existing `SettingRow` + `Toggle` pattern:

```tsx
      <SettingRow
        theme={theme}
        icon="shield"
        name={t("deadMan.title")}
        right={<Toggle value={deadManEnabled} onValueChange={onToggleDeadMan} />}
      />
      {deadManEnabled ? (
        <SettingRow
          theme={theme}
          icon="clock"
          name={t("deadMan.ttl")}
          value={t("deadMan.ttlMinutes", { n: deadManTtl })}
          onPress={() => setPicker("deadManTtl")}
        />
      ) : null}
```

> Match the actual `SettingRow`/`Toggle` prop names in the file (e.g. the biometric row uses `value=…` + `onPress`; the notifications toggle shows the `Toggle` usage). If `SettingRow` has no `right` slot, follow the exact pattern the notifications toggle uses in this file.

Add a `SheetSelect` for the TTL (mirror the existing network/theme pickers):

```tsx
      {picker === "deadManTtl" ? (
        <SheetSelect
          title={t("deadMan.ttl")}
          options={DEADMAN_TTL_OPTIONS.map((m) => ({ value: String(m), label: t("deadMan.ttlMinutes", { n: m }) }))}
          selected={String(deadManTtl)}
          onSelect={(v) => { useDeadManStore.getState().setTtlMinutes(Number(v) as DeadManTtl); setPicker("none"); }}
          onClose={() => setPicker("none")}
        />
      ) : null}
```

> Match `SheetSelect`'s real prop names/shape from an existing usage in this file (options/selected/onSelect/onClose may differ — copy the existing network/theme picker exactly and swap the data).

- [ ] **Step 3: Verify Task 3**

Run: `cd mobile && npx tsc --noEmit && npx jest src/screens/SettingsScreen.test.tsx src/i18n/messages.test.ts`
Expected: tsc clean; SettingsScreen + i18n parity pass. (Add/adjust a SettingsScreen assertion only if the existing test enumerates rows.)

- [ ] **Step 4: Commit**

```bash
git add mobile/src/i18n/messages.ts mobile/src/screens/SettingsScreen.tsx
git commit -m "feat(deadman): settings toggle + TTL picker for the manual dead-man

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Finish — validate, PR, review, merge

- [ ] **Step 1: Full validation**

Run: `cd mobile && npx tsc --noEmit && npm test`
Expected: tsc clean; all suites pass (new deadMan store/budget/service/hook; i18n parity; no-hardcoded-colors guard; existing suites unaffected).

- [ ] **Step 2: Push**

```bash
git push -u origin feat/manual-deadman
```

- [ ] **Step 3: Open the PR** (`gh pr create`) summarizing: opt-in client-side dead-man for manual traders; arms scheduleCancel while foregrounded, fires on background/kill; TTL 1/2/5 min; ≤10/day budget; benign coexistence with the agentic dead-man.

- [ ] **Step 4:** Dispatch a background `code-review` agent on the branch diff AND `gh pr checks <n> --watch` in parallel.

- [ ] **Step 5:** Address any high-confidence findings; on clean review + green CI, squash-merge with `--delete-branch` and sync `main`.

---

## Self-review notes (coverage vs spec)

- **Opt-in store (enabled default OFF, TTL 1/2/5, persisted)** — Task 1a. ✔
- **≤10/day counting budget (refresh free, exhausted→skip, day reset)** — Task 1b. ✔
- **Local-wallet `scheduleCancel` (arm/clear, uncertain-honest)** — Task 1c. ✔
- **App-wide hook: arm while active+enabled, refresh (free), stop on background, clear on disable/wallet-change, fail-safe** — Task 2. ✔
- **Settings toggle + TTL picker + i18n en/zh** — Task 3. ✔
- **Benign agentic coexistence (last-write-wins, no cross-signaling)** — design-level; no code coupling. ✔
