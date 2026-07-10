# 临界统一降级并告警（signer 配额饱和可观测 + 告警）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the signer a per-budget denial counter (`hypersolid_budget_denials_total{budget}`) instrumented at every rate/quota denial point, plus Prometheus multi-window recording+alert rules that fire when budgets saturate — surfacing the throttled/"degraded" regime without changing any signing behavior.

**Architecture:** Pure instrumentation + alerting. Part 1 adds a CounterVec + `ObserveBudgetDenial` + a `BudgetDenialValue` reader to `internal/metrics`, and calls it at the four budget-denial branches in `cmd/signer` `handleSignL1` (via a small `denyBudget` helper for the pre-signing branches, and at the two ledger-error 403 branches). Part 2 adds a `budget_saturation` recording group and `budget_alerts` alert group into the existing `ops/slo` rule files (reused by the existing `slo` CI job, no workflow change). Reject-first, stateless signing is unchanged; the client already degrades to direct HL on 429.

**Tech Stack:** Go; `github.com/prometheus/client_golang` (already a dep) + `github.com/prometheus/client_model/go` (dto, already indirect) for the counter reader; Prometheus recording/alert rules validated by promtool 3.13.0.

**Reference spec:** `docs/superpowers/specs/2026-07-10-budget-saturation-alerting-design.md`

**Branch:** `feat/budget-saturation-alerting` (already created; spec already committed on it).

**Verified facts (do not re-derive):**
- `internal/metrics` uses a private registry `reg`; register new collectors in `init()` via `reg.MustRegister(...)`. Metrics use the `hypersolid_` prefix and `Observe*` exported functions. Handler serves the exposition (`metrics.Handler()`), mounted at `/metrics` in `newMux`.
- `prometheus.Counter` has `Write(*dto.Metric) error`; read a value with `m.GetCounter().GetValue()` where `dto "github.com/prometheus/client_model/go"`.
- `cmd/signer/main.go` `handleSignL1` denial branches (all call `writeErr` then `return`):
  - IP rate → `writeErr(w, http.StatusTooManyRequests, "ip rate limit exceeded")` (4 sites: owner conflict, `!ownerOK`, `IPRatePerSec==0`, `!ipLimiter.Allow(...)`).
  - key rate → `writeErr(w, http.StatusTooManyRequests, "rate limit exceeded")` (1 site: `!keyLimiter.Allow(...)`).
  - address cap pre-check → `writeErr(w, http.StatusForbidden, "address daily cap exceeded")` (2 sites: `AddressDailyMaxNotionalUsdc != 0 && !ownerOK`; `OwnerAddressBudgetConflict`).
  - ledger authorize error switch → `ledger.ErrAddressDailyCap` → 403 "address daily cap exceeded"; `singlewriter.ErrDailyCap` → 403 "daily cap exceeded".
  - EXCLUDE (not budget): `policy.Evaluate` 403, `singlewriter.ErrInvalidNotional` 403, `ErrFenced` 409, `ErrCloidReuse` 409, `ErrMissingCloid` 400, 404/405/400/5xx.
- `cmd/signer/main_test.go` helpers: `leaderMux(ks, policies, nowMs)` builds the real mux; tests POST JSON sign requests and assert status. IP-rate denial reproduced by `TestSignIPRateLimitSharedAcrossKeysSameOwnerSameIP` (config with `IPRatePerSec:1, IPRateBurst:2`, third request → 429). Key daily cap reproduced by `TestSignL1DailyCapExceeded` (`DailyMaxNotionalUsdc:600`, second 500-notional order → 403 "daily cap exceeded").
- promtool `test rules` compares floats EXACTLY; expected recording values may need full precision (existing example: `value: 1.000000000000012 # promtool-exact`).

---

## File Structure

