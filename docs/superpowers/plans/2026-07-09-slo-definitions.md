# SLO Definitions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define 3 signer SLOs as promtool-verified Prometheus recording (normalized burn-rate) + multi-window multi-burn-rate alerting rules, with a spec doc and a CI validation job.

**Architecture:** Recording rules encode each SLO's error budget once as `burn_rate = error_ratio / budget`; two generic multi-window alerts (`SLOFastBurn` page, `SLOSlowBurn` ticket) fire per `slo` label. `promtool check`/`test` validate the rules locally and in a dedicated CI job. No Go changes — existing metrics suffice.

**Tech Stack:** Prometheus rule YAML, `promtool` (from a pinned Prometheus release), GitHub Actions.

**Reference spec:** `docs/superpowers/specs/2026-07-09-slo-definitions-design.md`

**Metric facts (already emitted by the signer):**
- `hypersolid_http_requests_total{endpoint,code}` — endpoint includes `sign_l1`; `code` is the HTTP status string.
- `hypersolid_http_request_duration_seconds_bucket{endpoint,le}` / `_count{endpoint}` — DefBuckets, so `le="0.5"` exists.
- `hypersolid_reconcile_steps_total{outcome}` — outcome ∈ `ok|error|skipped`.

**Tooling note (all tasks that run promtool):** install promtool locally first. On this macOS dev machine:
```bash
command -v promtool >/dev/null 2>&1 || brew install prometheus
promtool --version
```

---

### Task 1: Recording rules + promtool test

Write the normalized burn-rate recording rules and a promtool unit test asserting exact burn-rate values for a known error rate.

**Files:**
- Create: `backend/ops/slo/recording.yml`
- Create: `backend/ops/slo/tests/recording_test.yml`

- [ ] **Step 1: Write the failing test**

Create `backend/ops/slo/tests/recording_test.yml`:

