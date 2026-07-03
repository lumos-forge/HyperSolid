# Phase 0 Wrap-up: Geo-block Gating + Sentry

Date: 2026-07-03
Status: Approved (brainstorming)
Depends on: `2026-06-17-hypersolid-design.md` (§9 compliance), `docs/HYPERLIQUID-GAP-ANALYSIS.md` (gap D), existing `mobile/src/lib/compliance/geoBlock.ts` + `mobile/src/lib/observability/breadcrumb.ts`

## 1. Goal

Close two Phase 0 (scaffolding / production-readiness) gaps that are already
stubbed but not wired:

1. **Geo-block gating** — the app must refuse to operate for users in
   Hyperliquid/Apple-restricted jurisdictions. The pure predicate
   (`isRestricted` / `restrictionReason` / `RESTRICTED_COUNTRIES`) already exists
   and is tested, but there is **no geo data source and no gate** in the app.
2. **Sentry** — crash/error observability. An injectable `breadcrumb` seam already
   exists (a no-op by default), explicitly designed to be wired to
   `Sentry.addBreadcrumb` in the native build. Sentry is **not yet a dependency**
   and nothing initializes it.

These are two independent units that share one spec; they can be built and tested
separately (Unit 1 is pure config + navigation gating with zero native deps; Unit
2 is a native-build integration). Neither blocks the other.

### Non-goals (YAGNI)
- The full backend Go rewrite / signing core (separate track, separate spec).
- Bundling a GeoIP database in the server (we trust a proxy/CDN geo header).
- Region-level gating beyond the single documented case (CA-ON); country-level is
  primary, region is best-effort from a header.
- Sentry performance tracing / session replay / release health dashboards — only
  crash + unhandled-error + breadcrumb reporting for now.
- Making Sentry work inside Expo Go (it requires a native EAS build; it is a no-op
  in Expo Go / dev / tests).

## 2. Decisions (from brainstorming)

- **Geo source:** server-delivered via the existing public `GET /app-config`; the
  server derives `country`/`region` from the request IP (via a fronting
  proxy/CDN geo header). Chosen over a client-side IP service or device locale
  because the server sees the real IP (harder to spoof) and it reuses the launch
  fetch.
- **Unknown geo → fail-open:** block only when the server explicitly returns a
  restricted country/region; if geo is missing/unavailable, allow the app. Avoids
  false-blocking global users on a geo/network outage; consistent with the
  existing data-layer fail-open and the TestFlight stage (ADR-014; the hard
  compliance gate ADR-006 is deferred).
- **Confirmed-restricted → full-screen hard block** at the root navigator (no tab
  access), matching the "unavailable in your jurisdiction" copy and Apple's perps
  concern.
- **Sentry DSN → build-time** via EAS env / `app.json`/`app.config` `extra`
  (read through `expo-constants`). Chosen over server-delivered so Sentry can
  `init` at cold start and capture startup crashes; the DSN is a public ingestion
  endpoint, not a secret, so this does not violate the "secrets are
  server-delivered" convention.

## 3. Unit 1 — Geo-block gating

### 3.1 Server (`server/`)
- **`config/appConfig.ts`:** extend `AppConfigPayload` with an optional
  `geo?: { country?: string; region?: string }`.
- **`http/app.ts` — `GET /app-config`:** change the handler from `async () => appConfig`
  to `async (req) => ({ ...appConfig, ...(geo ? { geo } : {}) })` where
  `geo = resolveGeo(req, geoHeaders)`.
