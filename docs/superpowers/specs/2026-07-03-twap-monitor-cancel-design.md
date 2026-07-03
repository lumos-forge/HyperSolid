# TWAP Monitoring + Cancel

Date: 2026-07-03
Status: Approved (brainstorming)
Depends on: existing Trade-ticket TWAP (`placeTwap` → native HL `twapOrder`), Positions screen (`positions`/`fills`/`orders` polling tabs + on-demand signing `ExchangeService`)

## 1. Goal

The app can already **place** a native Hyperliquid TWAP order (Trade ticket →
`ExchangeService.placeTwap` → `twapOrder`), but then fires-and-forgets: there is
no way to see a running TWAP's progress or to cancel it. This adds:

1. **Active TWAP monitoring** — a new **TWAP** segment tab on the Positions
   screen listing the user's currently-running TWAPs with progress, polled from
   `InfoClient.twapHistory` (filtered to `activated`), consistent with the
   existing positions/orders/fills tabs.
2. **Cancel** — a per-row Cancel action that signs an HL `twapCancel` via the
   on-demand `ExchangeService` the Positions screen already builds.

This is a mobile-only change (no server changes).

### Non-goals (YAGNI)
- Historical / finished TWAP list, per-slice fill detail (`userTwapSliceFills`).
- WebSocket live updates (`twapStates`) — we poll, matching the other tabs.
- Editing a running TWAP (HL has no modify; only place/cancel).
- Push notifications on TWAP completion.

## 2. Decisions (from brainstorming)

- **UI home:** a new `"twap"` segment tab on the Positions screen (consistent with
  positions/orders/fills; it already polls Info clients and builds an on-demand
  signing `ExchangeService` for close/cancel).
- **Data channel:** poll `InfoClient.twapHistory({ user })` and filter to
  `status.status === "activated"` — same polling/refresh model as the other tabs
  (chosen over a WS `twapStates` subscription for consistency and simplicity).

## 3. Data model

Hyperliquid `twapHistory` returns
`{ time, state: TwapState, status: { status: "finished"|"activated"|"terminated" } | { status: "error", description }, twapId? }[]`.
The `TwapState` carries `{ coin, side: "B"|"A", sz, executedSz, executedNtl, minutes, randomize, reduceOnly, timestamp, user, ... }`.

Normalized app row:
```ts
export interface ActiveTwap {
  twapId: number;
  coin: string;
  side: "buy" | "sell";
  sz: number;          // total base size
  executedSz: number;  // base size filled so far
  executedNtl: number; // USDC notional filled so far
  minutes: number;     // configured duration
  reduceOnly: boolean;
  startedAt: number;    // ms epoch (from state.timestamp)
}
```

## 4. Architecture

### 4.1 `lib/hyperliquid/twap.ts` *(new, pure)*
- `normalizeActiveTwaps(history): ActiveTwap[]` — keep only entries whose
  `status.status === "activated"` AND that have a numeric `twapId` (an entry
  without a `twapId` cannot be cancelled and is dropped); map `side "B"→"buy" /
  "A"→"sell"`; `Number(...)` the string fields; `startedAt = state.timestamp`.
- `twapProgressPct(t: ActiveTwap): number` — `sz > 0 ? clamp(executedSz / sz * 100, 0, 100) : 0`.
  (Pure helper for the row + easy to test.)

### 4.2 `services/twapData.ts` *(new)*
- `TwapService` wrapping a minimal injectable Info surface:
  ```ts
  interface TwapInfoLike { twapHistory(args: { user: string }): Promise<unknown> }
  ```
- `listActive(user: string): Promise<ActiveTwap[]>` — call `twapHistory({ user })`,
  pass the result through `normalizeActiveTwaps`. Mirrors `OrdersService`/`FillsService`.

### 4.3 `lib/hyperliquid/client.ts`
- Add `createTwapInfoClient(network)` mirroring `createOrdersInfoClient` (same
  transport; exposes `twapHistory`).

### 4.4 `services/exchange.ts`
- Extend the `ExchangeClient` interface with `twapCancel(params): Promise<unknown>`.
- New method `cancelTwap(coin: string, twapId: number): Promise<SubmitResult>`:
  resolve `assetIndex` from `this.index` (the asset-index map already held by
  `ExchangeService`); if the coin is unknown/no index → return a safe failure
  (do not sign); else `await this.client.twapCancel({ a: assetIndex, t: twapId })`
  and normalize to `SubmitResult` with the same honest-receipt handling as
  `placeTwap`/`cancelOrder` (a thrown error → `{ ok: false, uncertain: true }`;
  never assume success).

