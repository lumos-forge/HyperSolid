# Strategy Templates — TWAP + TP/SL

Date: 2026-07-01
Status: Approved (brainstorming)
Depends on: `2026-06-23-strategy-automation-design.md`, `2026-06-23-strategy-backend-design.md`

## 1. Goal

Add two new strategy templates to the existing agent-automation engine:

- **TWAP** — split a target notional into N equal slices executed over a fixed
  window, in either direction (open/increase long via `buy`, open/increase short
  via `sell`). Minimises entry slippage on larger positions.
- **TP/SL** — monitor the owner's on-chain position on a coin and, when the mark
  price crosses a take-profit or stop-loss level, close the whole position with a
  reduce-only market order.

The current engine is DCA-only. Both templates are delivered in a single spec;
implementation order is **TWAP first, then TP/SL**. DCA must keep working
unchanged throughout.

Non-goals (YAGNI for this iteration): partial TP/SL close percentages, trailing
stops, multiple TP/SL ladders, Golang backend migration (the existing
TypeScript/Fastify engine is extended in place).

## 2. Decisions (locked)

| # | Decision |
|---|----------|
| D1 | Backend stays **TypeScript/Fastify** — extend the existing engine, no Golang rewrite this iteration. |
| D2 | Single spec covers both; implement **TWAP → TP/SL**. |
| D3 | Strategy model becomes a **discriminated union** (`kind`), shared store/scheduler/DTO. |
| D4 | TWAP supports **buy and sell** (build long or short). |
| D5 | TP/SL triggers a **full** reduce-only market close (no partial percentage). |

## 3. Strategy model (server)

```ts
type StrategyKind = "dca" | "twap" | "tpsl";
type StrategyStatus = "running" | "paused" | "completed"; // "completed" is new

interface DcaParams {                    // unchanged
  coin: string; side: "buy";
  quoteAmountUsdc: number; intervalHours: number; maxTotalUsdc?: number;
}
interface TwapParams {
  coin: string; side: "buy" | "sell";
  totalUsdc: number; slices: number; durationHours: number;
}
interface TpslParams {
  coin: string;
  takeProfitPrice?: number;              // at least one of tp/sl required
  stopLossPrice?: number;
}

interface Strategy {
  id: string; owner: string;
  kind: StrategyKind; status: StrategyStatus;
  params: DcaParams | TwapParams | TpslParams;
  createdAt: number;
  // progress (kind-specific, optional on the base type):
  nextRunAt?: number;        // dca, twap
  filledTotalUsdc?: number;  // dca, twap
  slicesDone?: number;       // twap
  triggeredAt?: number;      // tpsl
}
```

The store is generalised to hold the union: `create(owner, kind, params)`,
`get/list/listAll/setStatus/remove` unchanged, plus a twap-aware
`recordFill(id, quoteUsdc, nextRunAt)` that also increments `slicesDone` and flips
`status` to `completed` on the final slice, and a `recordTrigger(id, now)` for
tpsl.

`"completed"` strategies are skipped by the scheduler and shown as finished in the
app. They are never auto-deleted (audit trail); the user may delete them.

## 4. TWAP execution (shared scheduled path)

TWAP reuses the DCA scheduled-placement path:

- Derived on create: `nextRunAt = createdAt` (first slice fires immediately),
  `slicesDone = 0`, `filledTotalUsdc = 0`.
- `interval = durationHours / slices` (hours); `sliceUsdc = totalUsdc / slices`.
- **Due** when `status === "running" && nextRunAt <= now && slicesDone < slices`.
- Per-slice notional (`sliceUsdc`) gated by `withinCaps` + kill-switch (same as
  DCA). Daily-notional cap (if configured) also applies.
- On a confirmed fill: `slicesDone++`, `filledTotalUsdc += filledUsdc`,
  `nextRunAt = now + interval`; when `slicesDone === slices` → `status =
  "completed"`. An activity row is recorded per fill (existing sink).
- Placement uses the generalised placer with `side = params.side`,
  `reduceOnly = false`, `sizeUsdc = sliceUsdc`.

## 5. TP/SL execution (new trigger path)

A new branch in the scheduler tick evaluates running `tpsl` strategies:

- New resolver `resolvePosition(owner, coin): Promise<{ szi: number } | undefined>`
  backed by `InfoClient.clearinghouseState(owner)`. `szi > 0` long, `< 0` short,
  `size = |szi|`. No position (or `szi === 0`) → strategy is **idle** (skipped,
  stays `running`).
- Read mark via the existing `resolvePrice(coin)` (`info.allMids`).
- Trigger condition:
  - **long** (`szi > 0`): `tp && mark >= tp` OR `sl && mark <= sl`.
  - **short** (`szi < 0`): `tp && mark <= tp` OR `sl && mark >= sl`.