```yaml
rule_files:
  - ../recording.yml

evaluation_interval: 1m

tests:
  # Sign availability: 1 error + 99 ok per minute → error_ratio 0.01, budget 0.001 → burn 10.
  - interval: 1m
    input_series:
      - series: 'hypersolid_http_requests_total{endpoint="sign_l1",code="200"}'
        values: '0+99x60'
      - series: 'hypersolid_http_requests_total{endpoint="sign_l1",code="500"}'
        values: '0+1x60'
    promql_expr_test:
      - expr: slo:burn_rate:rate5m{slo="sign_availability"}
        eval_time: 30m
        exp_samples:
          - labels: 'slo:burn_rate:rate5m{slo="sign_availability"}'
            value: 10

  # Sign latency: 99/100 under 500ms → error_ratio 0.01, budget 0.01 → burn 1.
  - interval: 1m
    input_series:
      - series: 'hypersolid_http_request_duration_seconds_count{endpoint="sign_l1"}'
        values: '0+100x60'
      - series: 'hypersolid_http_request_duration_seconds_bucket{endpoint="sign_l1",le="0.5"}'
        values: '0+99x60'
    promql_expr_test:
      - expr: slo:burn_rate:rate5m{slo="sign_latency"}
        eval_time: 30m
        exp_samples:
          - labels: 'slo:burn_rate:rate5m{slo="sign_latency"}'
            value: 1

  # Reconciler: 1 error + 99 ok per minute → error_ratio 0.01, budget 0.01 → burn 1.
  - interval: 1m
    input_series:
      - series: 'hypersolid_reconcile_steps_total{outcome="ok"}'
        values: '0+99x60'
      - series: 'hypersolid_reconcile_steps_total{outcome="error"}'
        values: '0+1x60'
    promql_expr_test:
      - expr: slo:burn_rate:rate5m{slo="reconciler_success"}
        eval_time: 30m
        exp_samples:
          - labels: 'slo:burn_rate:rate5m{slo="reconciler_success"}'
            value: 1
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from the tests dir so `../recording.yml` resolves): `cd backend/ops/slo/tests && promtool test rules recording_test.yml`
Expected: FAIL/ERROR — `recording.yml` does not exist yet.

- [ ] **Step 3: Write the recording rules**

Create `backend/ops/slo/recording.yml`:

```yaml
# SLO error-budget burn-rate recording rules for the signer.
# burn_rate = error_ratio / error_budget  (1.0 = budget consumed at the sustainable rate;
# 14.4 = it would be exhausted in ~1/14.4 of the 30-day window).
# SLO definitions & budgets: see backend/ops/slo/README.md.
groups:
  - name: slo_sign_availability
    rules:
      - record: slo:burn_rate:rate5m
        expr: (sum(rate(hypersolid_http_requests_total{endpoint="sign_l1",code=~"5.."}[5m])) / sum(rate(hypersolid_http_requests_total{endpoint="sign_l1"}[5m]))) / 0.001
        labels:
          slo: sign_availability
      - record: slo:burn_rate:rate30m
        expr: (sum(rate(hypersolid_http_requests_total{endpoint="sign_l1",code=~"5.."}[30m])) / sum(rate(hypersolid_http_requests_total{endpoint="sign_l1"}[30m]))) / 0.001
        labels:
          slo: sign_availability
      - record: slo:burn_rate:rate1h
        expr: (sum(rate(hypersolid_http_requests_total{endpoint="sign_l1",code=~"5.."}[1h])) / sum(rate(hypersolid_http_requests_total{endpoint="sign_l1"}[1h]))) / 0.001
        labels:
          slo: sign_availability
      - record: slo:burn_rate:rate6h
        expr: (sum(rate(hypersolid_http_requests_total{endpoint="sign_l1",code=~"5.."}[6h])) / sum(rate(hypersolid_http_requests_total{endpoint="sign_l1"}[6h]))) / 0.001
        labels:
          slo: sign_availability
      - record: slo:error_ratio:rate30d
        expr: sum(rate(hypersolid_http_requests_total{endpoint="sign_l1",code=~"5.."}[30d])) / sum(rate(hypersolid_http_requests_total{endpoint="sign_l1"}[30d]))
        labels:
          slo: sign_availability
  - name: slo_sign_latency
    rules:
      - record: slo:burn_rate:rate5m
        expr: (1 - (sum(rate(hypersolid_http_request_duration_seconds_bucket{endpoint="sign_l1",le="0.5"}[5m])) / sum(rate(hypersolid_http_request_duration_seconds_count{endpoint="sign_l1"}[5m])))) / 0.01
        labels:
          slo: sign_latency
      - record: slo:burn_rate:rate30m
        expr: (1 - (sum(rate(hypersolid_http_request_duration_seconds_bucket{endpoint="sign_l1",le="0.5"}[30m])) / sum(rate(hypersolid_http_request_duration_seconds_count{endpoint="sign_l1"}[30m])))) / 0.01
        labels:
          slo: sign_latency
      - record: slo:burn_rate:rate1h
        expr: (1 - (sum(rate(hypersolid_http_request_duration_seconds_bucket{endpoint="sign_l1",le="0.5"}[1h])) / sum(rate(hypersolid_http_request_duration_seconds_count{endpoint="sign_l1"}[1h])))) / 0.01
        labels:
          slo: sign_latency
      - record: slo:burn_rate:rate6h
        expr: (1 - (sum(rate(hypersolid_http_request_duration_seconds_bucket{endpoint="sign_l1",le="0.5"}[6h])) / sum(rate(hypersolid_http_request_duration_seconds_count{endpoint="sign_l1"}[6h])))) / 0.01
        labels:
          slo: sign_latency
      - record: slo:error_ratio:rate30d
        expr: 1 - (sum(rate(hypersolid_http_request_duration_seconds_bucket{endpoint="sign_l1",le="0.5"}[30d])) / sum(rate(hypersolid_http_request_duration_seconds_count{endpoint="sign_l1"}[30d])))
        labels:
          slo: sign_latency
  - name: slo_reconciler_success
    rules:
      - record: slo:burn_rate:rate5m
        expr: (sum(rate(hypersolid_reconcile_steps_total{outcome="error"}[5m])) / sum(rate(hypersolid_reconcile_steps_total{outcome=~"ok|error"}[5m]))) / 0.01
        labels:
          slo: reconciler_success
      - record: slo:burn_rate:rate30m
        expr: (sum(rate(hypersolid_reconcile_steps_total{outcome="error"}[30m])) / sum(rate(hypersolid_reconcile_steps_total{outcome=~"ok|error"}[30m]))) / 0.01
        labels:
          slo: reconciler_success
      - record: slo:burn_rate:rate1h
        expr: (sum(rate(hypersolid_reconcile_steps_total{outcome="error"}[1h])) / sum(rate(hypersolid_reconcile_steps_total{outcome=~"ok|error"}[1h]))) / 0.01
        labels:
          slo: reconciler_success
      - record: slo:burn_rate:rate6h
        expr: (sum(rate(hypersolid_reconcile_steps_total{outcome="error"}[6h])) / sum(rate(hypersolid_reconcile_steps_total{outcome=~"ok|error"}[6h]))) / 0.01
        labels:
          slo: reconciler_success
      - record: slo:error_ratio:rate30d
        expr: sum(rate(hypersolid_reconcile_steps_total{outcome="error"}[30d])) / sum(rate(hypersolid_reconcile_steps_total{outcome=~"ok|error"}[30d]))
        labels:
          slo: reconciler_success
