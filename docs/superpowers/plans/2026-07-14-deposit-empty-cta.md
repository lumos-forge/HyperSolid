# Zero-Balance Deposit CTA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last of gap C2's discoverability: a one-tap path from Trade to a *ready-to-fund* Account, plus a prominent zero-balance CTA on Trade. Reuses the existing deposit sheet + AccountScreen `fund-nudge` — no rebuild.

**Architecture:** A tiny reactive `depositIntentStore` flag. The existing Trade "deposit shortcut" and a new Trade zero-balance CTA set the flag and navigate to Account; AccountScreen (kept mounted) reacts to the flag and opens the deposit sheet — turning the current 2-tap (shortcut → Account → tap Deposit) into one tap.

**Tech Stack:** React Native (Expo), zustand, `@react-navigation` bottom tabs, Jest.

**Spec:** `docs/superpowers/specs/2026-07-14-deposit-empty-cta-design.md`

---

## What already exists (do NOT rebuild)

- **Deposit sheet** (AccountScreen): native-USDC/USDC.e + Arbitrum One + 5-USDC-min + gas warnings, QR, copy address, mainnet confirm. Opened via `setSheet("deposit")` / `onDeposit()`.
- **AccountScreen zero-balance nudge** (`testID="fund-nudge"`): shown when `mode==="local" && summary.accountValue <= 0`, opens the deposit sheet. **Leave as-is.**
- **Trade deposit shortcut** (`testID="deposit-shortcut"`): a small "+" next to the available balance that `navigation.navigate("Account")`. **We'll make it also request the intent.**
- **TradeScreen** already has `navigation?: { navigate }`; `available` = withdrawable via `useAvailableBalance` (null while loading).

## Remaining gap (this PR)

1. Trade → Account lands on the tab but **doesn't open the deposit sheet** (needs a 2nd tap).
2. On Trade, a **zero-balance** user only sees a subtle "+", not a clear "no USDC — deposit to start" CTA.

**Files:**
- Create: `mobile/src/state/depositIntentStore.ts` (+ test)
- Modify: `mobile/src/screens/AccountScreen.tsx` (+ `AccountScreen.test.tsx`) — react to the intent → open sheet
- Modify: `mobile/src/screens/TradeScreen.tsx` (+ `TradeScreen.test.tsx`) — shortcut sets intent + a zero-balance CTA
- Modify: `mobile/src/i18n/messages.ts`

---

## Task 1: `depositIntentStore`

**Files:** Create `mobile/src/state/depositIntentStore.ts`, `mobile/src/state/depositIntentStore.test.ts`

- [ ] **Step 1: Create the store**

```ts
import { create } from "zustand";

/**
 * One-shot cross-tab signal to open the Account deposit sheet. A Trade-tab CTA calls `request()` then
 * navigates to Account; AccountScreen subscribes to `requested` and opens the deposit sheet, then
 * `consume()` clears it (so it fires at most once per request). Reactive (not focus-based) so it works
 * whether or not the Account tab was previously mounted, and is trivially testable.
 */
interface DepositIntentState {
  requested: boolean;
  request: () => void;
  consume: () => boolean;
}

export const useDepositIntentStore = create<DepositIntentState>((set, get) => ({
  requested: false,
  request: () => set({ requested: true }),
  consume: () => {
    const was = get().requested;
    if (was) set({ requested: false });
    return was;
  },
}));
```

- [ ] **Step 2: Test** (`depositIntentStore.test.ts`)

```ts
import { useDepositIntentStore } from "./depositIntentStore";

describe("depositIntentStore", () => {
  beforeEach(() => useDepositIntentStore.setState({ requested: false }));

  it("request sets the flag; consume returns it once then clears", () => {
    expect(useDepositIntentStore.getState().requested).toBe(false);
    useDepositIntentStore.getState().request();
    expect(useDepositIntentStore.getState().requested).toBe(true);
    expect(useDepositIntentStore.getState().consume()).toBe(true);
    expect(useDepositIntentStore.getState().requested).toBe(false);
    expect(useDepositIntentStore.getState().consume()).toBe(false);
  });
});
```

