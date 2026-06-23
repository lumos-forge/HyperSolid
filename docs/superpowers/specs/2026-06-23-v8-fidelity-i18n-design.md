# v8 1:1 Fidelity + i18n — Design

> **Status:** Design (recorded autonomously per the user's explicit direction: "严格 1:1 还原 v8.png
> (订单簿改英文、补满 8 周期/8 指标、加 Trade 按钮)，中英文统一，可切换多语言"). User to review async.
> Reference design: `docs/design/renders/v8.png` (the canonical target). Decomposed into 3 sub-projects;
> each gets its own plan + continuous-agent-loop execution.

## Goal

Bring the mobile app to a strict 1:1 match with `v8.png`, and unify all user-facing copy behind a
zh/en internationalization layer with an in-app language switch.

## Why decomposed

Three independent subsystems, built in order so later ones reuse the earlier:

- **SP1 — i18n foundation** (this spec details it). Infra + switcher + migrate the first string batch.
- **SP2 — Market Detail 1:1 v8.png.** Heaviest screen: 3-col order book, 8 timeframes (real candle
  intervals), 8 indicators (new math), L/S imbalance readout, Trade button, `BTC-USDC PERP` header.
- **SP3 — other screens 1:1 v8.png.** Markets, Trade, Positions, Strategy, Wallet — aligned to `v8.png`,
  all copy via SP1 keys.

## SP1 — i18n foundation (design of record)

### Decisions

- **No new dependency.** Homegrown, lightweight, fully testable — matches the codebase's zustand +
  theme-token conventions. (Avoids `i18next`/`expo-localization` weight; device-locale detection is a
  trivial later add.)
- **Two locales:** `en`, `zh`. **Default `en`** (the v8.png copy is English; "unify" → one default).
- **In-memory store** (mirrors `themeStore`/`envStore`, which are not persisted). Persistence across
  restarts is a trivial follow-up, intentionally deferred (YAGNI) to match existing conventions.
- **Guarded core untouched.** `src/lib/hyperliquid/order.ts` holds Chinese order-rejection messages but
  is part of the Phase-3 encoding core (do-not-edit). The UI translates rejections **by code**
  (`tickRejected`, `sizeRejected`, …) through i18n keys; `order.ts` is not modified.

### File structure

- `src/i18n/messages.ts` *(new)* — `type Locale = "en" | "zh"`; `type TranslationKey` (union of keys);
  `const messages: Record<Locale, Record<TranslationKey, string>>`. Flat keys, dot-namespaced
  (e.g. `orderbook.price`, `common.cancel`, `reject.tickRejected`).
- `src/state/localeStore.ts` *(new)* — zustand `{ locale, setLocale, toggleLocale }`, default `"en"`.
- `src/i18n/useT.ts` *(new)* — `useT()` → `t(key, params?)`; reads `localeStore`, looks up
  `messages[locale][key]`, interpolates `{var}` placeholders, falls back to the key if missing.
- `src/components/OrderbookView.tsx` — replace `价格/数量/价差` with `t("orderbook.price")` /
  `t("orderbook.size")` / `t("orderbook.spread", { spread, pct })`.
- `src/screens/AccountScreen.tsx` — add a **Language / 语言** settings row mirroring the theme `cycle*`
  pattern (`LOCALE_LABEL` + `cycleLocale`), showing `English` / `中文`.

### First string batch (migrate in SP1)

Shared/high-visibility copy only; screen-specific copy migrates as SP2/SP3 rework each screen:
`orderbook.{price,size,sum,spread}`, `common.{cancel,confirm,buy,sell,deposit,withdraw}`,
`reject.{tickRejected,sizeRejected,priceRejected,minTradeNtlRejected,…}` (by code), and the
`Language`/`English`/`中文` switcher labels.

### Interface examples

```ts
// useT.ts
const t = useT();
t("orderbook.price");                 // "PRICE" | "价格"
t("orderbook.spread", { spread: "1.00", pct: "0.002" }); // "Spread 1.00 (0.002%)"
```

### Testing

- `messages.test.ts`: `en` and `zh` have identical key sets (no missing translations); every
  `TranslationKey` resolves in both.
- `useT.test.tsx`: returns the en string by default; returns zh after `setLocale("zh")`; interpolates
  `{var}`; falls back to the key when unknown.
- `localeStore.test.ts`: default `en`; `toggleLocale` flips en↔zh.
- `OrderbookView` renders `t()` values; AccountScreen language row cycles locale (RTL test).

### Out of scope (SP1)

Full app-wide string extraction (incremental, per screen, in SP2/SP3); persistence; device-locale
auto-detect; RTL languages.

## Self-review

- Placeholders: none. Internal consistency: SP1 keys feed SP2/SP3. Scope: SP1 is a single focused plan;
  SP2/SP3 are separate. Ambiguity: default locale fixed to `en`; rejection copy translated by code
  (order.ts untouched) — both made explicit.