```

- [ ] **Step 4: Run check + test to verify they pass**

Run:
```bash
cd backend/ops/slo && promtool check rules recording.yml && cd tests && promtool test rules recording_test.yml
```
Expected: `SUCCESS` for check; `SUCCESS` for the 3 unit tests. The clean linear series make the ratios exactly 0.01 (rate() extrapolation cancels), so the burn rates are 10 / 1 / 1. **Floating-point note:** dividing by a non-binary-exact budget (`0.001`/`0.01`) can make promtool report a value like `9.999999999999998` or `10.000000000000002`. If promtool reports such an epsilon-off value, set the test's `value:` to promtool's exact reported number (this is expected float behavior, not a bug). A *materially* different value (e.g. `5`, `100`, `NaN`) means the expr/brackets are wrong — fix the rule, do NOT weaken the test.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/ops/slo/recording.yml backend/ops/slo/tests/recording_test.yml
git commit --no-verify -m "feat(slo): burn-rate recording rules + promtool test

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Multi-window multi-burn-rate alerts + promtool test

Write the two generic burn-rate alerts and a promtool test covering healthy / fast-burn / slow-burn scenarios.

**Files:**
- Create: `backend/ops/slo/alerts.yml`
- Create: `backend/ops/slo/tests/alerts_test.yml`

- [ ] **Step 1: Write the failing test**

Create `backend/ops/slo/tests/alerts_test.yml`:

```yaml
rule_files:
  - ../recording.yml
  - ../alerts.yml

evaluation_interval: 1m

tests:
  # Healthy: only 200s → burn rate absent/0 → no alerts.
  - interval: 1m
    input_series:
      - series: 'hypersolid_http_requests_total{endpoint="sign_l1",code="200"}'
        values: '0+100x90'
    alert_rule_test:
      - eval_time: 70m
        alertname: SLOFastBurn
        exp_alerts: []
      - eval_time: 70m
        alertname: SLOSlowBurn
        exp_alerts: []

  # Fast burn: 50 err + 50 ok /min → error_ratio 0.5, burn 500 → BOTH alerts fire (page + ticket).
  - interval: 1m
    input_series:
      - series: 'hypersolid_http_requests_total{endpoint="sign_l1",code="200"}'
        values: '0+50x90'
      - series: 'hypersolid_http_requests_total{endpoint="sign_l1",code="500"}'
        values: '0+50x90'
    alert_rule_test:
      - eval_time: 70m
        alertname: SLOFastBurn
        exp_alerts:
          - exp_labels:
              slo: sign_availability
              severity: page
            exp_annotations:
              summary: "SLO fast burn for sign_availability"
              description: "sign_availability error budget burning fast: 1h and 5m burn rate both exceed 14.4x (about 2% of the 30d budget per hour). Page."
      - eval_time: 70m
        alertname: SLOSlowBurn
        exp_alerts:
          - exp_labels:
              slo: sign_availability
              severity: ticket
            exp_annotations:
              summary: "SLO slow burn for sign_availability"
              description: "sign_availability error budget burning: 6h and 30m burn rate both exceed 6x (about 5% of the 30d budget per 6h). Open a ticket."

  # Slow burn only: 1 err + 99 ok /min → error_ratio 0.01, burn 10 → SlowBurn fires, FastBurn does not.
  - interval: 1m
    input_series:
      - series: 'hypersolid_http_requests_total{endpoint="sign_l1",code="200"}'
        values: '0+99x90'
      - series: 'hypersolid_http_requests_total{endpoint="sign_l1",code="500"}'
        values: '0+1x90'
    alert_rule_test:
      - eval_time: 70m
        alertname: SLOFastBurn
        exp_alerts: []
      - eval_time: 70m
        alertname: SLOSlowBurn
        exp_alerts:
          - exp_labels:
              slo: sign_availability
              severity: ticket
            exp_annotations:
              summary: "SLO slow burn for sign_availability"
              description: "sign_availability error budget burning: 6h and 30m burn rate both exceed 6x (about 5% of the 30d budget per 6h). Open a ticket."
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend/ops/slo/tests && promtool test rules alerts_test.yml`
Expected: FAIL/ERROR — `alerts.yml` does not exist yet.

- [ ] **Step 3: Write the alerts**

Create `backend/ops/slo/alerts.yml`:

```yaml
# Multi-window multi-burn-rate SLO alerts. Generic over the `slo` label; one alert per
# SLO whose burn rate breaches the threshold on BOTH a long and a short window (the short
# window makes the alert clear quickly once the incident resolves).
# `and on(slo)` matches the two windows by the `slo` label (their __name__ differs).
groups:
  - name: slo_alerts
    rules:
      - alert: SLOFastBurn
        expr: slo:burn_rate:rate1h > 14.4 and on(slo) slo:burn_rate:rate5m > 14.4
        for: 2m
        labels:
          severity: page
        annotations:
          summary: "SLO fast burn for {{ $labels.slo }}"
          description: "{{ $labels.slo }} error budget burning fast: 1h and 5m burn rate both exceed 14.4x (about 2% of the 30d budget per hour). Page."
      - alert: SLOSlowBurn
        expr: slo:burn_rate:rate6h > 6 and on(slo) slo:burn_rate:rate30m > 6
        for: 2m
        labels:
          severity: ticket
        annotations:
          summary: "SLO slow burn for {{ $labels.slo }}"
          description: "{{ $labels.slo }} error budget burning: 6h and 30m burn rate both exceed 6x (about 5% of the 30d budget per 6h). Open a ticket."