- **New `http/geo.ts` — `resolveGeo(req, cfg)`:** read the country from a
  configurable request header (default `cf-ipcountry`; production typically sits
  behind Cloudflare/Fly), and the region from a configurable header if present
  (default `cf-region` / `x-geo-region`). Uppercase + trim; treat empty/`"XX"`/`"T1"`
  (Cloudflare's Tor/unknown sentinels) as absent. Returns
  `{ country?, region? } | undefined` (undefined when no usable header). No GeoIP
  DB dependency.
- **Config:** the header names come from env (e.g. `GEO_COUNTRY_HEADER`,
  `GEO_REGION_HEADER`) with the defaults above, surfaced through the existing
  `appConfigFromEnv(process.env)` seam.
- **DTO note:** `/app-config` is public (no auth) and already fetched at launch;
  adding `geo` is backward-compatible (older clients ignore it).

### 3.2 Mobile (`mobile/`)
- **`state/runtimeConfigStore.ts`:** add `geo: { country?: string; region?: string } | null`
  to `AppRuntimeConfig` (default `null`); `setConfig` populates it.
- **`services/appConfig.ts`:** `RawAppConfig` gains `geo?`; `loadAppConfig` maps it
  into the store shape (missing → `null`).
- **`lib/compliance/geoBlock.ts`:** keep `isRestricted(ctx)` and
  `RESTRICTED_COUNTRIES` as the source of truth. The UI reason string moves to
  i18n (see below); `restrictionReason` may remain as a non-UI/log helper but the
  screen renders localized copy via `useT()`, not the hardcoded Chinese string.
- **New `screens/GeoBlockScreen.tsx`:** a full-screen, theme-tokened, i18n screen
  (title `geo.blockedTitle`, body `geo.blockedBody`) shown when restricted. No
  navigation into tabs. No emoji, no hardcoded hex.
- **`navigation/RootNavigator.tsx`:** read `geo` from the runtime config store; if
  `geo && isRestricted(geo)` render `GeoBlockScreen` in place of the tab
  navigator; otherwise render the tabs as today. `geo === null`/unknown →
  fail-open (render tabs).
- **i18n:** add `geo.blockedTitle`, `geo.blockedBody` to en + zh (parity enforced).

### 3.3 Behavior / edge cases
- **Cold start before `/app-config` returns:** `geo` is `null` → fail-open (tabs
  shown). If the config later resolves to a restricted region, the root re-renders
  into `GeoBlockScreen` (reactive to the store). Brief pre-config access is
  inherent to fail-open and accepted for the TestFlight stage.
- **`/app-config` unreachable:** `hydrateRuntimeConfig` already swallows errors and
  leaves config empty → `geo` stays `null` → fail-open.
- **Country present but region absent:** country-level gating still applies
  (CA-ON needs the region header; without it, CA is not blocked, matching the
  existing predicate).

## 4. Unit 2 — Sentry

### 4.1 Integration
- Add `@sentry/react-native` via its Expo config plugin in `app.json`/`app.config`.
  **Before writing code, follow the exact Expo SDK 56 docs**
  (https://docs.expo.dev/versions/v56.0.0/) for the correct plugin + init API and
  version pinning.
- **`Sentry.init` at cold start** (app root / `index`) behind a guard: enable only
  when a DSN is present AND the app is not running in Expo Go and not under a test
  runner. The DSN is read from `expo-constants` `extra` (populated by EAS env at
  build). When the guard fails, Sentry is a **no-op** (dev, Expo Go, jest).
- **Root `ErrorBoundary`** wrapping the app tree (Sentry's `wrap`/boundary or a
  thin custom boundary that calls `Sentry.captureException`) to catch React render
  crashes and show a minimal themed fallback.
- **Breadcrumb wiring:** in the native/production path, provide a `Breadcrumb`
  implementation backed by `Sentry.addBreadcrumb` and inject it where the app
  currently uses `noopBreadcrumb`; dev/tests keep the no-op.

### 4.2 PII scrubbing (hard red line)
- A `beforeSend` (and `beforeBreadcrumb`) hook MUST strip any wallet private key,
  mnemonic/seed, or signature from events and breadcrumbs; wallet addresses are
  redacted/shortened. **Never** attach key material. This is a non-custodial
  wallet security red line (consistent with the wallet-security ADRs). Provide a
  pure `scrubEvent(event)` helper that is unit-tested independently of the SDK.

### 4.3 Config surface
- `EXPO_PUBLIC_*` is not used for secrets, but the Sentry DSN is not a secret and
  is needed at cold start, so it is injected at build via EAS env into
  `app.config`/`app.json` `extra.sentryDsn` and read via `expo-constants`. Absence
  of the DSN (e.g. local dev) cleanly yields a no-op.

## 5. Testing (TDD)

**Server**
- `resolveGeo`: extracts country/region from the configured headers; uppercases;
  treats empty/`XX`/`T1` as absent; returns `undefined` when no header.
- `/app-config`: returns `geo` when the geo header is present on the request;
  omits `geo` when absent; existing payload fields unchanged.

**Mobile**
- `services/appConfig`: `loadAppConfig` maps a `geo` field into the store shape;
  missing `geo` → `null`.
- `navigation/RootNavigator`: renders `GeoBlockScreen` when the store geo is a
  restricted country (e.g. `{country:"US"}`) or `{country:"CA",region:"ON"}`;
  renders the tab navigator when geo is a non-restricted country or `null`
  (fail-open).
- `screens/GeoBlockScreen`: renders the localized title/body (assert visible
  text), uses theme tokens only.
- Sentry: `scrubEvent` removes private key / mnemonic / signature fields and
  redacts addresses; the init guard is a no-op without a DSN / under the test
  runner (assert `Sentry.init` is not called); the production breadcrumb forwards
  to `Sentry.addBreadcrumb` while the default stays no-op.

**Gates (must stay green)**
- Server: `cd server && npx tsc --noEmit && npx jest` (≥ current baseline).
- Mobile: `cd mobile && npx tsc --noEmit && npx jest` (≥ current baseline)
  `&& npx jest noHardcodedColors && npx jest messages`; emoji scan → none.
- Sentry code must not break the Expo-Go/jest path (guarded init; no real network).

## 6. File structure

**Server**
- `config/appConfig.ts` — `AppConfigPayload.geo?`; env header names.
- `http/geo.ts` *(new)* — `resolveGeo(req, cfg)`.
- `http/app.ts` — `/app-config` injects geo.

**Mobile**
- `state/runtimeConfigStore.ts` — `geo` field.
- `services/appConfig.ts` — parse `geo`.
- `lib/compliance/geoBlock.ts` — unchanged predicate (UI copy → i18n).
- `screens/GeoBlockScreen.tsx` *(new)* — full-screen block.
- `navigation/RootNavigator.tsx` — gate on geo.
- `lib/observability/sentry.ts` *(new)* — guarded init + `scrubEvent` + production
  `Breadcrumb`.
- `i18n/messages.ts` — `geo.*` keys (en + zh).
- `app.json`/`app.config` — Sentry config plugin + `extra.sentryDsn`.

## 7. Rejected alternatives
- **Client-side IP geolocation** (app calls a 3rd-party geo API): more spoofable,
  extra dependency/latency; rejected in favor of server-derived geo.
- **Device locale/region as the geo source:** trivially spoofed, not compliance
  grade; rejected.
- **Server-delivered Sentry DSN via `/app-config`:** misses pre-config startup
  crashes because init must wait for the fetch; rejected for a build-time DSN.
- **Fail-closed on unknown geo:** blocks all users on any geo/network outage;
  rejected in favor of fail-open given the TestFlight stage.