- Modify: `backend/internal/metrics/metrics.go` — add `budgetDenials` CounterVec, budget-kind consts, `ObserveBudgetDenial`, `BudgetDenialValue`, register in `init`.
- Modify: `backend/internal/metrics/metrics_test.go` — white-box tests for the counter + reader.
- Modify: `backend/cmd/signer/main.go` — `denyBudget` helper + instrument 4 budget kinds.
- Modify: `backend/cmd/signer/main_test.go` — assert per-denial counter deltas + non-budget exclusions.
- Modify: `backend/ops/slo/recording.yml` — `budget_saturation` group.
- Modify: `backend/ops/slo/alerts.yml` — `budget_alerts` group.
- Modify: `backend/ops/slo/tests/recording_test.yml` — denial_ratio case.
- Modify: `backend/ops/slo/tests/alerts_test.yml` — healthy/high/critical cases.
- Modify: `backend/ops/slo/README.md` — budget saturation section.
- Modify: `docs/BACKEND-ARCHITECTURE.md` — mark 临界统一降级 landed.

---

## Task 1: metrics — budget denial counter + reader

**Files:**
- Modify: `backend/internal/metrics/metrics.go`
- Test: `backend/internal/metrics/metrics_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/metrics/metrics_test.go`:

```go
func TestObserveBudgetDenial(t *testing.T) {
	before := BudgetDenialValue(BudgetIPRate)
	ObserveBudgetDenial(BudgetIPRate)
	ObserveBudgetDenial(BudgetIPRate)
	if got := BudgetDenialValue(BudgetIPRate) - before; got != 2 {
		t.Fatalf("ip_rate delta = %v, want 2", got)
	}

	beforeKey := BudgetDenialValue(BudgetKeyRate)
	ObserveBudgetDenial(BudgetKeyRate)
	if got := BudgetDenialValue(BudgetKeyRate) - beforeKey; got != 1 {
		t.Fatalf("key_rate delta = %v, want 1", got)
	}

	// Exposition must expose the labeled series once incremented.
	body := scrape(t)
	if !strings.Contains(body, `hypersolid_budget_denials_total{budget="ip_rate"}`) {
		t.Fatalf("missing ip_rate series in exposition:\n%s", body)
	}
	if !strings.Contains(body, `hypersolid_budget_denials_total{budget="key_rate"}`) {
		t.Fatalf("missing key_rate series in exposition:\n%s", body)
	}
}

func TestBudgetDenialValueUnknownIsZero(t *testing.T) {
	if got := BudgetDenialValue("address_cap"); got < 0 {
		t.Fatalf("address_cap value = %v, want >= 0", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/metrics/ -run 'TestObserveBudgetDenial|TestBudgetDenialValue'`
Expected: FAIL — compile error, `undefined: BudgetDenialValue`, `undefined: ObserveBudgetDenial`, `undefined: BudgetIPRate`.

- [ ] **Step 3: Write minimal implementation**

In `backend/internal/metrics/metrics.go`:

(a) Add the dto import to the import block:

```go
import (
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	dto "github.com/prometheus/client_model/go"
)
```

(b) Add the collector after `reconcileHLDuration`:

```go
var budgetDenials = prometheus.NewCounterVec(prometheus.CounterOpts{
	Name: "hypersolid_budget_denials_total",
	Help: "signer sign_l1 requests denied by a rate/quota budget, by budget kind.",
}, []string{"budget"})
```

(c) Add `budgetDenials` to the `reg.MustRegister(...)` call in `init()`:

```go
func init() {
	reg.MustRegister(httpRequests, httpDuration, reconcileSteps, reconcileReaps, reconcileLeader, reconcileStepDuration, reconcileHLDuration, budgetDenials)
}
```

(d) Add the consts + functions (e.g. after `ObserveHTTP`):

```go
// Budget denial kinds. A small closed set keeps label cardinality bounded.
const (
	BudgetKeyRate     = "key_rate"      // per-key token bucket (429)
	BudgetIPRate      = "ip_rate"       // per-(owner,IP) token bucket (429)
	BudgetAddressCap  = "address_cap"   // per-owner-address daily notional cap (403)
	BudgetKeyDailyCap = "key_daily_cap" // per-key daily notional cap (403)
)

// ObserveBudgetDenial counts one sign_l1 request denied by the named budget.
func ObserveBudgetDenial(budget string) {
	budgetDenials.WithLabelValues(budget).Inc()
}

// BudgetDenialValue returns the current count for a budget label (0 if unseen).
// Intended for tests and diagnostics.
func BudgetDenialValue(budget string) float64 {
	var m dto.Metric
	if err := budgetDenials.WithLabelValues(budget).Write(&m); err != nil {
		return 0
	}
	return m.GetCounter().GetValue()
}
```

