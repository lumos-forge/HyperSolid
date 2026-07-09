# SLO Definitions (signer backend) — Design

**Date:** 2026-07-09
**Status:** Approved
**Scope:** Define 3 SLOs for the signer, ship Prometheus recording + multi-burn-rate alerting rules, and validate them with `promtool` in CI. No Go changes.

## 1. Goal

Define Service Level Objectives for the signer's critical paths and encode them as
verified Prometheus rules: recording rules that compute each SLO's normalized error-
budget burn rate, generic multi-window multi-burn-rate alerting rules, a human SLO
specification, and `promtool` check/test validation wired into CI. The existing metrics
are sufficient — no Go code changes.

## 2. Motivation

The signer emits Prometheus metrics (#48–#49), traces (#60), and structured logs (#62),
but has no defined reliability targets or alerting. This closes the M10 observability arc:
concrete SLIs/SLOs on the critical sign path plus the reconciler, with burn-rate alerts
that page on fast budget burn and ticket on slow burn — and, crucially, rules that are
unit-tested (`promtool test`) rather than merely written, matching the production-grade,
auditable posture of this codebase.

## 3. SLIs, SLOs, and Error Budgets

All SLOs use a **30-day rolling window**. The "error ratio" is `bad_events / valid_events`.

### 3.1 Sign availability
- **SLI (error ratio over window W):**
  `sum(rate(hypersolid_http_requests_total{endpoint="sign_l1",code=~"5.."}[W]))
   / sum(rate(hypersolid_http_requests_total{endpoint="sign_l1"}[W]))`
- **Rationale:** `bad` = server faults only (5xx). 4xx outcomes (400 bad request, 403
  policy-denied, 429 rate-limited) are client/policy/protection outcomes, excluded from
  `bad`.
- **SLO:** 99.9% → **error budget = 0.1%** (≈43 min of full-outage-equivalent / 30d).

### 3.2 Sign latency
- **SLI (error ratio over W):**
  `1 - sum(rate(hypersolid_http_request_duration_seconds_bucket{endpoint="sign_l1",le="0.5"}[W]))
       / sum(rate(hypersolid_http_request_duration_seconds_count{endpoint="sign_l1"}[W]))`
- **Rationale:** `bad` = requests taking ≥ 500ms. `le="0.5"` is a real DefBuckets boundary
  (`[.005,.01,.025,.05,.1,.25,.5,1,2.5,5,10]`), so the bucket query is exact.
- **SLO:** 99% under 500ms → **error budget = 1%**.

### 3.3 Reconciler success
- **SLI (error ratio over W):**
  `sum(rate(hypersolid_reconcile_steps_total{outcome="error"}[W]))
   / sum(rate(hypersolid_reconcile_steps_total{outcome=~"ok|error"}[W]))`
- **Rationale:** `skipped` (non-leader) steps are expected and excluded; only `ok`/`error`
  are valid events.
- **SLO:** 99% → **error budget = 1%**.

**No-traffic behavior:** with zero valid events, the ratio is `0/0 = NaN`; `NaN > x` is
false, so alerts never fire on absent traffic (fail-safe).

**Multi-instance:** every expression uses `sum(rate(...))` to aggregate across scraped
instances, so the rules are correct under multiple signer replicas and leader changes
(HTTP requests hit any instance; reconciler steps only increment on the leader).

## 4. Normalized burn rate (DRY, auditable)

Each SLO's error budget is encoded exactly **once**, in its recording rules, as a
normalized burn rate: `burn_rate = error_ratio / error_budget` (a burn rate of 1.0 means
the budget is being consumed exactly at the sustainable rate; 14.4 means it would be
exhausted in ~1/14.4 of the 30-day window). This makes the alerting rules **generic** —
they compare the shared `slo:burn_rate:rate*` metric against fixed multipliers, with the
per-SLO target living only in the recording expressions.

### 4.1 Recording rules (`backend/ops/slo/recording.yml`)
For each of the 3 SLOs, for windows `5m, 30m, 1h, 6h`:
- `record: slo:burn_rate:rate<W>` with `labels: {slo: "<name>"}`,
  `expr: (<error-ratio SLI over W>) / <error_budget>`.
- (12 rules: 4 windows × 3 SLOs.)

Plus, for each SLO, a 30-day raw error-ratio for budget reporting/dashboards:
- `record: slo:error_ratio:rate30d` with `labels: {slo: "<name>"}`,
  `expr: <error-ratio SLI over 30d>`.
- (3 rules.)

SLO label values: `sign_availability`, `sign_latency`, `reconciler_success`.

### 4.2 Alerting rules (`backend/ops/slo/alerts.yml`)
Two generic multi-window multi-burn-rate alerts over `slo:burn_rate:rate*{slo}` (each
fires per `slo` label value):
- **`SLOFastBurn`** (page): `slo:burn_rate:rate1h > 14.4 and slo:burn_rate:rate5m > 14.4`
  — burns 2% of budget in 1h. `labels: {severity: page}`.
- **`SLOSlowBurn`** (ticket): `slo:burn_rate:rate6h > 6 and slo:burn_rate:rate30m > 6`
  — burns 5% of budget in 6h. `labels: {severity: ticket}`.
- Both carry `for: 2m`, an annotation describing the `{{ $labels.slo }}` and observed burn
  rate. The long+short window `and` ensures the alert clears quickly once the incident
  resolves (the short window falls below threshold fast).

## 5. Validation (promtool in CI)

### 5.1 Test files (`backend/ops/slo/tests/`)
- `recording_test.yml` — feeds synthetic `hypersolid_http_requests_total`,
  `hypersolid_http_request_duration_seconds_bucket`/`_count`, and
  `hypersolid_reconcile_steps_total` series; asserts, via `promql_expr_test`, that the
  recorded `slo:burn_rate:rate5m{slo=...}` and `slo:error_ratio:rate30d{slo=...}` values
  match the expected numbers for a known error rate.
- `alerts_test.yml` — three scenarios via `alert_rule_test`:
  1. **Healthy:** low/zero error rate → neither `SLOFastBurn` nor `SLOSlowBurn` fires.
  2. **Fast burn:** a sign-availability 5xx storm driving burn rate > 14.4 over 1h & 5m →
     `SLOFastBurn{slo="sign_availability",severity="page"}` fires.
  3. **No traffic:** empty series → no alert (NaN safety).
  Test series use a 1-minute sample interval; the fast-burn scenario provides ≥ 1h of
  samples so the 1h window is populated.

### 5.2 CI wiring (`.github/workflows/ci.yml`, `backend` job)
Add steps (working-directory `backend`):
- Install `promtool`: download a pinned Prometheus release tarball to a temp dir and put
  `promtool` on `PATH` (the implementer pins the current latest stable Prometheus
  release, e.g. `v3.x.y`, verified to download).
- `promtool check rules ops/slo/recording.yml ops/slo/alerts.yml` — syntax/type check.
- `promtool test rules ops/slo/tests/recording_test.yml ops/slo/tests/alerts_test.yml` —
  unit tests.

## 6. SLO specification doc (`backend/ops/slo/README.md`)

Human-readable authority co-located with the rules: the 3 SLIs (formulas), SLOs (targets,
30d window), error budgets (0.1%/1%/1%, with 30d minute/percentage equivalents), the
normalized-burn-rate scheme and the two alert tiers (windows, multipliers, severities), a
short runbook note (what a page/ticket means and first triage steps), and how to load the
rules into Prometheus (point `rule_files` at `recording.yml` + `alerts.yml`). Referenced
from `docs/BACKEND-ARCHITECTURE.md`.

## 7. Roadmap docs

Flip the "SLO 待做" markers in `docs/BACKEND-ARCHITECTURE.md` (M10 row + §12 observability
line) and `README.md` (roadmap row) to reflect SLOs landed (rules + promtool-tested),
noting the burn-rate alerting scheme and `backend/ops/slo/`.

## 8. Out of Scope (YAGNI)

- No `digest_l1` SLO (keyless read path).
- No Grafana dashboard JSON (separate effort).
- No Alertmanager routing/receivers config (deployment-side).
- No Go metric changes (existing metrics suffice).
- No running Prometheus/collector — the rules are ready-to-load artifacts.

## 9. Dependencies

No Go dependency changes. CI gains `promtool` (a pinned Prometheus release binary).

## 10. Verification Gate

`promtool check rules backend/ops/slo/recording.yml backend/ops/slo/alerts.yml` and
`promtool test rules backend/ops/slo/tests/*.yml` both pass locally and in CI. The
existing backend gate (`cd backend && go build ./... && go vet ./... && go test
-tags=integration ./...`) stays green (unaffected — no Go changes).