### 4.5 `screens/PositionsScreen.tsx`
- Add `"twap"` to the `Tab` union and a segment button (`positions.tabTwap`).
- Add `TwapService` to `PositionsScreenDeps` (default
  `new TwapService(createTwapInfoClient(network))`).
- State: `activeTwaps: ActiveTwap[]`, `twapError: FetchErrorCode | null`; load in
  the same query cycle as fills/orders (guarded, per-tab error like the others),
  keyed by the connected wallet address.
- Render (when `tab === "twap"`): a list of TWAP rows. Each row (testID
  `twap-<twapId>`): `{coin} · {buy|sell}` (buy=`theme.up`, sell=`theme.down`),
  a progress line `{executedSz}/{sz} · {pct}% · ${executedNtl} · {minutes}m`
  (+ a reduce-only marker when set), and a **Cancel** button (testID
  `twap-cancel-<twapId>`).
- Cancel flow: reuse the existing `buildSvc()` (on-demand signing `ExchangeService`).
  Show a confirm `Alert` (`common.cancel` + a confirm action); on confirm call
  `svc.cancelTwap(coin, twapId)`; on `ok` show a success toast and re-run the
  query; on failure surface the honest error (uncertain → the uncertain-receipt
  copy). When `buildSvc()` is null (view-only / non-local wallet), the Cancel
  button is disabled.
- Empty state: `positions.noTwaps` when there are no active TWAPs.
- Colors from theme tokens only; all strings via `useT()`; no emoji.

### 4.6 i18n (`i18n/messages.ts`, en + zh)
New keys (illustrative): `positions.tabTwap`, `positions.noTwaps`,
`positions.twapCancelTitle`, `positions.twapCancelConfirm`,
`positions.twapCancelled`, `positions.twapProgress` (a `{done}/{total} · {pct}% · ${ntl} · {minutes}m`
style string), `positions.reduceOnly`. Reuse existing `common.cancel`,
`positions.buy`/`sell` (or `agent.buy`/`sell` — match whatever the Positions rows
already use). Parity enforced by `messages.test`.

## 5. Edge cases
- **`twapHistory` returns finished/terminated/error entries:** filtered out; only
  `activated` with a `twapId` shown.
- **Cancel on an already-finished TWAP:** HL rejects; the honest receipt surfaces
  the failure and the next refresh drops the row.
- **Uncertain cancel receipt (thrown/network):** reported as uncertain (never
  assumed cancelled); the row stays until a refresh confirms it's gone.
- **View-only / no signing wallet:** Cancel disabled (no `buildSvc`).
- **Unknown coin / missing asset index:** `cancelTwap` fails safe without signing.

## 6. Testing (TDD)
- `twap.ts`: `normalizeActiveTwaps` keeps only `activated` + numeric `twapId`,
  maps side/fields, drops entries with no `twapId`; `twapProgressPct` math + clamp.
- `TwapService.listActive`: injected fake `twapHistory` → asserts it's called with
  `{ user }` and returns normalized `ActiveTwap[]`.
- `exchange.cancelTwap`: injected fake client → asserts `twapCancel` called with
  `{ a: <index>, t: <twapId> }`; a thrown client error → `{ ok:false, uncertain:true }`;
  unknown coin → safe failure without calling `twapCancel`.
- `PositionsScreen`: switching to the TWAP tab renders active rows; pressing Cancel
  fires the confirm and (on confirm) calls `cancelTwap`; view-only disables Cancel.
- **Gates:** `cd mobile && npx tsc --noEmit && npx jest` (≥ baseline)
  `&& npx jest noHardcodedColors && npx jest messages`; emoji scan → none.

## 7. Rejected alternatives
- **WS `twapStates` subscription:** more real-time but adds a subscription
  lifecycle inconsistent with the other polled Positions tabs; rejected for now.
- **Trade-screen TWAP area / standalone screen:** the Positions screen is the
  established home for managing open activity (positions/orders/fills) with signing
  already wired; rejected in favor of a 4th Positions tab.
- **Local twapId tracking (from `placeTwap`'s response):** would miss TWAPs placed
  elsewhere and can't observe completion; server (HL) is the source of truth.