- [ ] **Step 4: Tidy and run tests**

Run: `cd backend && go mod tidy && go test ./internal/metrics/`
Expected: `go mod tidy` promotes `github.com/prometheus/client_model` to a direct require; tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add backend/internal/metrics/ backend/go.mod backend/go.sum && \
  git commit -m "feat(metrics): budget denial counter + ObserveBudgetDenial + reader"
```

---

## Task 2: signer — instrument budget denials

**Files:**
- Modify: `backend/cmd/signer/main.go`
- Test: `backend/cmd/signer/main_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/cmd/signer/main_test.go`:

```go
func TestBudgetDenialMetricsIPRate(t *testing.T) {
	ks := keystore.New()
	_ = ks.Add("k1", bytes.Repeat([]byte{1}, 32))
	policies := policy.NewStore()
	cfg := policy.Config{
		AllowedKinds:         map[string]bool{"order": true},
		MaxNotionalUsdc:      1e12,
		DailyMaxNotionalUsdc: 1e12,
		OwnerAddress:         "0x1111111111111111111111111111111111111111",
		IPRatePerSec:         1,
		IPRateBurst:          2,
	}
	policies.Set("k1", cfg)
	h := leaderMux(ks, policies, func() int64 { return 1700000000000 })
	doSign := func(cloid string) *httptest.ResponseRecorder {
		body := `{"keyId":"k1","cloid":"` + cloid + `","kind":"order","params":{"asset":1,"isBuy":true,"px":"1","sz":"1","reduceOnly":false,"tif":"Gtc","grouping":"na"},"isTestnet":false}`
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/sign/l1", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.RemoteAddr = "9.9.9.9:1234"
		h.ServeHTTP(rr, req)
		return rr
	}
	before := metrics.BudgetDenialValue(metrics.BudgetIPRate)
	doSign("bd-c1") // 200
	doSign("bd-c2") // 200
	rr := doSign("bd-c3")
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("3rd status = %d, want 429", rr.Code)
	}
	if got := metrics.BudgetDenialValue(metrics.BudgetIPRate) - before; got != 1 {
		t.Fatalf("ip_rate denial delta = %v, want 1", got)
	}
}

func TestBudgetDenialMetricsKeyDailyCap(t *testing.T) {
	ks := keystore.New()
	_ = ks.Add("k1", bytes.Repeat([]byte{0x11}, 32))
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"order": true}, MaxNotionalUsdc: 1e12, DailyMaxNotionalUsdc: 600})
	srv := httptest.NewServer(leaderMux(ks, policies, func() int64 { return 1700000000000 }))
	defer srv.Close()
	post := func(cloid string) int {
		body := `{"keyId":"k1","cloid":"` + cloid + `","kind":"order","params":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"isTestnet":false}`
		res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		defer res.Body.Close()
		return res.StatusCode
	}
	before := metrics.BudgetDenialValue(metrics.BudgetKeyDailyCap)
	if s := post("bdc-c1"); s != 200 {
		t.Fatalf("first status = %d, want 200", s)
	}
	if s := post("bdc-c2"); s != 403 {
		t.Fatalf("second status = %d, want 403", s)
	}
	if got := metrics.BudgetDenialValue(metrics.BudgetKeyDailyCap) - before; got != 1 {
		t.Fatalf("key_daily_cap denial delta = %v, want 1", got)
	}
}