- On trigger → reduce-only IOC close via the generalised placer:
  `side = szi > 0 ? "sell" : "buy"`, `reduceOnly = true`, `sizeCoin = |szi|`, with a
  deterministic cloid via the existing `cloidFor(id, slot)` scheme (`slot` = a
  coarse close-attempt bucket) so a lost-response retry reuses the same cloid and
  dedupes at the HL kernel. On a confirmed fill → `status = "completed"`,
  `recordTrigger(id, now)`, activity row.
- Kill-switch blocks the close attempt (retries next tick once cleared). No
  notional cap is applied — a reduce-only close only reduces risk.

Trigger evaluation and DCA/TWAP placement run in the same tick pass so a single
scheduler drives all kinds.

## 6. Placer generalization

`PlaceRequest` gains fields (all existing DCA callers pass buy/notional):

```ts
interface PlaceRequest {
  owner: string; coin: string; cloid: string;
  side: "buy" | "sell";        // NEW (dca/twap-buy = "buy")
  reduceOnly: boolean;         // NEW (dca/twap = false, tpsl = true)
  sizeUsdc?: number;           // notional sizing (dca, twap)
  sizeCoin?: number;           // direct coin sizing (tpsl close)
}
```

- `b = side === "buy"`, `r = reduceOnly`.
- Size: `sizeCoin` used directly when present, else `sizeUsdc / price`, rounded to
  `szDecimals`.
- Aggressive limit in the trade direction: buy → `price * (1 + slipBps)`, sell →
  `price * (1 - slipBps)`.
- Unchanged: deterministic cloid, fail-closed (`{ ok:false }` on no client / no
  price / non-fill / throw) so the scheduler does not advance.

## 7. HTTP contract (backward compatible)

- `POST /strategies` body `{ type: StrategyKind, params }` — dca callers unchanged;
  server validates the kind and params (unknown kind / missing required fields /
  tpsl with neither tp nor sl → `400`).
- `GET /strategies` returns the DTO union: `{ id, type, status, params, ...progress }`
  where progress is the kind-specific subset (dca/twap: `filledTotalUsdc`,
  `nextRunAt`; twap adds `slicesDone`; tpsl: `triggeredAt`).
- `PATCH /strategies/:id` (status), `DELETE /strategies/:id`, `POST /kill-switch`,
  `GET /strategies/:id/activity` stay generic and unchanged.

## 8. Mobile

- `services/strategyApi.ts`: add `StrategyType`, `TwapParams`, `TpslParams`; widen
  `Strategy` to the union; `createStrategy(type, params)` (keep `createDca` thin
  wrapper for compatibility, or fold into the generic method).
- `hooks/useStrategyController.ts`: add `createTwap(params)` and `createTpsl(params)`.
- `screens/AgentScreen.tsx`: a segmented **template picker** (DCA / TWAP / TP-SL)
  above the form; each selection renders its own field set:
  - DCA: coin, amount/buy, interval (existing).
  - TWAP: coin, side (buy/sell toggle), total USDC, slices, duration (h).
  - TP/SL: coin, take-profit price, stop-loss price (≥1 required, inline validation).
  - Strategy rows render per kind — twap shows `slicesDone/slices` + filled; tpsl
    shows tp/sl levels + status (running/idle/completed).
- i18n: new keys added to both `en` and `zh` in `i18n/messages.ts` (parity enforced
  by `messages.test.ts`), rendered via `useT()`. No hardcoded hex, no emoji.

## 9. Testing (TDD)

**Server**
- twap: due/slice math, `slicesDone` advance, completion at final slice, cap gating.
- tpsl: trigger matrix — long/short × {tp only, sl only, both} × {cross, no-cross,
  idle/no-position}; reduce-only close direction + size.
- placer: `side` (b flag) + `reduceOnly` (r flag) + `sizeCoin` vs `sizeUsdc`,
  aggressive limit direction.
- store: union create/list/setStatus/recordFill(twap complete)/recordTrigger.
- http: create/list per kind, DTO progress shape, validation (400) cases.

**Mobile**
- strategyApi: encode per type; controller create methods call the right endpoint.
- AgentScreen: picker switches forms; each form submits valid params; rows render
  per kind; tpsl inline validation (≥1 price).

**Gates (per unit, before commit)**
- Server: `cd server && npx tsc --noEmit && npx jest`.
- Mobile: `cd mobile && npx tsc --noEmit && npx jest` (≥ baseline) `+
  npx jest noHardcodedColors` + emoji grep.

## 10. Risks & mitigations

- **Position query cost/latency (tpsl):** `clearinghouseState` per tpsl per tick.
  Mitigate by evaluating only when tpsl strategies exist and caching per-owner
  position within a tick.
- **Reduce-only close partial fill:** IOC may partially fill; strategy stays
  `running` until a tick observes the position flat, then marks `completed`
  (idempotent — re-close of a smaller residual is safe, still reduce-only).
- **DCA regression:** model generalization touches shared store/scheduler/DTO;
  existing DCA tests are the regression guard and must stay green.
