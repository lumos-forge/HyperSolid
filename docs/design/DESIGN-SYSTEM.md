# HyperSolid — Design System (source of truth)

**This is the authoritative reference every new screen/component must follow.** It is kept in sync with the code tokens. When this doc and the code disagree, the code (`mobile/src/theme/*`) wins and this doc is wrong — fix it.

## 0. Hierarchy of truth

| Layer | Artifact | Role |
|---|---|---|
| **Pixel truth** | `docs/design/renders/build-v8.js` → `v8.png` | The canonical high-fidelity mockup. Layout, spacing, exact composition of every screen is matched 1:1 against this. |
| **Code truth (enforced)** | `mobile/src/theme/tokens.ts`, `fonts.ts`, `color.ts` | The design tokens actually rendered. Locked by `tokens.test.ts` / `fonts.test.ts` / `color.test.ts` and the no-hardcoded-color guard (`noHardcodedColors.test.ts`). |
| **Origin / rationale (v1, drifted)** | `docs/design/VISUAL-DIRECTION.md` | The original "Electrum Terminal" concept + palette/type rationale. **Historical**: its font names (Space Grotesk / Geist) and a few hex values predate the shipped system below. Read it for *why*, not for *what*. |

## 1. Color — tokens only, three themes

All hues live **only** in `mobile/src/theme/tokens.ts`. Components consume them via `useTheme()` → `ThemeTokens`; translucency via `withAlpha(token, a)` from `theme/color.ts`. **Never** write a hex literal in a component (enforced — see §5).

Token roles (`ThemeTokens`): `bg`, `surface`, `surfaceAlt`, `line`, `lineStrong`, `text`, `muted`, `faint`, `brand`, `glow`, `up`, `down`, `warn`.

Three themes (default `electrum`):

| role | electrum | daylight | oscilloscope |
|---|---|---|---|
| bg | `#0A1217` | `#EEF1F3` | `#0C0A07` |
| surface | `#0F1A20` | `#FFFFFF` | `#14110B` |
| brand | `#E8C98F` | `#0E5A6B` | `#FFB454` |
| up | `#37D69A` | `#1E7F5C` | `#6FE0C0` |
| down | `#FF6168` | `#C0492F` | `#FF7A6B` |
| warn | `#FFA53D` | `#C77A1E` | `#FF9233` |

**Rules**
- `brand` (Electrum silver-gold) is for agent signal + primary CTA + signature only.
- `up`/`down` are **semantic price/PnL direction only** — never in brand chrome (no "brand green = up green" confusion).
- `warn` (distinct from brand) is reserved for the asymmetric testnet caution.

## 2. Typography — three roles (numbers are the hero)

From `mobile/src/theme/fonts.ts`, consumed as `fonts.<role>.<weight>`:

- `fonts.mono.*` — **JetBrains Mono**, all numerals / tabular data (prices, order book, PnL).
- `fonts.display.*` — **Space Mono**, terminal voice: titles, eyebrows, tickers, CTAs.
- `fonts.body.*` — **Inter Tight**, sentences, settings, labels.

Never hardcode a `fontFamily` string — always reference `fonts`.

## 3. Iconography & glyphs

- Vector icons via the `Icon` component (`components/Icon.tsx`), tinted from theme tokens.
- Geometric status glyphs (`▲ ▼ ◷ · ×`) are allowed; **pictographic emoji are not**.

## 4. Layout & structure conventions

- **Every screen** renders through `ScreenScaffold` (top safe-area inset handled there) — do not re-implement headers/safe-area.
- Bottom tab bar is the only top-level nav (`RootNavigator`); Market Detail is a pushed stack screen.
- Order book columns are `PRICE / SIZE (BTC) / SUM`; perf periods `24H 7D 30D 90D 180D 1Y`; etc. — match `build-v8.js` exactly for v8 screens.

## 5. Enforced rules (machine-checked, not just review)

| Rule | Guard |
|---|---|
| No hardcoded color literals outside `theme/` | `mobile/src/theme/noHardcodedColors.test.ts` — fails CI on any `#rgb…` in `src/**` outside `theme/`. |
| Token values are valid hex, all roles present per theme | `tokens.test.ts` |
| Font family names stable | `fonts.test.ts` |
| **All user-facing strings i18n'd (en + zh parity)** | `i18n/messages.test.ts` — new copy goes in `messages.ts` (en+zh) and renders via `useT()`. Default locale `en`. |

## 6. Checklist for any new UI

1. Compose with `ScreenScaffold`; pull every color from `useTheme()` (no hex) and every font from `fonts`.
2. Use `up`/`down` only for price/PnL direction; `brand` only for CTA/agent/signature.
3. Wrap **all** visible copy in `useT()` keys added to `messages.ts` (en + zh).
4. Geometric glyphs only; icons via `Icon`.
5. For a v8 screen, diff against `docs/design/renders/build-v8.js` and match 1:1.
6. `npx tsc --noEmit` clean and `npx jest` green (the guards above run here).