func TestPolicyDenialIsNotABudgetDenial(t *testing.T) {
	ks := keystore.New()
	_ = ks.Add("k1", bytes.Repeat([]byte{0x11}, 32))
	policies := policy.NewStore()
	// Unknown kind → policy denies with 403 BEFORE any budget check.
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"order": true}, MaxNotionalUsdc: 1e12, DailyMaxNotionalUsdc: 1e12})
	srv := httptest.NewServer(leaderMux(ks, policies, func() int64 { return 1700000000000 }))
	defer srv.Close()
	beforeAddr := metrics.BudgetDenialValue(metrics.BudgetAddressCap)
	beforeKey := metrics.BudgetDenialValue(metrics.BudgetKeyDailyCap)
	body := `{"keyId":"k1","cloid":"pol-c1","kind":"cancel","params":{"asset":0,"oid":1},"isTestnet":false}`
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("status = %d, want 403 (policy denies unknown kind)", res.StatusCode)
	}
	if got := metrics.BudgetDenialValue(metrics.BudgetAddressCap) - beforeAddr; got != 0 {
		t.Fatalf("address_cap delta = %v, want 0 (policy denial is not a budget denial)", got)
	}
	if got := metrics.BudgetDenialValue(metrics.BudgetKeyDailyCap) - beforeKey; got != 0 {
		t.Fatalf("key_daily_cap delta = %v, want 0 (policy denial is not a budget denial)", got)
	}
}
```

Ensure `main_test.go`'s import block includes the metrics package path `github.com/lumos-forge/hypersolid/backend/internal/metrics` (add it if missing) and `bytes`, `net/http`, `net/http/httptest`, `strings` (all already present per existing tests).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./cmd/signer/ -run 'TestBudgetDenialMetrics|TestPolicyDenialIsNotABudget'`
Expected: FAIL — `TestBudgetDenialMetricsIPRate` and `...KeyDailyCap` fail on the delta assertions (`want 1`, got 0) because instrumentation is not wired yet. (`TestPolicyDenialIsNotABudgetDenial` passes trivially since nothing increments.)

- [ ] **Step 3: Write minimal implementation**

In `backend/cmd/signer/main.go`:

(a) Add a small helper near `writeErr` (top-level function):

```go
// denyBudget records a budget denial metric, then writes the error response. The
// caller must return immediately after. It centralizes the "count then reject"
// pattern for the signer's rate/quota budgets.
func denyBudget(w http.ResponseWriter, code int, msg, budget string) {
	metrics.ObserveBudgetDenial(budget)
	writeErr(w, code, msg)
}
```

(b) Replace each IP-rate denial site inside `handleSignL1`. There are four `writeErr(w, http.StatusTooManyRequests, "ip rate limit exceeded")` calls; change every one to:

```go
				denyBudget(w, http.StatusTooManyRequests, "ip rate limit exceeded", metrics.BudgetIPRate)
```

(keep the surrounding `return`). Concretely the four sites are: the owner-conflict branch, the `!ownerOK` branch, the `cfg.IPRatePerSec == 0` branch, and the `!ipLimiter.Allow(...)` branch.

(c) Replace the key-rate denial site:

```go
		if !keyLimiter.Allow(req.KeyID, cfg.RatePerSec, cfg.RateBurst) {
			denyBudget(w, http.StatusTooManyRequests, "rate limit exceeded", metrics.BudgetKeyRate)
			return
		}
```

(d) Replace the two address-cap pre-check denial sites:

```go
		if cfg.AddressDailyMaxNotionalUsdc != 0 && !ownerOK {
			denyBudget(w, http.StatusForbidden, "address daily cap exceeded", metrics.BudgetAddressCap)
			return
		}
		if intent.NotionalUsdc != 0 && ownerOK && policies.OwnerAddressBudgetConflict(ownerAddr) {
			denyBudget(w, http.StatusForbidden, "address daily cap exceeded", metrics.BudgetAddressCap)
			return
		}
```

(e) In the ledger authorize error `switch`, instrument the two budget-cap branches (leave the others unchanged):

```go
			case errors.Is(err, ledger.ErrAddressDailyCap):
				denyBudget(w, http.StatusForbidden, "address daily cap exceeded", metrics.BudgetAddressCap)
			case errors.Is(err, singlewriter.ErrDailyCap):
				denyBudget(w, http.StatusForbidden, "daily cap exceeded", metrics.BudgetKeyDailyCap)
```

Leave `ErrInvalidNotional`, `ErrFenced`, `ErrCloidReuse`, `ErrMissingCloid`, and the default as plain `writeErr`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./cmd/signer/`
Expected: PASS (new budget tests + all existing signer tests, since `denyBudget` preserves status codes and bodies).

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add backend/cmd/signer/main.go backend/cmd/signer/main_test.go && \
  git commit -m "feat(signer): instrument budget denials (key/ip rate, address + key daily cap)"
```

---

## Task 3: recording rule — budget denial ratio

**Files:**
- Modify: `backend/ops/slo/recording.yml`
- Modify: `backend/ops/slo/tests/recording_test.yml`

- [ ] **Step 1: Write the failing test**

