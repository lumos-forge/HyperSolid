# Phase 0 Wrap-up (Geo-block + Sentry) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the already-stubbed geo-block predicate into a server-delivered, fail-open jurisdiction gate, and integrate Sentry (guarded init + PII scrubbing + error boundary) for crash/error observability.

**Architecture:** Unit 1 (geo) — the server derives `country`/`region` from a proxy/CDN request header and returns it on the existing public `GET /app-config`; the mobile app stores it and the root navigator hard-blocks confirmed-restricted regions (fail-open when unknown). Unit 2 (Sentry) — a guarded cold-start `Sentry.init` (no-op in Expo Go / dev / tests) with a `beforeSend` PII scrubber and a root error boundary. The two units are independent.

**Tech Stack:** Server = TypeScript / Fastify / Jest. Mobile = Expo SDK 56 / React Native 0.85 / TypeScript / Zustand / @react-navigation v7 / Jest + @testing-library/react-native v14 / `@sentry/react-native` / `expo-constants`. Spec: `docs/superpowers/specs/2026-07-03-phase0-geoblock-sentry-design.md`.

---

## Baselines (must stay green)

- **Server:** `cd server && npx tsc --noEmit` → 0 errors; `npx jest` → **147 tests / 21 suites**.
- **Mobile:** `cd mobile && npx tsc --noEmit` → 0 errors; `npx jest` → **735 tests / 126 suites**; plus `npx jest noHardcodedColors` and `npx jest messages` stay green.

## Conventions (apply to every task)

- **TDD:** write the failing test first, run it and watch it fail, implement minimally, run it and watch it pass, commit.
- **Commit:** `git commit --no-verify -m "<msg>"` with trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`. Commit locally per task; push only when the user says so.
- **Mobile colors via theme tokens only** (no hex outside `src/theme/tokens.ts`); no emoji; all user-facing strings via `useT()` with keys in BOTH en + zh.
- **Expo SDK 56:** before writing any Sentry/native code, consult the exact versioned docs at https://docs.expo.dev/versions/v56.0.0/ for `@sentry/react-native` + `expo-constants` APIs and version pinning.
- **No real network / no native side effects in tests:** inject fakes; mock `@sentry/react-native`.

## File Structure

**Unit 1 — Geo (server + mobile)**
- `server/src/http/geo.ts` *(new)* — `resolveGeo(headers, cfg)` pure header→geo extractor.
- `server/src/http/app.ts` — `/app-config` injects `geo`; `buildApp` deps gain `geoHeaders`.
- `server/src/config/appConfig.ts` — `AppConfigPayload.geo?`; `geoHeadersFromEnv(env)`.
- `mobile/src/state/runtimeConfigStore.ts` — `geo` field.
- `mobile/src/services/appConfig.ts` — parse `geo`.
- `mobile/src/screens/GeoBlockScreen.tsx` *(new)* — full-screen block.
- `mobile/src/navigation/RootNavigator.tsx` — gate on geo.
- `mobile/src/i18n/messages.ts` — `geo.*` keys (en + zh).

**Unit 2 — Sentry (mobile)**
- `mobile/src/lib/observability/sentryScrub.ts` *(new)* — pure `scrubEvent` / `scrubBreadcrumb`.
- `mobile/src/lib/observability/sentry.ts` *(new)* — `shouldEnableSentry`, `initSentry`, `sentryBreadcrumb`.
- `mobile/src/components/ErrorBoundary.tsx` *(new)* — root error boundary.
- `mobile/App.tsx` — wrap tree in `ErrorBoundary`.
- `mobile/index.ts` — call `initSentry()` at cold start.
- `mobile/app.config.js` *(new)* — Sentry config plugin + `extra.sentryDsn` from EAS env (migrates static `app.json` extra).

---

## Task 1: Server — `resolveGeo` header extractor

**Files:**
- Create: `server/src/http/geo.ts`
- Test: `server/src/http/geo.test.ts`

- [ ] **Step 1: Write the failing test** — create `server/src/http/geo.test.ts`:

```ts
import { resolveGeo } from "./geo";

const cfg = { countryHeader: "cf-ipcountry", regionHeader: "cf-region" };