```

- [ ] **Step 4: Run check + test (both files) to verify they pass**

Run:
```bash
cd backend/ops/slo && promtool check rules recording.yml alerts.yml && cd tests && promtool test rules alerts_test.yml
```
Expected: `SUCCESS` for check; `SUCCESS` for all 3 alert scenarios. If `and on(slo)` is wrong the fast-burn alert won't fire (the two window metrics won't join). If an annotation mismatch occurs, make the alert annotation text byte-identical to the test's `exp_annotations`.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/ops/slo/alerts.yml backend/ops/slo/tests/alerts_test.yml
git commit --no-verify -m "feat(slo): multi-window multi-burn-rate alerts + promtool test

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: SLO specification doc

Write the authoritative SLO spec co-located with the rules.

**Files:**
- Create: `backend/ops/slo/README.md`

- [ ] **Step 1: Write the doc**

Create `backend/ops/slo/README.md`:

```markdown
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
traffic the ratio is `NaN`, so alerts never fire on absent load (fail-safe). All
expressions `sum(rate(...))` across instances, so the rules are correct under multiple
replicas and leader changes.

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

The long+short window `and on(slo)` pairing pages on a genuine fast burn while clearing
quickly once the short window recovers.

## Runbook (first triage)

- **Page (SLOFastBurn):** an SLO is burning budget fast. Check `{{ slo }}`:
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

Requires the signer `/metrics` endpoint to be scraped. Rules and their promtool unit
tests live here and are validated by the `slo` CI job.
```

- [ ] **Step 2: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/ops/slo/README.md
git commit --no-verify -m "docs(slo): SLO specification, budgets, alerting, runbook

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: CI validation job

Add a dedicated `slo` CI job that installs promtool and runs check + test, isolated from the Go/docker backend job.

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Determine and pin the Prometheus version**

Run: `curl -fsSL https://api.github.com/repos/prometheus/prometheus/releases/latest | grep -m1 '"tag_name"'`
Note the tag (e.g. `v3.13.0` (this machine has 3.13.0)). Use that version (without the leading `v` for the tarball path) in Step 2. If offline, use `3.13.0` and the CI download step will reveal a bad version by failing.

- [ ] **Step 2: Add the `slo` job**

In `.github/workflows/ci.yml`, add a new top-level job under `jobs:` (sibling of `backend`/`mobile`/`server`). Replace `PROM_VERSION` with the pinned version from Step 1:

```yaml
  slo:
    name: slo
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - name: Install promtool
        run: |
          PROM_VERSION=3.13.0
          curl -fsSL "https://github.com/prometheus/prometheus/releases/download/v${PROM_VERSION}/prometheus-${PROM_VERSION}.linux-amd64.tar.gz" -o /tmp/prom.tgz
          tar -xzf /tmp/prom.tgz -C /tmp
          echo "/tmp/prometheus-${PROM_VERSION}.linux-amd64" >> "$GITHUB_PATH"
      - name: Check SLO rules
        run: promtool check rules backend/ops/slo/recording.yml backend/ops/slo/alerts.yml
      - name: Test SLO rules
        working-directory: backend/ops/slo/tests
        run: promtool test rules recording_test.yml alerts_test.yml
```

- [ ] **Step 3: Validate the workflow YAML parses**

Run: `cd /Users/bill/Documents/GitHub/HyperSolid && python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('ci.yml OK')"`
Expected: `ci.yml OK`

- [ ] **Step 4: Re-run promtool locally to confirm the exact CI commands pass**

Run:
```bash
cd /Users/bill/Documents/GitHub/HyperSolid/backend && \
promtool check rules ops/slo/recording.yml ops/slo/alerts.yml && \
cd ops/slo/tests && promtool test rules recording_test.yml alerts_test.yml
```
Expected: `SUCCESS` for check and all tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add .github/workflows/ci.yml
git commit --no-verify -m "ci: add slo job validating SLO rules with promtool

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Roadmap docs

Flip the "SLO 待做" markers to reflect SLOs landed.

**Files:**
- Modify: `docs/BACKEND-ARCHITECTURE.md`
- Modify: `README.md`

- [ ] **Step 1: Locate the current SLO markers**

Run: `cd /Users/bill/Documents/GitHub/HyperSolid && grep -n "SLO" docs/BACKEND-ARCHITECTURE.md README.md`
There are three: the M10 row and the §12 observability line in `docs/BACKEND-ARCHITECTURE.md`, and the roadmap row in `README.md`. Each currently contains `SLO` in a "待做" list.

- [ ] **Step 2: Update `docs/BACKEND-ARCHITECTURE.md` (M10 row)**

Replace the substring:

```
SLO·IP/地址级额度统管·WS 分片配额·OTLP 日志管道（待 OTel Logs 信号稳定）待做
```

with:

```
signer SLO（sign 可用 99.9%/延迟<500ms 99%/reconciler 99%，燃烧率告警 + promtool 验证，`backend/ops/slo`）落地；IP/地址级额度统管·WS 分片配额·OTLP 日志管道（待 OTel Logs 信号稳定）待做
```

- [ ] **Step 3: Update `docs/BACKEND-ARCHITECTURE.md` (§12 observability line)**

Replace the substring:

```
结构化日志（slog + trace 关联 + 访问日志）落地；SLO·sentry-go·OTLP 日志管道 待做
```

with:

```
结构化日志（slog + trace 关联 + 访问日志）落地；SLO（3 个 + 多窗口燃烧率告警 + promtool 验证）落地；sentry-go·OTLP 日志管道 待做
```

- [ ] **Step 4: Update `README.md` (roadmap row)**

Replace the substring:

```
signer 结构化日志(slog + trace 关联 + 访问日志)落地；多 AZ、SLO、公开上架 待做
```

with:

```
signer 结构化日志(slog + trace 关联 + 访问日志)落地；signer SLO(3 个 + 燃烧率告警 + promtool 验证)落地；多 AZ、公开上架 待做
```

- [ ] **Step 5: Verify the markers moved out of "待做"**

Run: `cd /Users/bill/Documents/GitHub/HyperSolid && grep -n "SLO 待做\|SLO、公开\|SLO·" docs/BACKEND-ARCHITECTURE.md README.md`
Expected: no matches (the standalone "SLO 待做" list entries are gone; SLO now appears in the "落地" clauses).

- [ ] **Step 6: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add docs/BACKEND-ARCHITECTURE.md README.md
git commit --no-verify -m "docs: mark signer SLOs landed in M10 roadmap

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Final Verification (before opening the PR)

- [ ] **SLO rules validate (the exact CI commands):**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid/backend && \
promtool check rules ops/slo/recording.yml ops/slo/alerts.yml && \
cd ops/slo/tests && promtool test rules recording_test.yml alerts_test.yml
```
Expected: `SUCCESS` for check and every unit test.

- [ ] **Go backend gate unaffected (no Go changes):**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid/backend && go build ./... && go vet ./...
```
Expected: clean.

- [ ] **Workflow YAML parses:**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('OK')"
```
Expected: `OK`.