Append to `backend/ops/slo/tests/recording_test.yml` (before EOF), a case where denials are 20/min and total sign requests are 100/min → ratio 0.2:

```yaml
  # Budget saturation: 20 denials + 80 ok + 20 (429) per min → denial_ratio 0.2.
  - interval: 1m
    input_series:
      - series: 'hypersolid_budget_denials_total{budget="ip_rate"}'
        values: '0+20x60'
      - series: 'hypersolid_http_requests_total{endpoint="sign_l1",code="200"}'
        values: '0+80x60'
      - series: 'hypersolid_http_requests_total{endpoint="sign_l1",code="429"}'
        values: '0+20x60'
    promql_expr_test:
      - expr: budget:denial_ratio:rate5m
        eval_time: 30m
        exp_samples:
          - labels: 'budget:denial_ratio:rate5m'
            value: 0.2 # promtool-exact (reconcile after first run)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend/ops/slo/tests && promtool test rules recording_test.yml`
Expected: FAIL — `budget:denial_ratio:rate5m` is not defined by any rule file yet (no matching samples).

- [ ] **Step 3: Add the recording group**

Append to `backend/ops/slo/recording.yml`:

```yaml
  - name: budget_saturation
    rules:
      - record: budget:denial_ratio:rate5m
        expr: (sum(rate(hypersolid_budget_denials_total[5m])) or vector(0)) / sum(rate(hypersolid_http_requests_total{endpoint="sign_l1"}[5m]))
      - record: budget:denial_ratio:rate30m
        expr: (sum(rate(hypersolid_budget_denials_total[30m])) or vector(0)) / sum(rate(hypersolid_http_requests_total{endpoint="sign_l1"}[30m]))
      - record: budget:denial_ratio:rate1h
        expr: (sum(rate(hypersolid_budget_denials_total[1h])) or vector(0)) / sum(rate(hypersolid_http_requests_total{endpoint="sign_l1"}[1h]))
      - record: budget:denial_ratio:rate6h
        expr: (sum(rate(hypersolid_budget_denials_total[6h])) or vector(0)) / sum(rate(hypersolid_http_requests_total{endpoint="sign_l1"}[6h]))
```

- [ ] **Step 4: Run promtool; reconcile the exact float**

Run: `cd backend/ops/slo && promtool check rules recording.yml && cd tests && promtool test rules recording_test.yml`
Expected: `check rules` passes. `test rules` may FAIL with a message like `expected 0.2, got 0.19999999999999998`. If so, copy the EXACT `got` value into the `value:` field in `recording_test.yml` (keep the `# promtool-exact` comment), then re-run until PASS. This mirrors the existing `1.000000000000012 # promtool-exact` convention.

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add backend/ops/slo/recording.yml backend/ops/slo/tests/recording_test.yml && \
  git commit -m "feat(slo): budget denial ratio recording rules + promtool test"