describe("resolveGeo", () => {
  it("reads and uppercases country + region from the configured headers", () => {
    expect(resolveGeo({ "cf-ipcountry": "us", "cf-region": "ca" }, cfg)).toEqual({ country: "US", region: "CA" });
  });
  it("returns country only when no region header is present", () => {
    expect(resolveGeo({ "cf-ipcountry": "CA" }, cfg)).toEqual({ country: "CA" });
  });
  it("treats Cloudflare unknown/tor sentinels (XX, T1) as absent", () => {
    expect(resolveGeo({ "cf-ipcountry": "XX" }, cfg)).toBeUndefined();
    expect(resolveGeo({ "cf-ipcountry": "T1" }, cfg)).toBeUndefined();
  });
  it("returns undefined when the country header is missing or empty", () => {
    expect(resolveGeo({}, cfg)).toBeUndefined();
    expect(resolveGeo({ "cf-ipcountry": "" }, cfg)).toBeUndefined();
  });
  it("handles array-valued headers (takes the first)", () => {
    expect(resolveGeo({ "cf-ipcountry": ["GB", "US"] }, cfg)).toEqual({ country: "GB" });
  });
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd server && npx jest src/http/geo.test.ts`
Expected: FAIL (`Cannot find module './geo'`).

- [ ] **Step 3: Implement** — create `server/src/http/geo.ts`:

```ts
/** Request headers as Fastify exposes them (string | string[] | undefined). */
export type Headers = Record<string, string | string[] | undefined>;

export interface GeoHeaderConfig {
  countryHeader: string;
  regionHeader: string;
}

export interface Geo {
  country?: string;
  region?: string;
}

/** Cloudflare sentinels for unknown / Tor exit — treat as "no country". */
const SENTINELS = new Set(["", "XX", "T1"]);

function first(v: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(v) ? v[0] : v;
  return raw?.trim().toUpperCase();
}

/**
 * Derive the caller's geo from a fronting proxy/CDN header (e.g. Cloudflare `cf-ipcountry`).
 * Returns `undefined` when the country cannot be determined (missing/empty/sentinel) so the app
 * fails open. Region is best-effort (only used for the CA-ON case).
 */
export function resolveGeo(headers: Headers, cfg: GeoHeaderConfig): Geo | undefined {
  const country = first(headers[cfg.countryHeader]);
  if (!country || SENTINELS.has(country)) return undefined;
  const region = first(headers[cfg.regionHeader]);
  return region ? { country, region } : { country };
}
```

- [ ] **Step 4: Run it, expect pass**

Run: `cd server && npx jest src/http/geo.test.ts`
Expected: PASS. Also `npx tsc --noEmit` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/http/geo.ts server/src/http/geo.test.ts
git commit --no-verify -m "feat(server): resolveGeo — derive country/region from a proxy header

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Server — inject `geo` into `GET /app-config`

**Files:**
- Modify: `server/src/config/appConfig.ts`
- Modify: `server/src/http/app.ts`
- Test: `server/src/config/appConfig.test.ts`, `server/src/http/app.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `server/src/config/appConfig.test.ts`:
```ts
import { geoHeadersFromEnv } from "./appConfig";

describe("geoHeadersFromEnv", () => {
  it("defaults to the Cloudflare headers", () => {
    expect(geoHeadersFromEnv({})).toEqual({ countryHeader: "cf-ipcountry", regionHeader: "cf-region" });
  });
  it("honors overrides", () => {
    expect(geoHeadersFromEnv({ GEO_COUNTRY_HEADER: "x-country", GEO_REGION_HEADER: "x-region" }))
      .toEqual({ countryHeader: "x-country", regionHeader: "x-region" });
  });
});
```

Append to `server/src/http/app.test.ts` (inside the top-level `describe`; reuse its `build()` + injection style — the existing `/app-config` test at ~line 171 shows the `buildApp` shape):
```ts
it("adds geo to /app-config from the request country header", async () => {
  const auth0 = new Auth({ secret: "s", genNonce: () => "n", nonceTtlMs: 1e9, sessionTtlMs: 1e9 });
  const agents = new AgentManager(new MemoryAgentStore(), () => AGENT_PK);
  const store = new MemoryStrategyStore(() => 1000);
  const app = buildApp({ auth: auth0, agents, store, geoHeaders: { countryHeader: "cf-ipcountry", regionHeader: "cf-region" } });
  const res = await app.inject({ method: "GET", url: "/app-config", headers: { "cf-ipcountry": "US" } });
  expect(res.statusCode).toBe(200);
  expect(res.json().geo).toEqual({ country: "US" });
  await app.close();
});

it("omits geo from /app-config when no country header is present", async () => {
  const auth0 = new Auth({ secret: "s", genNonce: () => "n", nonceTtlMs: 1e9, sessionTtlMs: 1e9 });
  const agents = new AgentManager(new MemoryAgentStore(), () => AGENT_PK);
  const store = new MemoryStrategyStore(() => 1000);
  const app = buildApp({ auth: auth0, agents, store });
  const res = await app.inject({ method: "GET", url: "/app-config" });
  expect(res.json().geo).toBeUndefined();
  await app.close();
});
```
(`Auth`, `AgentManager`, `MemoryAgentStore`, `MemoryStrategyStore`, `AGENT_PK`, `buildApp` are already imported at the top of `app.test.ts`.)

- [ ] **Step 2: Run them, expect fail**

Run: `cd server && npx jest src/config/appConfig.test.ts src/http/app.test.ts -t "geo"`
Expected: FAIL (`geoHeadersFromEnv` missing; `geoHeaders` dep + geo injection absent).

- [ ] **Step 3: Implement**

3a. In `server/src/config/appConfig.ts`, add `geo?` to the payload type and a header-config builder. Add to the `AppConfigPayload` interface (after `strategyApiBaseUrl: string | null;`):
```ts
  /** Caller geo derived per-request from a proxy header (added by the /app-config handler). */
  geo?: { country?: string; region?: string };
```
Append at the end of the file:
```ts
import type { GeoHeaderConfig } from "../http/geo";

/** Header names the /app-config handler reads the caller's country/region from (Cloudflare defaults). */
export function geoHeadersFromEnv(env: NodeJS.ProcessEnv): GeoHeaderConfig {
  return {
    countryHeader: env.GEO_COUNTRY_HEADER ?? "cf-ipcountry",
    regionHeader: env.GEO_REGION_HEADER ?? "cf-region",
  };
}
```

3b. In `server/src/http/app.ts`:
- Add imports near the other imports:
```ts
import { resolveGeo, type GeoHeaderConfig } from "./geo";
```
- Add `geoHeaders?` to the exported `AppDeps` interface (the one with `auth`, `agents`, `store`, `appConfig?`), after the `appConfig?: AppConfigPayload;` line:
```ts
  /** Header names to read the caller's country/region from on GET /app-config. */
  geoHeaders?: GeoHeaderConfig;
```
- Replace the `/app-config` handler:
```ts
  app.get("/app-config", async () => appConfig);
```
with:
```ts
  const geoHeaders: GeoHeaderConfig = deps.geoHeaders ?? { countryHeader: "cf-ipcountry", regionHeader: "cf-region" };
  app.get("/app-config", async (req) => {
    const geo = resolveGeo(req.headers, geoHeaders);
    return geo ? { ...appConfig, geo } : appConfig;
  });
```

3c. In `server/src/index.ts`, pass the env-configured headers into `buildApp`. Find the `buildApp({ ... })` call and add `geoHeaders: geoHeadersFromEnv(process.env),` to its argument object, and import `geoHeadersFromEnv`:
```ts
import { appConfigFromEnv, geoHeadersFromEnv } from "./config/appConfig";
```
(Merge with the existing `appConfigFromEnv` import if present.)

- [ ] **Step 4: Run them, expect pass**

Run: `cd server && npx jest src/config/appConfig.test.ts src/http/app.test.ts`
Expected: PASS (including the pre-existing `/app-config` test — the no-header path still returns the exact payload). Then `npx tsc --noEmit` → 0 errors, and full `npx jest` → all green.

- [ ] **Step 5: Commit**

```bash
git add server/src/config/appConfig.ts server/src/http/app.ts server/src/http/app.test.ts server/src/config/appConfig.test.ts server/src/index.ts
git commit --no-verify -m "feat(server): serve caller geo on /app-config (proxy header, per-request)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Mobile — store + parse `geo`

**Files:**
- Modify: `mobile/src/state/runtimeConfigStore.ts`
- Modify: `mobile/src/services/appConfig.ts`
- Test: `mobile/src/services/appConfig.test.ts`

- [ ] **Step 1: Write the failing test** — append inside the existing `describe("loadAppConfig", …)` in `mobile/src/services/appConfig.test.ts` (reuse its `jsonResponse` helper):

```ts
it("parses server-delivered geo when present", async () => {
  const fetchImpl = jest.fn(async () => jsonResponse({ geo: { country: "US" } })) as unknown as typeof fetch;
  const cfg = await loadAppConfig("https://api.example.com", fetchImpl);
  expect(cfg.geo).toEqual({ country: "US" });
});
it("defaults geo to null when absent", async () => {
  const fetchImpl = jest.fn(async () => jsonResponse({})) as unknown as typeof fetch;
  const cfg = await loadAppConfig("https://api.example.com", fetchImpl);
  expect(cfg.geo).toBeNull();
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd mobile && npx jest src/services/appConfig.test.ts -t "geo"`
Expected: FAIL (`cfg.geo` is `undefined`, not the parsed value / null).

- [ ] **Step 3: Implement**

3a. In `mobile/src/state/runtimeConfigStore.ts`:
- Add to the `AppRuntimeConfig` interface (after `strategyApiBaseUrl: string | null;`):
```ts
  /** Server-delivered caller geo (from the request IP); null when unknown → gate fails open. */
  geo: { country?: string; region?: string } | null;
```
- Add `geo: null,` to the store's initial state object (next to `strategyApiBaseUrl: null,`).
- Add `geo: cfg.geo,` to the object passed to `set(...)` inside `setConfig`.

3b. In `mobile/src/services/appConfig.ts`:
- Add `geo?: { country?: string; region?: string };` to the `RawAppConfig` interface.
- In `loadAppConfig`'s returned object (the mapping), add:
```ts
    geo: raw.geo ?? null,
```

- [ ] **Step 4: Run it, expect pass**

Run: `cd mobile && npx jest src/services/appConfig.test.ts`
Expected: PASS. Then `npx tsc --noEmit` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/state/runtimeConfigStore.ts mobile/src/services/appConfig.ts mobile/src/services/appConfig.test.ts
git commit --no-verify -m "feat(mobile): store + parse server-delivered geo

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Mobile — `GeoBlockScreen` + i18n

**Files:**
- Create: `mobile/src/screens/GeoBlockScreen.tsx`
- Modify: `mobile/src/i18n/messages.ts`
- Test: `mobile/src/screens/GeoBlockScreen.test.tsx`

- [ ] **Step 1: Confirm i18n parity baseline**

Run: `cd mobile && npx jest messages` → PASS.

- [ ] **Step 2: Write the failing test** — create `mobile/src/screens/GeoBlockScreen.test.tsx`:

```tsx
import React from "react";
import { render, screen } from "@testing-library/react-native";
import { GeoBlockScreen } from "./GeoBlockScreen";
import { useLocaleStore } from "../state/localeStore";

describe("GeoBlockScreen", () => {
  it("renders the localized unavailable title + body (en)", () => {
    useLocaleStore.setState({ locale: "en" });
    render(<GeoBlockScreen />);
    expect(screen.getByText("HyperSolid is unavailable")).toBeTruthy();
    expect(screen.getByText(/not available in your jurisdiction/i)).toBeTruthy();
  });
  it("renders the Chinese copy when locale is zh", () => {
    useLocaleStore.setState({ locale: "zh" });
    render(<GeoBlockScreen />);
    expect(screen.getByText("HyperSolid 不可用")).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run it, expect fail**

Run: `cd mobile && npx jest src/screens/GeoBlockScreen.test.tsx`
Expected: FAIL (`Cannot find module './GeoBlockScreen'`).

- [ ] **Step 4: Add i18n keys** — in `mobile/src/i18n/messages.ts`, add to the **en** map (near other top-level keys):
```ts
    "geo.blockedTitle": "HyperSolid is unavailable",
    "geo.blockedBody": "HyperSolid is not available in your jurisdiction due to regulatory restrictions.",
```
and the matching **zh** keys:
```ts
    "geo.blockedTitle": "HyperSolid 不可用",
    "geo.blockedBody": "根据合规要求，HyperSolid 在您所在的司法管辖区不可用。",
```

- [ ] **Step 5: Implement the screen** — create `mobile/src/screens/GeoBlockScreen.tsx`:

```tsx
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../theme/useTheme";
import { useT } from "../i18n/useT";
import { fonts } from "../theme/fonts";

/** Full-screen compliance block for restricted jurisdictions (spec §9). No navigation into the app. */
export function GeoBlockScreen() {
  const theme = useTheme();
  const t = useT();
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.bg }]} testID="geo-block">
      <View style={styles.center}>
        <Text style={[styles.title, { color: theme.text }]}>{t("geo.blockedTitle")}</Text>
        <Text style={[styles.body, { color: theme.muted }]}>{t("geo.blockedBody")}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, gap: 12 },
  title: { fontFamily: fonts.semibold, fontSize: 20, textAlign: "center" },
  body: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 22, textAlign: "center" },
});
```

Note: confirm the exact `fonts.*` names and `theme.*` token names against an existing screen (e.g. `GeoBlockScreen` should mirror `WelcomeScreen`/`LockScreen`). If `fonts.semibold`/`fonts.regular` differ, use the names those screens use. Use ONLY theme tokens — no hardcoded hex.

- [ ] **Step 6: Run it, expect pass**

Run: `cd mobile && npx jest src/screens/GeoBlockScreen.test.tsx && npx jest messages`
Expected: both PASS. Then `npx tsc --noEmit` → 0 errors; `npx jest noHardcodedColors` → PASS.

- [ ] **Step 7: Commit**

```bash
git add mobile/src/screens/GeoBlockScreen.tsx mobile/src/screens/GeoBlockScreen.test.tsx mobile/src/i18n/messages.ts
git commit --no-verify -m "feat(mobile): GeoBlockScreen + geo.* i18n (en+zh)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: Mobile — gate `RootNavigator` on geo

**Files:**
- Modify: `mobile/src/navigation/RootNavigator.tsx`
- Test: `mobile/src/navigation/RootNavigator.test.tsx`

- [ ] **Step 1: Write the failing tests** — append inside the existing `describe("RootNavigator", …)` in `mobile/src/navigation/RootNavigator.test.tsx`. Import the store at the top (merge with existing imports):
```ts
import { useRuntimeConfigStore } from "../state/runtimeConfigStore";
```
Add to `beforeEach` (so other tests are unaffected):
```ts
    useRuntimeConfigStore.setState({ geo: null });
```
Then add:
```ts
  it("hard-blocks a restricted country (renders the geo block, no tabs)", () => {
    useRuntimeConfigStore.setState({ geo: { country: "US" } });
    render(
      <NavigationContainer>
        <RootNavigator />
      </NavigationContainer>,
    );
    expect(screen.getByTestId("geo-block")).toBeTruthy();
    expect(screen.queryByTestId("tab-Markets")).toBeNull();
  });

  it("renders tabs when geo is a non-restricted country", () => {
    useRuntimeConfigStore.setState({ geo: { country: "JP" } });
    render(
      <NavigationContainer>
        <RootNavigator />
      </NavigationContainer>,
    );
    expect(screen.queryByTestId("geo-block")).toBeNull();
    expect(screen.getAllByText("Markets").length).toBeGreaterThan(0);
  });

  it("fails open (renders tabs) when geo is unknown", () => {
    useRuntimeConfigStore.setState({ geo: null });
    render(
      <NavigationContainer>
        <RootNavigator />
      </NavigationContainer>,
    );
    expect(screen.queryByTestId("geo-block")).toBeNull();
    expect(screen.getAllByText("Markets").length).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run them, expect fail**

Run: `cd mobile && npx jest src/navigation/RootNavigator.test.tsx -t "geo|restricted|fails open"`
Expected: FAIL (no geo gate; block screen never renders).

- [ ] **Step 3: Implement** — edit `mobile/src/navigation/RootNavigator.tsx`:

Add imports:
```ts
import { useRuntimeConfigStore } from "../state/runtimeConfigStore";
import { isRestricted } from "../lib/compliance/geoBlock";
import { GeoBlockScreen } from "../screens/GeoBlockScreen";
```
At the top of the `RootNavigator` function body (before the `return`):
```ts
  const geo = useRuntimeConfigStore((s) => s.geo);
  if (geo && isRestricted(geo)) return <GeoBlockScreen />;
```

- [ ] **Step 4: Run them, expect pass**

Run: `cd mobile && npx jest src/navigation/RootNavigator.test.tsx`
Expected: PASS (all existing + 3 new). Then `npx tsc --noEmit` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/navigation/RootNavigator.tsx mobile/src/navigation/RootNavigator.test.tsx
git commit --no-verify -m "feat(mobile): hard-block restricted jurisdictions at the root navigator

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 6: Mobile — install `@sentry/react-native`

**Files:**
- Modify: `mobile/package.json` (via installer)
- Create: `mobile/__mocks__/@sentry/react-native.js` (jest manual mock, only if the real import destabilizes jest)

- [ ] **Step 1: Consult the Expo 56 docs**

Read https://docs.expo.dev/versions/v56.0.0/ for the Sentry integration to get the exact package + version compatible with Expo SDK 56 (`@sentry/react-native`). Note the recommended install command (`npx expo install @sentry/react-native`) which pins the SDK-56-compatible version.

- [ ] **Step 2: Install**

Run: `cd mobile && npx expo install @sentry/react-native expo-constants`
Expected: `@sentry/react-native` and `expo-constants` added to `package.json` dependencies at SDK-56-compatible versions. (`expo-constants` is needed in Task 10 to read the DSN from `extra`.)

- [ ] **Step 3: Verify the toolchain still green**

Run: `cd mobile && npx tsc --noEmit && npx jest 2>&1 | tail -5`
Expected: tsc 0 errors; jest still 735/126 (no regressions).

If jest fails because it tries to load the native `@sentry/react-native`, create a manual mock at `mobile/__mocks__/@sentry/react-native.js`:
```js
module.exports = {
  init: jest.fn(),
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  wrap: (c) => c,
  reactNavigationIntegration: () => ({}),
};
```
Re-run jest and confirm green. (Jest auto-uses `__mocks__` adjacent to `node_modules` for node-module mocks; individual test files may also `jest.mock("@sentry/react-native")`.)

- [ ] **Step 4: Commit**

```bash
git add mobile/package.json mobile/package-lock.json mobile/__mocks__ 2>/dev/null
git commit --no-verify -m "chore(mobile): add @sentry/react-native + expo-constants (Expo SDK 56)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
(Include `mobile/__mocks__` only if you created the manual mock.)

---

## Task 7: Mobile — pure PII scrubber

**Files:**
- Create: `mobile/src/lib/observability/sentryScrub.ts`
- Test: `mobile/src/lib/observability/sentryScrub.test.ts`

- [ ] **Step 1: Write the failing test** — create `mobile/src/lib/observability/sentryScrub.test.ts`:

```ts
import { scrubEvent, redactAddress } from "./sentryScrub";

describe("redactAddress", () => {
  it("shortens an 0x address to a head…tail form", () => {
    expect(redactAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
  });
});

describe("scrubEvent", () => {
  it("removes key material from extra/contexts and redacts addresses", () => {
    const event = {
      extra: {
        privateKey: "0xdeadbeef",
        mnemonic: "test test test",
        signature: "0xsig",
        address: "0x1234567890abcdef1234567890abcdef12345678",
        note: "keep me",
      },
    };
    const out = scrubEvent(event) as { extra: Record<string, unknown> };
    expect(out.extra.privateKey).toBeUndefined();
    expect(out.extra.mnemonic).toBeUndefined();
    expect(out.extra.signature).toBeUndefined();
    expect(out.extra.address).toBe("0x1234…5678");
    expect(out.extra.note).toBe("keep me");
  });
  it("passes through an event with no sensitive fields", () => {
    expect(scrubEvent({ message: "hi" })).toEqual({ message: "hi" });
  });
  it("is null-safe", () => {
    expect(scrubEvent(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd mobile && npx jest src/lib/observability/sentryScrub.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement** — create `mobile/src/lib/observability/sentryScrub.ts`:

```ts
/**
 * PII scrubbing for Sentry (hard red line: wallet key material must never leave the device).
 * Pure + SDK-independent so it is unit-tested without Sentry. Applied via Sentry's `beforeSend`.
 */

/** Keys whose values are secret and must be dropped entirely (case-insensitive substring match). */
const SECRET_KEYS = ["privatekey", "private_key", "mnemonic", "seed", "signature", "sig", "pin"];
/** Keys whose values are wallet addresses and should be redacted rather than dropped. */
const ADDRESS_KEYS = ["address", "account", "owner", "destination"];

export function redactAddress(v: string): string {
  return /^0x[0-9a-fA-F]{6,}$/.test(v) ? `${v.slice(0, 6)}…${v.slice(-4)}` : v;
}

function scrubRecord(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(rec)) {
    const key = k.toLowerCase();
    if (SECRET_KEYS.some((s) => key.includes(s))) continue; // drop secrets
    if (typeof val === "string" && ADDRESS_KEYS.some((a) => key.includes(a))) {
      out[k] = redactAddress(val);
    } else if (val && typeof val === "object" && !Array.isArray(val)) {
      out[k] = scrubRecord(val as Record<string, unknown>);
    } else {
      out[k] = val;
    }
  }
  return out;
}

/** Scrub a Sentry event's `extra`/`contexts`/`tags` in place-safe fashion. Returns the same shape. */
export function scrubEvent<T>(event: T): T {
  if (!event || typeof event !== "object") return event;
  const e = event as Record<string, unknown>;
  const clone: Record<string, unknown> = { ...e };
  for (const field of ["extra", "contexts", "tags"]) {
    const v = clone[field];
    if (v && typeof v === "object" && !Array.isArray(v)) clone[field] = scrubRecord(v as Record<string, unknown>);
  }
  return clone as T;
}

/** Scrub a breadcrumb's `data` bag with the same rules. */
export function scrubBreadcrumb<T extends { data?: Record<string, unknown> }>(bc: T): T {
  if (bc?.data) return { ...bc, data: scrubRecord(bc.data) };
  return bc;
}
```

- [ ] **Step 4: Run it, expect pass**

Run: `cd mobile && npx jest src/lib/observability/sentryScrub.test.ts`
Expected: PASS. Then `npx tsc --noEmit` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/lib/observability/sentryScrub.ts mobile/src/lib/observability/sentryScrub.test.ts
git commit --no-verify -m "feat(mobile): PII scrubber for Sentry events/breadcrumbs

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 8: Mobile — guarded Sentry init + production breadcrumb

**Files:**
- Create: `mobile/src/lib/observability/sentry.ts`
- Test: `mobile/src/lib/observability/sentry.test.ts`

- [ ] **Step 1: Write the failing test** — create `mobile/src/lib/observability/sentry.test.ts`:

```ts
jest.mock("@sentry/react-native", () => ({
  init: jest.fn(),
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
}));
import * as Sentry from "@sentry/react-native";
import { shouldEnableSentry, initSentry, sentryBreadcrumb } from "./sentry";

describe("shouldEnableSentry", () => {
  it("is true only with a dsn, not in dev, not in Expo Go", () => {
    expect(shouldEnableSentry({ dsn: "https://x@y/1", isDev: false, isExpoGo: false })).toBe(true);
    expect(shouldEnableSentry({ dsn: "", isDev: false, isExpoGo: false })).toBe(false);
    expect(shouldEnableSentry({ dsn: "https://x@y/1", isDev: true, isExpoGo: false })).toBe(false);
    expect(shouldEnableSentry({ dsn: "https://x@y/1", isDev: false, isExpoGo: true })).toBe(false);
  });
});

describe("initSentry", () => {
  beforeEach(() => (Sentry.init as jest.Mock).mockClear());
  it("does not init when disabled", () => {
    initSentry({ dsn: "", isDev: true, isExpoGo: true });
    expect(Sentry.init).not.toHaveBeenCalled();
  });
  it("inits with a beforeSend scrubber when enabled", () => {
    initSentry({ dsn: "https://x@y/1", isDev: false, isExpoGo: false });
    expect(Sentry.init).toHaveBeenCalledTimes(1);
    const opts = (Sentry.init as jest.Mock).mock.calls[0][0];
    expect(opts.dsn).toBe("https://x@y/1");
    const scrubbed = opts.beforeSend({ extra: { privateKey: "0xdead" } });
    expect(scrubbed.extra.privateKey).toBeUndefined();
  });
});

describe("sentryBreadcrumb", () => {
  it("forwards a scrubbed breadcrumb to Sentry", () => {
    (Sentry.addBreadcrumb as jest.Mock).mockClear();
    sentryBreadcrumb("ledger.persist", { privateKey: "0xdead", cloid: "0xabc" });
    const arg = (Sentry.addBreadcrumb as jest.Mock).mock.calls[0][0];
    expect(arg.message).toBe("ledger.persist");
    expect(arg.data.privateKey).toBeUndefined();
    expect(arg.data.cloid).toBe("0xabc");
  });
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd mobile && npx jest src/lib/observability/sentry.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement** — create `mobile/src/lib/observability/sentry.ts`:

```ts
import * as Sentry from "@sentry/react-native";
import { scrubEvent, scrubBreadcrumb } from "./sentryScrub";
import type { Breadcrumb } from "./breadcrumb";

export interface SentryEnv {
  dsn: string;
  isDev: boolean;
  isExpoGo: boolean;
}

/** Enable Sentry only in a real (non-Expo-Go) release build that has a DSN. */
export function shouldEnableSentry(env: SentryEnv): boolean {
  return !!env.dsn && !env.isDev && !env.isExpoGo;
}

/** Cold-start init. No-op unless enabled; wires the PII scrubber as beforeSend. */
export function initSentry(env: SentryEnv): void {
  if (!shouldEnableSentry(env)) return;
  Sentry.init({
    dsn: env.dsn,
    beforeSend: (event: unknown) => scrubEvent(event),
    beforeBreadcrumb: (bc: { data?: Record<string, unknown> }) => scrubBreadcrumb(bc),
  } as Parameters<typeof Sentry.init>[0]);
}

/** Production breadcrumb sink (scrubbed) — inject where the app uses `noopBreadcrumb`. */
export const sentryBreadcrumb: Breadcrumb = (event, data) => {
  const bc = scrubBreadcrumb({ message: event, data: data ?? {} });
  Sentry.addBreadcrumb(bc);
};
```

- [ ] **Step 4: Run it, expect pass**

Run: `cd mobile && npx jest src/lib/observability/sentry.test.ts`
Expected: PASS. Then `npx tsc --noEmit` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/lib/observability/sentry.ts mobile/src/lib/observability/sentry.test.ts
git commit --no-verify -m "feat(mobile): guarded Sentry init + scrubbed production breadcrumb

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 9: Mobile — root `ErrorBoundary`

**Files:**
- Create: `mobile/src/components/ErrorBoundary.tsx`
- Test: `mobile/src/components/ErrorBoundary.test.tsx`

- [ ] **Step 1: Write the failing test** — create `mobile/src/components/ErrorBoundary.test.tsx`:

```tsx
import React from "react";
import { Text } from "react-native";
import { render, screen } from "@testing-library/react-native";
import { ErrorBoundary } from "./ErrorBoundary";

function Boom(): React.ReactElement {
  throw new Error("boom");
}

describe("ErrorBoundary", () => {
  it("renders children when there is no error", () => {
    render(
      <ErrorBoundary onError={jest.fn()}>
        <Text>ok</Text>
      </ErrorBoundary>,
    );
    expect(screen.getByText("ok")).toBeTruthy();
  });
  it("renders a fallback and reports when a child throws", () => {
    const onError = jest.fn();
    // silence the expected React error log for this render
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary onError={onError}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("error-fallback")).toBeTruthy();
    expect(onError).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd mobile && npx jest src/components/ErrorBoundary.test.tsx`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement** — create `mobile/src/components/ErrorBoundary.tsx`:

```tsx
import React from "react";
import { View, Text, StyleSheet } from "react-native";

interface Props {
  children: React.ReactNode;
  /** Reporter for caught render errors (default wired to Sentry at the app root). */
  onError?: (error: Error) => void;
}
interface State { hasError: boolean }

/** Catches render-time crashes so the whole app doesn't white-screen; reports via `onError`. */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }
  componentDidCatch(error: Error): void {
    this.props.onError?.(error);
  }
  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <View style={styles.fallback} testID="error-fallback">
          <Text style={styles.text}>Something went wrong.</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  fallback: { flex: 1, alignItems: "center", justifyContent: "center" },
  text: { fontSize: 15 },
});
```

Note: the fallback is intentionally minimal and theme-independent (it must render even if the theme provider is what crashed). This is the one screen exempt from the theme-token rule — but it uses NO color literals (no `color`/`backgroundColor`), so `noHardcodedColors` still passes. Keep it that way.

- [ ] **Step 4: Run it, expect pass**

Run: `cd mobile && npx jest src/components/ErrorBoundary.test.tsx`
Expected: PASS. Then `npx tsc --noEmit` → 0 errors; `npx jest noHardcodedColors` → PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/components/ErrorBoundary.tsx mobile/src/components/ErrorBoundary.test.tsx
git commit --no-verify -m "feat(mobile): root ErrorBoundary with injectable reporter

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 10: Mobile — wire Sentry init + ErrorBoundary + build config

**Files:**
- Modify: `mobile/index.ts`
- Modify: `mobile/App.tsx`
- Create: `mobile/app.config.js`
- Modify: `mobile/app.json` (values move into `app.config.js`; keep or delete per Expo docs)

> This task wires the tested pieces into the app and adds the native build config. The **JS wiring** (ErrorBoundary wrap) is covered by Task 9's boundary test rendered at the root; the **native plugin + DSN injection** only take effect in an EAS build and are validated there (a manual step, like real-device signing). Do NOT fabricate a jest test for the native build.

- [ ] **Step 1: Cold-start init in `mobile/index.ts`**

Replace the contents of `mobile/index.ts` with (keep the polyfills import first):
```ts
import "./src/polyfills";
import { registerRootComponent } from "expo";
import Constants from "expo-constants";
import { initSentry } from "./src/lib/observability/sentry";
import App from "./App";

const dsn = (Constants.expoConfig?.extra as { sentryDsn?: string } | undefined)?.sentryDsn ?? "";
const isExpoGo = Constants.executionEnvironment === "storeClient";
initSentry({ dsn, isDev: __DEV__, isExpoGo });

registerRootComponent(App);
```
(Confirm the Expo-Go detection field against the Expo 56 docs; `executionEnvironment === "storeClient"` denotes Expo Go. If the docs specify a different check for SDK 56, use that.)

- [ ] **Step 2: Wrap the app tree in `mobile/App.tsx`**

Add the import:
```ts
import { ErrorBoundary } from "./src/components/ErrorBoundary";
import * as Sentry from "@sentry/react-native";
```
Wrap the returned tree: change `return (` … `<SafeAreaProvider> … </SafeAreaProvider>` … `);` so the outermost element is `<ErrorBoundary onError={(e) => Sentry.captureException(e)}>` around `<SafeAreaProvider>…</SafeAreaProvider>`. i.e.:
```tsx
  return (
    <ErrorBoundary onError={(e) => Sentry.captureException(e)}>
      <SafeAreaProvider>
        {/* …existing content unchanged… */}
      </SafeAreaProvider>
    </ErrorBoundary>
  );
```

- [ ] **Step 3: Build config — `mobile/app.config.js`**

Per the Expo 56 docs, create `mobile/app.config.js` that re-exports the existing `app.json` config and adds the Sentry config plugin + the DSN from EAS env. Example shape (adapt to the docs):
```js
const appJson = require("./app.json");

module.exports = () => ({
  ...appJson.expo,
  plugins: [
    ...appJson.expo.plugins,
    "@sentry/react-native/expo",
  ],
  extra: {
    ...(appJson.expo.extra ?? {}),
    sentryDsn: process.env.SENTRY_DSN ?? "",
  },
});
```
Follow the exact plugin name/options from the Expo 56 Sentry guide. Document the `SENTRY_DSN` EAS env var in the PR description (set via EAS secrets at build).

- [ ] **Step 4: Verify the toolchain**

Run: `cd mobile && npx tsc --noEmit && npx jest 2>&1 | tail -5`
Expected: tsc 0 errors; jest green (App still renders under test; index.ts's `initSentry` is a no-op under jest because `dsn` is empty). If any test imports `App`/`index` and trips on `@sentry/react-native`, ensure the Task 6 manual mock covers `captureException`.
Also: `npx jest noHardcodedColors && npx jest messages` → PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/index.ts mobile/App.tsx mobile/app.config.js mobile/app.json
git commit --no-verify -m "feat(mobile): wire Sentry init + ErrorBoundary + Expo config plugin

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final verification

- [ ] **Server:** `cd server && npx tsc --noEmit && npx jest` — 0 tsc errors; green, ≥ 147 tests + new geo tests (geo/appConfig/app).
- [ ] **Mobile:** `cd mobile && npx tsc --noEmit && npx jest` (≥ 735 + new) `&& npx jest noHardcodedColors && npx jest messages`; emoji scan on the new/changed files → "no emoji":
  `rg -n "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" src/screens/GeoBlockScreen.tsx src/lib/observability/*.ts src/components/ErrorBoundary.tsx src/i18n/messages.ts || echo "no emoji"`
- [ ] Report final server + mobile pass counts vs baselines (server 147, mobile 735). Note that the Sentry native plugin/DSN is validated in an EAS build (manual). Await the user's explicit "push".

## Self-review notes (spec coverage)

- Geo source = server `/app-config` (proxy header) → Tasks 1–2. ✓
- Fail-open on unknown → Task 5 (`geo && isRestricted`; null → tabs). ✓
- Full-screen hard block at root → Tasks 4–5. ✓
- Server-derived, per-request, backward-compatible → Task 2 (spread only when present). ✓
- Mobile store/parse geo → Task 3. ✓
- Sentry DSN build-time via `expo-constants` extra → Task 10. ✓
- Guarded init (no-op in Expo Go/dev/tests) → Task 8 + Task 10. ✓
- PII scrubbing red line (beforeSend/beforeBreadcrumb) → Tasks 7–8. ✓
- Root error boundary → Tasks 9–10. ✓
- Production breadcrumb impl ready (`sentryBreadcrumb`) → Task 8. (The `breadcrumb` seam has no consumers yet; wiring consumers is out of scope — not fabricated.) ✓
- i18n en+zh parity + no hardcoded hex + no emoji → enforced per task + final. ✓
