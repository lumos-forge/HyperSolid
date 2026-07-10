# Signer SLOs

Service Level Objectives for the HyperSolid signer, implemented as promtool-tested
Prometheus rules in this directory. All SLOs use a **30-day rolling window**.

## SLIs & targets

| SLO | SLI (error ratio) | Target | Error budget |
|-----|-------------------|--------|--------------|
| **sign_availability** | 5xx responses / all responses on `POST /v1/sign/l1` | 99.9% | 0.1% (~43 min/30d) |
| **sign_latency** | responses ≥ 500ms / all responses on `/v1/sign/l1` | 99% under 500ms | 1% |
| **reconciler_success** | `error` steps / (`ok`+`error`) steps | 99% | 1% |

`bad` for availability is server faults only (5xx); client/policy/rate-limit outcomes
(400/403/429) are excluded. `skipped` (non-leader) reconciler steps are excluded. With no
traffic the ratio is absent, so alerts never fire on absent load (fail-safe); when there
is traffic but zero errors the availability/reconciler SLIs report `0` (via `or vector(0)`
on the numerator) so budget dashboards read 0% rather than "No data". All expressions
`sum(rate(...))` across instances, so the rules are correct under multiple replicas and
leader changes (HTTP requests hit any instance; reconciler steps only increment on the
leader).

## Normalized burn rate

`recording.yml` records, per SLO and per window (5m/30m/1h/6h),
`slo:burn_rate:rate<W>{slo=...} = error_ratio / error_budget`. A burn rate of 1.0 consumes
the 30-day budget exactly over 30 days; 14.4 would exhaust it in ~50 hours. Each SLO's
budget is encoded once here. `slo:error_ratio:rate30d{slo=...}` is also recorded for
budget reporting: remaining budget ≈ `1 - error_ratio30d / budget`.

## Alerts (`alerts.yml`)

Two generic multi-window multi-burn-rate alerts, each firing per `slo` label:

| Alert | Condition | Burns | Severity |
|-------|-----------|-------|----------|
| **SLOFastBurn** | `burn_rate1h > 14.4 and burn_rate5m > 14.4` | ~2% budget in 1h | page |
| **SLOSlowBurn** | `burn_rate6h > 6 and burn_rate30m > 6` | ~5% budget in 6h | ticket |

The expressions use `and on(slo)` to pair the long and short window of the same SLO (their
metric names differ). The long+short window pairing pages on a genuine fast burn while
clearing quickly once the short window recovers, and a single-window spike cannot page.

## Runbook (first triage)

- **Page (SLOFastBurn):** an SLO is burning budget fast. Check the `slo` label:
  - `sign_availability` → 5xx on `/v1/sign/l1`. Inspect signer logs (`msg="http request"`,
    `status`≥500) and traces for the offending `trace_id`; check keystore/policy/single-writer
    and DB (pgxpool) health.
  - `sign_latency` → `/v1/sign/l1` slow. Check `hypersolid_http_request_duration_seconds`
    p99, DB latency, and CPU.
  - `reconciler_success` → reconcile step errors. Check HL `/info` reachability
    (`hypersolid_reconcile_hl_request_duration_seconds`) and ledger/DB health.
- **Ticket (SLOSlowBurn):** slower burn; investigate within business hours before the
  budget is exhausted.

## Loading into Prometheus

Point Prometheus `rule_files` at both YAML files:

```yaml
rule_files:
  - /etc/prometheus/hypersolid/recording.yml
  - /etc/prometheus/hypersolid/alerts.yml
```

Requires the signer `/metrics` endpoint to be scraped. Rules and their promtool unit tests
(`tests/`) live here and are validated by the `slo` CI job
(`promtool check rules` + `promtool test rules`).

## Budget saturation (配额饱和)

Beyond the SLO burn-rate rules, the signer exports `hypersolid_budget_denials_total{budget}` —
one increment per `sign_l1` request denied by a rate/quota budget. `budget` is one of
`key_rate`, `ip_rate`, `address_cap`, `key_daily_cap`.

The `budget_saturation` recording group derives
`budget:denial_ratio:rate{5m,30m,1h,6h} = rate(budget_denials) / rate(sign_l1 total)` (∈ [0,1]).

Alerts (`budget_alerts`), multi-window (long + short, clear quickly):

| Alert | Condition | Severity | Meaning |
|---|---|---|---|
| `BudgetSaturationHigh` | ratio > 0.2 on 6h AND 30m | ticket | Budgets frequently saturating — investigate. |
| `BudgetSaturationCritical` | ratio > 0.5 on 1h AND 5m | page | Heavily throttled regime — abusive/misconfigured client or raise budgets. |

The signer stays reject-first and stateless; clients degrade to direct HL on 429 (§4.1). These
rules surface the throttled/"degraded" regime for operators; they do not change signing behavior.