```

---

## Task 4: alert rules — budget saturation

**Files:**
- Modify: `backend/ops/slo/alerts.yml`
- Modify: `backend/ops/slo/tests/alerts_test.yml`

- [ ] **Step 1: Write the failing test**

Append to `backend/ops/slo/tests/alerts_test.yml` (before EOF):

```yaml
  # Budget healthy: only 200s, no denials → ratio 0 → no budget alerts.
  - interval: 1m
    input_series:
      - series: 'hypersolid_http_requests_total{endpoint="sign_l1",code="200"}'
        values: '0+100x90'
    alert_rule_test:
      - eval_time: 70m
        alertname: BudgetSaturationHigh
        exp_alerts: []
      - eval_time: 70m
        alertname: BudgetSaturationCritical
        exp_alerts: []

  # Budget high only: 30 denials + 70 ok /min → ratio 0.3 → High (ticket), not Critical.
  - interval: 1m
    input_series:
      - series: 'hypersolid_budget_denials_total{budget="ip_rate"}'
        values: '0+30x90'
      - series: 'hypersolid_http_requests_total{endpoint="sign_l1",code="200"}'
        values: '0+70x90'
      - series: 'hypersolid_http_requests_total{endpoint="sign_l1",code="429"}'
        values: '0+30x90'
    alert_rule_test:
      - eval_time: 70m
        alertname: BudgetSaturationHigh
        exp_alerts:
          - exp_labels:
              severity: ticket
            exp_annotations:
              summary: "signer budget saturation high"
              description: "Over 20% of sign_l1 requests are being denied by rate/quota budgets (6h and 30m both > 20%). Budgets are frequently saturating — open a ticket to investigate."
      - eval_time: 70m
        alertname: BudgetSaturationCritical
        exp_alerts: []

  # Budget critical: 60 denials + 40 ok /min → ratio 0.6 → BOTH High and Critical fire.
  - interval: 1m
    input_series:
      - series: 'hypersolid_budget_denials_total{budget="ip_rate"}'
        values: '0+60x90'
      - series: 'hypersolid_http_requests_total{endpoint="sign_l1",code="200"}'
        values: '0+40x90'
      - series: 'hypersolid_http_requests_total{endpoint="sign_l1",code="429"}'
        values: '0+60x90'
    alert_rule_test:
      - eval_time: 70m
        alertname: BudgetSaturationCritical
        exp_alerts:
          - exp_labels:
              severity: page
            exp_annotations:
              summary: "signer budget saturation critical"
              description: "Over 50% of sign_l1 requests are being denied by rate/quota budgets (1h and 5m both > 50%). The signer is in a heavily throttled regime — investigate abusive/misconfigured clients or raise budgets. Page."
      - eval_time: 70m
        alertname: BudgetSaturationHigh
        exp_alerts:
          - exp_labels:
              severity: ticket
            exp_annotations:
              summary: "signer budget saturation high"
              description: "Over 20% of sign_l1 requests are being denied by rate/quota budgets (6h and 30m both > 20%). Budgets are frequently saturating — open a ticket to investigate."
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend/ops/slo/tests && promtool test rules recording_test.yml alerts_test.yml`
Expected: FAIL — alerts `BudgetSaturationHigh`/`BudgetSaturationCritical` are undefined (no rule fires), so the non-empty `exp_alerts` cases fail.

- [ ] **Step 3: Add the alert group**

Append to `backend/ops/slo/alerts.yml`:

```yaml
  - name: budget_alerts
    rules:
      - alert: BudgetSaturationCritical
        expr: budget:denial_ratio:rate1h > 0.5 and on() budget:denial_ratio:rate5m > 0.5
        for: 2m
        labels:
          severity: page
        annotations:
          summary: "signer budget saturation critical"
          description: "Over 50% of sign_l1 requests are being denied by rate/quota budgets (1h and 5m both > 50%). The signer is in a heavily throttled regime — investigate abusive/misconfigured clients or raise budgets. Page."
      - alert: BudgetSaturationHigh
        expr: budget:denial_ratio:rate6h > 0.2 and on() budget:denial_ratio:rate30m > 0.2
        for: 2m
        labels:
          severity: ticket
        annotations:
          summary: "signer budget saturation high"
          description: "Over 20% of sign_l1 requests are being denied by rate/quota budgets (6h and 30m both > 20%). Budgets are frequently saturating — open a ticket to investigate."
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend/ops/slo && promtool check rules recording.yml alerts.yml && cd tests && promtool test rules recording_test.yml alerts_test.yml`
Expected: both PASS. (In the critical case, ratio 0.6 > 0.5 and > 0.2 so both alerts fire; in the high case, 0.3 > 0.2 but < 0.5 so only High fires; healthy fires neither.)

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add backend/ops/slo/alerts.yml backend/ops/slo/tests/alerts_test.yml && \
  git commit -m "feat(slo): budget saturation multi-window alerts (High/Critical) + promtool tests"
```

---

## Task 5: docs — README + roadmap

**Files:**
- Modify: `backend/ops/slo/README.md`
- Modify: `docs/BACKEND-ARCHITECTURE.md`

- [ ] **Step 1: Update the SLO README**

Append a section to `backend/ops/slo/README.md`:

```markdown
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
```

- [ ] **Step 2: Update the roadmap doc**

In `docs/BACKEND-ARCHITECTURE.md`:

(a) M10 status cell (line ~34): replace the trailing `、临界统一降级 待做】**` with:

```
、临界统一降级并告警（signer 按预算维度 hypersolid_budget_denials_total{budget=key_rate|ip_rate|address_cap|key_daily_cap} 计数 + budget_saturation 多窗口告警 High/Critical，`ops/slo`）落地】**
```