- [ ] **Step 3: Verify + commit**

Run: `cd mobile && npx jest src/state/depositIntentStore.test.ts && npx tsc --noEmit`

```bash
git add mobile/src/state/depositIntentStore.ts mobile/src/state/depositIntentStore.test.ts
git commit -m "feat(deposit): one-shot cross-tab deposit-intent store

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: AccountScreen reacts to the intent → opens the deposit sheet

**Files:** Modify `mobile/src/screens/AccountScreen.tsx`, `mobile/src/screens/AccountScreen.test.tsx`

- [ ] **Step 1: Add the reactive open**

Add the import near the other state imports:

```ts
import { useDepositIntentStore } from "../state/depositIntentStore";
```

Read the flag with the other store hooks (near `const address = useWalletStore(...)`):

```ts
  const depositRequested = useDepositIntentStore((s) => s.requested);
```

Add an effect that opens the deposit sheet when a request arrives (place after the `reloadSummary`
effect). It only opens for a local wallet and consumes the flag so it fires once:

```ts
  useEffect(() => {
    if (depositRequested && mode === "local") {
      setSheet("deposit");
      useDepositIntentStore.getState().consume();
    }
  }, [depositRequested, mode]);
```

- [ ] **Step 2: Test** — add to `AccountScreen.test.tsx` (reuse its `fakeDeps`/render harness; a
  zero-balance local summary is already set up in the fund-nudge test — mirror it):

```ts
import { useDepositIntentStore } from "../state/depositIntentStore";

it("opens the deposit sheet when a deposit intent is pending", async () => {
  useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
  useDepositIntentStore.getState().request();
  render(<AccountScreen deps={fakeDeps} navigation={{ navigate }} />);
  await waitFor(() => expect(screen.getByTestId("deposit-panel")).toBeTruthy());
  expect(useDepositIntentStore.getState().requested).toBe(false); // consumed
});
```

> Match the file's existing wallet-setup helper (`localWallet` / `useWalletStore.setState`) — copy the fund-nudge test's setup. Reset the intent store in a `beforeEach` if the file resets other stores.

- [ ] **Step 3: Verify + commit**

Run: `cd mobile && npx jest src/screens/AccountScreen.test.tsx && npx tsc --noEmit`

```bash
git add mobile/src/screens/AccountScreen.tsx mobile/src/screens/AccountScreen.test.tsx
git commit -m "feat(deposit): AccountScreen opens the deposit sheet on a pending intent

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: TradeScreen — shortcut sets intent + a zero-balance CTA

**Files:** Modify `mobile/src/screens/TradeScreen.tsx`, `mobile/src/screens/TradeScreen.test.tsx`, `mobile/src/i18n/messages.ts`

- [ ] **Step 1: i18n keys (en + zh, keep parity)**

In `messages.ts`, add to BOTH maps near the other `trade.*` keys:

en:
```ts
    "trade.noFunds": "No USDC yet",
    "trade.noFundsCta": "Deposit to start trading",
```
zh:
```ts
    "trade.noFunds": "还没有 USDC",
    "trade.noFundsCta": "充值开始交易",
```

- [ ] **Step 2: Add the import + a helper in TradeScreen**

```ts
import { useDepositIntentStore } from "../state/depositIntentStore";
```

Add a small handler in the component (near `onSubmit`):

```ts
  function goDeposit() {
    useDepositIntentStore.getState().request();
    navigation?.navigate("Account");
  }
```

- [ ] **Step 3: Make the existing deposit shortcut one-tap**

Change the `deposit-shortcut` Pressable's `onPress={() => navigation?.navigate("Account")}` to:

```tsx
            onPress={goDeposit}
```

- [ ] **Step 4: Add the prominent zero-balance CTA**

Where the order form renders for a connected local wallet (near the submit button / available row), add a
CTA shown only when the balance is loaded and zero:

```tsx
        {mode === "local" && available === 0 ? (
          <Pressable
            accessibilityRole="button"
            testID="trade-no-funds-cta"
            onPress={goDeposit}
            style={[styles.noFundsCta, { borderColor: theme.brand, backgroundColor: withAlpha(theme.brand, 0.08) }]}
          >
            <Icon name="plus" color={theme.brand} size={15} />
            <Text style={[styles.noFundsCtaText, { color: theme.text }]}>{t("trade.noFundsCta")}</Text>
            <Icon name="chevronRight" color={theme.brand} size={15} strokeWidth={2} />
          </Pressable>
        ) : null}
```

Add the styles (mirror AccountScreen's `fundNudge` — a bordered pill row):

```ts
  noFundsCta: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12, marginTop: 12 },
  noFundsCtaText: { flex: 1, fontSize: 14, fontWeight: "600" },
```

> Confirm `withAlpha` + `Icon` are already imported in TradeScreen (they are used elsewhere); if `chevronRight`/`plus` icon names differ, use the names TradeScreen/AccountScreen already use (`plus` is used by `deposit-shortcut`; `chevronRight` is used by AccountScreen's fund-nudge).

- [ ] **Step 5: Test** — add to `TradeScreen.test.tsx` (reuse its render + local-wallet setup; the file already mocks `navigation`/stores):

```ts
import { useDepositIntentStore } from "../state/depositIntentStore";

it("the deposit shortcut requests a deposit intent and navigates to Account", () => {
  useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
  useDepositIntentStore.setState({ requested: false });
  render(<TradeScreen navigation={{ navigate }} />);
  fireEvent.press(screen.getByTestId("deposit-shortcut"));
  expect(useDepositIntentStore.getState().requested).toBe(true);
  expect(navigate).toHaveBeenCalledWith("Account");
});
```

> If a `available === 0` state is easy to drive in the harness (mock `useAvailableBalance` / the positions service to return 0), also assert `trade-no-funds-cta` renders and fires `goDeposit`. If the harness can't easily force a zero balance, cover the CTA via the shortcut test above (same `goDeposit`) and skip a dedicated zero-balance render assertion. Match `navigate`/`localWallet` to the file's existing setup.

- [ ] **Step 6: Verify + commit**

Run: `cd mobile && npx tsc --noEmit && npx jest src/screens/TradeScreen.test.tsx src/i18n/messages.test.ts`

```bash
git add mobile/src/screens/TradeScreen.tsx mobile/src/screens/TradeScreen.test.tsx mobile/src/i18n/messages.ts
git commit -m "feat(deposit): Trade deposit shortcut + zero-balance CTA open the deposit sheet

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Finish — validate, PR, review, merge

- [ ] **Step 1: Full validation** — `cd mobile && npx tsc --noEmit && npm test` (all green; i18n parity + no-hardcoded-colors pass).
- [ ] **Step 2: Push** — `git push -u origin feat/deposit-empty-cta`.
- [ ] **Step 3: PR** (`gh pr create`) — summarize: one-tap deposit intent (Trade → Account opens the deposit sheet) + a prominent Trade zero-balance CTA; reuses the existing deposit sheet + AccountScreen nudge.
- [ ] **Step 4:** Background `code-review` on the diff + `gh pr checks <n> --watch` in parallel.
- [ ] **Step 5:** Address high-confidence findings; on clean review + green CI, squash-merge `--delete-branch` and sync `main`.

---

## Self-review notes (coverage vs spec)

- **One-tap cross-tab open (intent store, reactive, consume-once)** — Task 1 + Task 2. ✔
- **Trade zero-balance CTA + shortcut both open the deposit sheet** — Task 3. ✔
- **Reuses the existing deposit sheet + AccountScreen fund-nudge (no rebuild)** — noted; AccountScreen nudge untouched. ✔
- **Local-only, loaded-balance guarded** — Task 2 (`mode==="local"`) + Task 3 (`available === 0`, null=loading). ✔
- **i18n en/zh + theme tokens** — Task 3 Step 1/4. ✔

> Scope note vs the spec: AccountScreen's prominent zero-balance CTA already exists (`fund-nudge`), and Trade already had a `deposit-shortcut`; this plan therefore reuses them and focuses on the genuinely-missing one-tap intent + a prominent Trade zero-balance CTA, rather than building a redundant `DepositCta` component.