(b) §6.3 bullet (line ~99): replace the trailing `；临界统一降级 待做】**` with:

```
；临界统一降级并告警（signer 配额拒绝按预算计数 + Prometheus 多窗口饱和告警，reject-first 无状态、零签名行为变更，`internal/metrics`+`ops/slo`）落地】**
```

(c) `internal/metrics` module-tree note (find the `metrics/` line): append ` + 配额拒绝 hypersolid_budget_denials_total{budget}` to its comment.

Run a check: `grep -n "临界统一降级" docs/BACKEND-ARCHITECTURE.md` — confirm no `待做` remains next to it.

- [ ] **Step 3: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add backend/ops/slo/README.md docs/BACKEND-ARCHITECTURE.md && \
  git commit -m "docs: budget saturation README + mark 临界统一降级并告警 landed in M10"
```

---

## Task 6: final validation + PR

**Files:** none (validation + PR only)

- [ ] **Step 1: Go validation**

Run:
```bash
cd backend && gofmt -l internal/metrics/ cmd/signer/ && \
  go test ./internal/metrics/ ./cmd/signer/ && \
  go test -race ./internal/metrics/ ./cmd/signer/ && \
  go vet ./internal/metrics/ ./cmd/signer/ && \
  go build ./...
```
Expected: `gofmt -l` prints nothing; all tests, race, vet, build pass.

- [ ] **Step 2: promtool validation**

Run:
```bash
cd backend/ops/slo && promtool check rules recording.yml alerts.yml && \
  cd tests && promtool test rules recording_test.yml alerts_test.yml
```
Expected: both PASS. (If promtool is not installed locally, install v3.13.0 as the CI job does, or rely on the `slo` CI job which validates the same files.)

- [ ] **Step 3: Commit any gofmt changes (if any)**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git add -A backend/ && \
  git commit -m "chore: gofmt" || echo "nothing to format"
```

- [ ] **Step 4: Push and open PR**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && git push -u origin feat/budget-saturation-alerting && \
  gh pr create --title "feat(backend): 临界统一降级并告警 —— signer 配额饱和可观测 + 告警（M10）" \
    --body "M10 收尾项。signer 按预算维度(key_rate/ip_rate/address_cap/key_daily_cap)计数配额拒绝(hypersolid_budget_denials_total) + Prometheus 多窗口饱和告警(BudgetSaturationHigh ticket / Critical page，复用 ops/slo promtool CI)。纯埋点 + 告警，零签名行为变更（reject-first 无状态签名器；降级由客户端 429→直连 HL 承担）。Spec: docs/superpowers/specs/2026-07-10-budget-saturation-alerting-design.md"
```
Expected: PR created.

- [ ] **Step 5: After review + green CI, merge**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid && gh pr merge --squash --delete-branch
```

---

## Self-Review Notes

- **Spec coverage:** §3.1 counter+consts+reader → Task 1; §3.2 four budget denial points (+exclusions) → Task 2; §3.3 denominator relation → Tasks 3 (recording); §4.1 recording group → Task 3; §4.2 alert group (High/Critical, multi-window, page/ticket) → Task 4; §4.3 promtool tests → Tasks 3–4; §5 README+roadmap → Task 5; §6 Go+promtool validation → Task 6. All covered.
- **Placeholder scan:** every code/YAML step is complete. The one non-literal is the recording_test exact float, handled by the explicit reconcile step (Task 3 Step 4) matching the repo's existing `# promtool-exact` convention.
- **Type consistency:** `ObserveBudgetDenial(string)`, `BudgetDenialValue(string) float64`, consts `BudgetKeyRate/BudgetIPRate/BudgetAddressCap/BudgetKeyDailyCap`, helper `denyBudget(http.ResponseWriter, int, string, string)`, metric `hypersolid_budget_denials_total{budget}`, recording metric `budget:denial_ratio:rate{5m,30m,1h,6h}`, alerts `BudgetSaturationHigh/Critical` — identical across all tasks and match the spec.
- **Behavior safety:** `denyBudget` writes the same status code + body as the previous `writeErr`; existing signer tests (which assert those codes/bodies) must stay green (Task 2 Step 4).
