# Signer IP / 地址级额度统管 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-(OwnerAddress, RemoteAddr) ingress rate budgets and per-OwnerAddress daily notional caps to `/v1/sign/l1`, on top of the existing per-key budgets, while preserving atomic nonce/fence/cloid-idempotent authorization semantics.

**Architecture:** `policy.Config` becomes the authoritative config surface (`OwnerAddress`, `IPRate*`, `AddressDailyMaxNotionalUsdc`). The signer adds a second front-door token bucket keyed by `(OwnerAddress, RemoteAddr)`, while the address daily cap is enforced inside the atomic `ledger.Authorize` path: `ledger` gets a second spend state keyed by address and applies it only on fresh (non-replay) requests, alongside the existing per-key single-writer state. `singlewriter` stays per-key only.

**Tech Stack:** Go 1.26, existing `internal/ratelimit`, existing `internal/ledger` + Postgres-backed `ledger/pg`, existing `policy.Config`.

**Reference spec:** `docs/superpowers/specs/2026-07-10-ip-address-quota-design.md`

**Baseline gate (must stay green after every task):**
`cd backend && go test ./... && go vet ./... && go test -race ./internal/... ./cmd/... && go build ./cmd/signer && rm -f signer`

---

### Task 1: Extend `policy.Config` with owner/IP/address-budget fields

Add the config fields that make the signer's ingress budget surface explicit and authoritative, while keeping `policy.Evaluate` pure and unchanged.

**Files:**
- Modify: `backend/internal/policy/policy.go`
- Modify: `backend/internal/policy/policy_test.go`

- [ ] **Step 1: Write the failing test**

Extend `backend/internal/policy/policy_test.go` by updating the existing test `TestConfigRateFieldsDefaultZeroAndIgnoredByEvaluate` so it also covers the new fields. Replace the body of that test with:

```go
func TestConfigRateFieldsDefaultZeroAndIgnoredByEvaluate(t *testing.T) {
	// Stateful budget fields default to their zero values and must NOT affect the
	// pure Evaluate path.
	cfg := Config{
		AllowedKinds:    map[string]bool{"order": true},
		MaxNotionalUsdc: 1000,
	}
	if cfg.RatePerSec != 0 || cfg.RateBurst != 0 ||
		cfg.IPRatePerSec != 0 || cfg.IPRateBurst != 0 ||
		cfg.DailyMaxNotionalUsdc != 0 || cfg.AddressDailyMaxNotionalUsdc != 0 ||
		cfg.OwnerAddress != "" {
		t.Fatalf("stateful budget fields must default to zero-values, got %+v", cfg)
	}

	// Setting them does not change the allow decision (Evaluate ignores them).
	cfg.RatePerSec = 5
	cfg.RateBurst = 10
	cfg.IPRatePerSec = 20
	cfg.IPRateBurst = 40
	cfg.DailyMaxNotionalUsdc = 5_000
	cfg.AddressDailyMaxNotionalUsdc = 10_000
	cfg.OwnerAddress = "0xabc"

	d := Evaluate(Intent{Kind: "order", NotionalUsdc: 0}, cfg)
	if !d.Allow {
		t.Fatalf("Evaluate must ignore stateful budget fields; got deny: %s", d.Reason)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/policy/ -run TestConfigRateFieldsDefaultZeroAndIgnoredByEvaluate 2>&1 | tail -8`

Expected: compile failure — unknown fields `IPRatePerSec`, `IPRateBurst`, `AddressDailyMaxNotionalUsdc`, `OwnerAddress`.

- [ ] **Step 3: Add the new config fields**

In `backend/internal/policy/policy.go`, extend `Config` to:

```go
type Config struct {
	AllowedKinds              map[string]bool    // reject-first allowlist; a kind absent/false is denied
	KillSwitch                bool               // when true, every intent is rejected
	MaxNotionalUsdc           float64            // global per-order notional cap
	PerCoinMaxUsdc            map[string]float64 // optional tighter per-coin cap (overrides global)
	DailyMaxNotionalUsdc      float64            // per-key daily notional cap; 0 = no daily limit (enforced by singlewriter/ledger, not Evaluate)
	RatePerSec                float64            // per-key sustained sign rate (tokens/sec); 0 = no rate limit (enforced by ratelimit.Limiter, not Evaluate)
	RateBurst                 float64            // per-key token-bucket capacity (max burst); paired with RatePerSec
	OwnerAddress              string             // server-authoritative owner address for grouped ingress budgets; required when IP/address budgets are enabled
	IPRatePerSec              float64            // per-(OwnerAddress, RemoteAddr) sustained sign rate; 0 = no grouped IP limit
	IPRateBurst               float64            // per-(OwnerAddress, RemoteAddr) token-bucket capacity; paired with IPRatePerSec
	AddressDailyMaxNotionalUsdc float64          // per-OwnerAddress daily notional cap across keys; 0 = no grouped address limit
}
```

Do NOT change `Evaluate`; it must continue to ignore these fields.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/policy/ 2>&1 | tail -3`

Expected: `ok  github.com/lumos-forge/hypersolid/backend/internal/policy`

- [ ] **Step 5: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/policy/policy.go backend/internal/policy/policy_test.go
git commit --no-verify -m "feat(policy): add owner/IP/address budget config fields

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Ledger pure logic + in-memory authorizer for per-address daily cap

Keep `singlewriter` per-key only. Add a second spend state inside `ledger`, keyed by address, and apply it only on fresh authorizations so replay never re-charges.

**Files:**
- Modify: `backend/internal/ledger/ledger.go`
- Modify: `backend/internal/ledger/decide.go`
- Modify: `backend/internal/ledger/mem.go`
- Modify: `backend/internal/ledger/conformance/conformance.go`
- Create: `backend/internal/ledger/spend.go`

- [ ] **Step 1: Write the failing tests**

Append these scenarios to `backend/internal/ledger/conformance/conformance.go` inside `Run` (after the existing daily-cap/idempotence scenarios, before the per-key-isolation scenario is fine). They are written against the public `ledger.Request` surface, so both `Mem` and `pg` implementations will inherit them.

```go
	t.Run("same owner across two keys shares address daily cap", func(t *testing.T) {
		a := newAuth()
		if _, err := a.Authorize(ctx, Request{
			KeyID: "a", Cloid: "c1", Digest: dig(1), Fence: 1,
			Notional: 500, DailyCap: 10_000,
			AddressSpendKey: "0xaaa", AddressDailyCap: 600,
			NowMs: cfNow,
		}); err != nil {
			t.Fatalf("first key err = %v", err)
		}
		if _, err := a.Authorize(ctx, Request{
			KeyID: "b", Cloid: "c2", Digest: dig(2), Fence: 1,
			Notional: 200, DailyCap: 10_000,
			AddressSpendKey: "0xaaa", AddressDailyCap: 600,
			NowMs: cfNow,
		}); !errors.Is(err, ledger.ErrAddressDailyCap) {
			t.Fatalf("second key err = %v, want ErrAddressDailyCap", err)
		}
	})

	t.Run("replay does not recharge the shared address cap", func(t *testing.T) {
		a := newAuth()
		if _, err := a.Authorize(ctx, Request{
			KeyID: "a", Cloid: "c1", Digest: dig(1), Fence: 1,
			Notional: 600, DailyCap: 10_000,
			AddressSpendKey: "0xaaa", AddressDailyCap: 1000,
			NowMs: cfNow,
		}); err != nil {
			t.Fatalf("first sign err = %v", err)
		}
		if _, err := a.Authorize(ctx, Request{
			KeyID: "a", Cloid: "c1", Digest: dig(1), Fence: 1,
			Notional: 600, DailyCap: 10_000,
			AddressSpendKey: "0xaaa", AddressDailyCap: 1000,
			NowMs: cfNow,
		}); err != nil {
			t.Fatalf("replay err = %v, want nil", err)
		}
		if _, err := a.Authorize(ctx, Request{
			KeyID: "b", Cloid: "c2", Digest: dig(2), Fence: 1,
			Notional: 300, DailyCap: 10_000,
			AddressSpendKey: "0xaaa", AddressDailyCap: 1000,
			NowMs: cfNow,
		}); err != nil {
			t.Fatalf("300 should still fit after replay (600+300<=1000), err = %v", err)
		}
	})

	t.Run("different owners do not share address daily cap", func(t *testing.T) {
		a := newAuth()
		if _, err := a.Authorize(ctx, Request{
			KeyID: "a", Cloid: "c1", Digest: dig(1), Fence: 1,
			Notional: 1000, DailyCap: 10_000,
			AddressSpendKey: "0xaaa", AddressDailyCap: 1000,
			NowMs: cfNow,
		}); err != nil {
			t.Fatalf("owner a err = %v", err)
		}
		if _, err := a.Authorize(ctx, Request{
			KeyID: "b", Cloid: "c2", Digest: dig(2), Fence: 1,
			Notional: 1000, DailyCap: 10_000,
			AddressSpendKey: "0xbbb", AddressDailyCap: 1000,
			NowMs: cfNow,
		}); err != nil {
			t.Fatalf("owner b err = %v, want nil (independent address budget)", err)
		}
	})
```

- [ ] **Step 2: Run the ledger tests to verify they fail**

Run: `cd backend && go test ./internal/ledger/... 2>&1 | tail -12`

Expected: compile failure — `ledger.Request` has no `AddressSpendKey` / `AddressDailyCap`, and `ledger.ErrAddressDailyCap` is undefined.

- [ ] **Step 3: Extend the ledger request/error surface**

In `backend/internal/ledger/ledger.go`, update `Request` to:

```go
type Request struct {
	KeyID           string   // agent private key id (per private key, not account)
	Cloid           string   // client order id; half of the ledger key; MUST be non-empty
	Digest          [32]byte // opaque intent digest (caller supplies; typically the HL action hash)
	Fence           uint64   // fencing token from the caller's lease (passed to singlewriter)
	Notional        float64  // this action's USD notional; 0 for non-notional kinds
	DailyCap        float64  // per-key daily notional cap; 0 = unlimited, <0 = misconfig (denied)
	AddressSpendKey string   // normalized owner address for grouped daily spend; "" when disabled
	AddressDailyCap float64  // per-owner-address daily notional cap; 0 = disabled, <0 = misconfig (denied)
	NowMs           int64    // caller clock in ms; injectable for tests
}
```

And add the new typed error next to the existing ones:

```go
	ErrAddressDailyCap    = errors.New("address daily cap exceeded")
```

- [ ] **Step 4: Add the pure address-spend helper**

Create `backend/internal/ledger/spend.go`:

```go
package ledger

import "math"

type SpendState struct {
	SpendDay   int64
	SpendTotal float64
}

func DecideSpend(s SpendState, notional, dailyCap float64, nowMs int64) (SpendState, error) {
	if math.IsNaN(notional) || math.IsInf(notional, 0) || notional < 0 {
		return s, ErrAddressDailyCap
	}
	if dailyCap < 0 {
		return s, ErrAddressDailyCap
	}
	day := nowMs / singlewriterDayMs
	total := s.SpendTotal
	if s.SpendDay != day {
		total = 0
	}
	if dailyCap > 0 && total+notional > dailyCap {
		return s, ErrAddressDailyCap
	}
	return SpendState{SpendDay: day, SpendTotal: total + notional}, nil
}
```

Then, in `backend/internal/ledger/decide.go`, add the constant alias at top-level so `ledger` does not duplicate the literal:

```go
const singlewriterDayMs int64 = 24 * 60 * 60 * 1000
```

(Keep it local to `ledger`; do NOT import `singlewriter.dayMs`, which is unexported.)

- [ ] **Step 5: Extend `ledger.Decide` to keep replay idempotent and charge address cap only on fresh requests**

Replace `backend/internal/ledger/decide.go` with this structure:

```go
func Decide(sw singlewriter.State, addr SpendState, existing *Record, r Request) (singlewriter.State, SpendState, Record, Grant, error) {
	if r.Cloid == "" {
		return sw, addr, Record{}, Grant{}, ErrMissingCloid
	}
	if existing != nil {
		if existing.Digest != r.Digest {
			return sw, addr, Record{}, Grant{}, ErrCloidReuse
		}
		return sw, addr, *existing, Grant{Nonce: existing.Nonce, Duplicate: true}, nil
	}
	nextSW, swg, err := singlewriter.Decide(sw, singlewriter.Request{
		KeyID:    r.KeyID,
		Fence:    r.Fence,
		Notional: r.Notional,
		DailyCap: r.DailyCap,
		NowMs:    r.NowMs,
	})
	if err != nil {
		return sw, addr, Record{}, Grant{}, err
	}
	nextAddr := addr
	if r.AddressDailyCap > 0 {
		nextAddr, err = DecideSpend(addr, r.Notional, r.AddressDailyCap, r.NowMs)
		if err != nil {
			return sw, addr, Record{}, Grant{}, err
		}
	}
	rec := Record{Nonce: swg.Nonce, Digest: r.Digest, Status: StatusSigned}
	return nextSW, nextAddr, rec, Grant{Nonce: swg.Nonce, Duplicate: false}, nil
}
```

- [ ] **Step 6: Wire `ledger.Mem` to persist the new spend state atomically**

In `backend/internal/ledger/mem.go`:

1. Extend `Mem` with:
```go
	addrSpend map[string]SpendState
```

2. Initialize it in `NewMem()`:
```go
		addrSpend: make(map[string]SpendState),
```

3. Update `Authorize`:

```go
	addr := SpendState{}
	if r.AddressDailyCap > 0 {
		addr = m.addrSpend[r.AddressSpendKey]
	}
	nextSW, nextAddr, rec, g, err := Decide(m.sw[r.KeyID], addr, existing, r)
	if err != nil {
		return Grant{}, err
	}
	if !g.Duplicate {
		m.sw[r.KeyID] = nextSW
		if r.AddressDailyCap > 0 {
			m.addrSpend[r.AddressSpendKey] = nextAddr
		}
		m.records[rk] = rec
		m.updatedAt[rk] = time.Now().UnixMilli()
	}
	return g, nil
```

- [ ] **Step 7: Run the ledger tests to verify they pass**

Run: `cd backend && go test ./internal/ledger/... 2>&1 | tail -6`

Expected: `ok` for `internal/ledger` and `internal/ledger/conformance`-driven tests. If `DecideSpend`’s invalid-notional mapping via `ErrAddressDailyCap` feels blunt, keep it anyway for this slice — the handler’s outward surface is intentionally “address daily cap exceeded” fail-closed, not a new public error taxonomy.

- [ ] **Step 8: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/ledger/ledger.go backend/internal/ledger/spend.go backend/internal/ledger/decide.go backend/internal/ledger/mem.go backend/internal/ledger/conformance/conformance.go
git commit --no-verify -m "feat(ledger): add atomic per-address daily spend state

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Postgres ledger persistence for address spend

Persist and transactionally lock the new address spend state in `ledger/pg`.

**Files:**
- Modify: `backend/internal/ledger/pg/schema.go`
- Modify: `backend/internal/ledger/pg/pg.go`
- Modify: `backend/internal/ledger/pg/pg_integration_test.go`

- [ ] **Step 1: Write the failing PG tests**

In `backend/internal/ledger/pg/pg_integration_test.go`, update the truncate statements to include the new table (they should fail before the schema exists). Replace:

```go
TRUNCATE sw_state, ledger_intents
```

with:

```go
TRUNCATE sw_state, addr_spend_state, ledger_intents
```

in both `TestStoreConformance` and `TestStoreReconcileConformance`, and add a PG-specific concurrency test:

```go
func TestConcurrentSameAddressAcrossKeysChargesOnce(t *testing.T) {
	pool := newPool(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, "TRUNCATE sw_state, addr_spend_state, ledger_intents"); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	store := pg.New(pool)
	reqA := ledger.Request{
		KeyID: "a", Cloid: "c1", Digest: [32]byte{1}, Fence: 1,
		Notional: 600, DailyCap: 10_000,
		AddressSpendKey: "0xaaa", AddressDailyCap: 1000,
		NowMs: 1_700_000_000_000,
	}
	reqB := ledger.Request{
		KeyID: "b", Cloid: "c2", Digest: [32]byte{2}, Fence: 1,
		Notional: 600, DailyCap: 10_000,
		AddressSpendKey: "0xaaa", AddressDailyCap: 1000,
		NowMs: 1_700_000_000_000,
	}
	var wg sync.WaitGroup
	errs := make([]error, 2)
	wg.Add(2)
	go func() { defer wg.Done(); _, errs[0] = store.Authorize(ctx, reqA) }()
	go func() { defer wg.Done(); _, errs[1] = store.Authorize(ctx, reqB) }()
	wg.Wait()
	ok, denied := 0, 0
	for _, err := range errs {
		switch {
		case err == nil:
			ok++
		case errors.Is(err, ledger.ErrAddressDailyCap):
			denied++
		default:
			t.Fatalf("unexpected err = %v", err)
		}
	}
	if ok != 1 || denied != 1 {
		t.Fatalf("got ok=%d denied=%d, want 1/1", ok, denied)
	}
}
```

- [ ] **Step 2: Run the PG tests to verify they fail**

Run: `cd backend && go test -tags=integration ./internal/ledger/pg/... 2>&1 | tail -12`

Expected: failure — `addr_spend_state` table does not exist / `ledger.Request` fields missing in this package before wiring.

- [ ] **Step 3: Add the new table to the schema**

In `backend/internal/ledger/pg/schema.go`, extend `createSchemaSQL` by adding:

```sql
CREATE TABLE IF NOT EXISTS addr_spend_state (
    address_key text PRIMARY KEY,
    spend_day   bigint NOT NULL,
    spend_total double precision NOT NULL
)
```

after the `ledger_intents` DDL (same `createSchemaSQL` string block is fine if you concatenate with `;`, or use a second `Exec` — keep whichever matches the file's style and passes `EnsureSchema` idempotently).

- [ ] **Step 4: Wire `ledger/pg.Store.Authorize` to lock/update the address spend row in the same transaction**

In `backend/internal/ledger/pg/pg.go`, add SQL constants:

```go
	addrSeedSQL   = `INSERT INTO addr_spend_state (address_key, spend_day, spend_total) VALUES ($1, 0, 0) ON CONFLICT (address_key) DO NOTHING`
	addrSelectSQL = `SELECT spend_day, spend_total FROM addr_spend_state WHERE address_key = $1 FOR UPDATE`
	addrUpdateSQL = `UPDATE addr_spend_state SET spend_day = $2, spend_total = $3 WHERE address_key = $1`
```

Then in `Authorize`:

1. After loading `existing`, load the address spend state only when needed:

```go
	addr := ledger.SpendState{}
	if r.AddressDailyCap > 0 {
		if _, err := tx.Exec(ctx, addrSeedSQL, r.AddressSpendKey); err != nil {
			return ledger.Grant{}, fmt.Errorf("pg ledger: addr seed: %w", err)
		}
		var addrDay int64
		var addrTotal float64
		if err := tx.QueryRow(ctx, addrSelectSQL, r.AddressSpendKey).Scan(&addrDay, &addrTotal); err != nil {
			return ledger.Grant{}, fmt.Errorf("pg ledger: addr select: %w", err)
		}
		addr = ledger.SpendState{SpendDay: addrDay, SpendTotal: addrTotal}
	}
```

2. Call the new `ledger.Decide` signature:

```go
	nextSW, nextAddr, rec, grant, derr := ledger.Decide(sw, addr, existing, r)
```

3. On fresh success, update the new table before record insert:

```go
	if r.AddressDailyCap > 0 {
		if _, err := tx.Exec(ctx, addrUpdateSQL, r.AddressSpendKey, nextAddr.SpendDay, nextAddr.SpendTotal); err != nil {
			return ledger.Grant{}, fmt.Errorf("pg ledger: addr update: %w", err)
		}
	}
```

- [ ] **Step 5: Run the PG integration tests to verify they pass**

Run: `cd backend && go test -tags=integration ./internal/ledger/pg/... 2>&1 | tail -12`

Expected: conformance green, reconcile conformance green, and `TestConcurrentSameAddressAcrossKeysChargesOnce` green.

- [ ] **Step 6: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/ledger/pg/schema.go backend/internal/ledger/pg/pg.go backend/internal/ledger/pg/pg_integration_test.go
git commit --no-verify -m "feat(ledger/pg): persist and lock per-address spend state

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Signer ingress quotas and fail-closed identity handling

Wire the second rate limiter and pass the address budget through to `Authorize`.

**Files:**
- Modify: `backend/cmd/signer/main.go`
- Modify: `backend/cmd/signer/main_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `backend/cmd/signer/main_test.go` (reusing existing request-building helpers and `leaderMux(...)`). Add these focused tests:

```go
func TestSignIPRateLimitSharedAcrossKeysSameOwnerSameIP(t *testing.T) {
	ks := keystore.New()
	_ = ks.Add("k1", bytes.Repeat([]byte{1}, 32))
	_ = ks.Add("k2", bytes.Repeat([]byte{2}, 32))
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
	policies.Set("k2", cfg)
	h := leaderMux(ks, policies, func() int64 { return 1700000000000 })
	doSign := func(body, remoteAddr string) *httptest.ResponseRecorder {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/sign/l1", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.RemoteAddr = remoteAddr
		h.ServeHTTP(rr, req)
		return rr
	}

	body1 := `{"keyId":"k1","cloid":"c1","kind":"order","params":{"asset":1,"isBuy":true,"limitPx":"1","sz":"1","reduceOnly":false,"orderType":{"limit":{"tif":"Gtc"}}},"isTestnet":false}`
	body2 := `{"keyId":"k2","cloid":"c2","kind":"order","params":{"asset":1,"isBuy":true,"limitPx":"1","sz":"1","reduceOnly":false,"orderType":{"limit":{"tif":"Gtc"}}},"isTestnet":false}`
	for i, body := range []string{body1, body2, body1} {
		rr := doSign(body, "1.2.3.4:9999")
		if i < 2 && rr.Code == http.StatusTooManyRequests {
			t.Fatalf("request %d unexpectedly 429", i+1)
		}
		if i == 2 && rr.Code != http.StatusTooManyRequests {
			t.Fatalf("request 3 status = %d, want 429", rr.Code)
		}
	}
}

func TestSignIPRateLimitDifferentOwnersSameIPIndependent(t *testing.T) {
	ks := keystore.New()
	_ = ks.Add("k1", bytes.Repeat([]byte{1}, 32))
	_ = ks.Add("k2", bytes.Repeat([]byte{2}, 32))
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{
		AllowedKinds:         map[string]bool{"order": true},
		MaxNotionalUsdc:      1e12,
		DailyMaxNotionalUsdc: 1e12,
		OwnerAddress:         "0x1111111111111111111111111111111111111111",
		IPRatePerSec:         1,
		IPRateBurst:          1,
	})
	policies.Set("k2", policy.Config{
		AllowedKinds:         map[string]bool{"order": true},
		MaxNotionalUsdc:      1e12,
		DailyMaxNotionalUsdc: 1e12,
		OwnerAddress:         "0x2222222222222222222222222222222222222222",
		IPRatePerSec:         1,
		IPRateBurst:          1,
	})
	h := leaderMux(ks, policies, func() int64 { return 1700000000000 })
	doSign := func(body string) *httptest.ResponseRecorder {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/sign/l1", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.RemoteAddr = "1.2.3.4:9999"
		h.ServeHTTP(rr, req)
		return rr
	}
	body1 := `{"keyId":"k1","cloid":"c1","kind":"order","params":{"asset":1,"isBuy":true,"limitPx":"1","sz":"1","reduceOnly":false,"orderType":{"limit":{"tif":"Gtc"}}},"isTestnet":false}`
	body2 := `{"keyId":"k2","cloid":"c2","kind":"order","params":{"asset":1,"isBuy":true,"limitPx":"1","sz":"1","reduceOnly":false,"orderType":{"limit":{"tif":"Gtc"}}},"isTestnet":false}`
	if rr := doSign(body1); rr.Code == http.StatusTooManyRequests {
		t.Fatal("owner A unexpectedly throttled")
	}
	if rr := doSign(body2); rr.Code == http.StatusTooManyRequests {
		t.Fatal("owner B should not share owner A's IP bucket")
	}
}

func TestSignAddressDailyCapSharedAcrossKeys(t *testing.T) {
	ks := keystore.New()
	_ = ks.Add("k1", bytes.Repeat([]byte{1}, 32))
	_ = ks.Add("k2", bytes.Repeat([]byte{2}, 32))
	policies := policy.NewStore()
	cfg := policy.Config{
		AllowedKinds:                 map[string]bool{"order": true},
		MaxNotionalUsdc:              1e12,
		DailyMaxNotionalUsdc:         1e12,
		OwnerAddress:                 "0x1111111111111111111111111111111111111111",
		AddressDailyMaxNotionalUsdc:  600,
	}
	policies.Set("k1", cfg)
	policies.Set("k2", cfg)
	h := leaderMux(ks, policies, func() int64 { return 1700000000000 })

	first := httptest.NewRecorder()
	req1 := httptest.NewRequest(http.MethodPost, "/v1/sign/l1", strings.NewReader(`{"keyId":"k1","cloid":"c1","kind":"order","params":{"asset":1,"isBuy":true,"limitPx":"100","sz":"5","reduceOnly":false,"orderType":{"limit":{"tif":"Gtc"}}},"isTestnet":false}`))
	req1.Header.Set("Content-Type", "application/json")
	req1.RemoteAddr = "1.2.3.4:9999"
	h.ServeHTTP(first, req1)
	if first.Code == http.StatusForbidden {
		t.Fatalf("first request unexpectedly denied: %s", first.Body.String())
	}

	second := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodPost, "/v1/sign/l1", strings.NewReader(`{"keyId":"k2","cloid":"c2","kind":"order","params":{"asset":1,"isBuy":true,"limitPx":"100","sz":"2","reduceOnly":false,"orderType":{"limit":{"tif":"Gtc"}}},"isTestnet":false}`))
	req2.Header.Set("Content-Type", "application/json")
	req2.RemoteAddr = "1.2.3.4:9999"
	h.ServeHTTP(second, req2)
	if second.Code != http.StatusForbidden {
		t.Fatalf("second request status = %d, want 403", second.Code)
	}
	var out struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(second.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if out.Error != "address daily cap exceeded" {
		t.Fatalf("error = %q, want %q", out.Error, "address daily cap exceeded")
	}
}

func TestSignInvalidRemoteAddrFailsClosedWhenIPBudgetEnabled(t *testing.T) {
	ks := keystore.New()
	_ = ks.Add("k1", bytes.Repeat([]byte{1}, 32))
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{
		AllowedKinds:         map[string]bool{"order": true},
		MaxNotionalUsdc:      1e12,
		DailyMaxNotionalUsdc: 1e12,
		OwnerAddress:         "0x1111111111111111111111111111111111111111",
		IPRatePerSec:         1,
		IPRateBurst:          1,
	})
	h := leaderMux(ks, policies, func() int64 { return 1700000000000 })
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/sign/l1", strings.NewReader(`{"keyId":"k1","cloid":"c1","kind":"order","params":{"asset":1,"isBuy":true,"limitPx":"1","sz":"1","reduceOnly":false,"orderType":{"limit":{"tif":"Gtc"}}},"isTestnet":false}`))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "not-a-socket"
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rr.Code)
	}
	var out struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if out.Error != "ip rate limit exceeded" {
		t.Fatalf("error = %q, want %q", out.Error, "ip rate limit exceeded")
	}
}

func TestSignMissingOwnerAddressFailsClosedWhenAddressBudgetEnabled(t *testing.T) {
	ks := keystore.New()
	_ = ks.Add("k1", bytes.Repeat([]byte{1}, 32))
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{
		AllowedKinds:                map[string]bool{"order": true},
		MaxNotionalUsdc:             1e12,
		DailyMaxNotionalUsdc:        1e12,
		AddressDailyMaxNotionalUsdc: 600,
	})
	h := leaderMux(ks, policies, func() int64 { return 1700000000000 })
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/sign/l1", strings.NewReader(`{"keyId":"k1","cloid":"c1","kind":"order","params":{"asset":1,"isBuy":true,"limitPx":"100","sz":"1","reduceOnly":false,"orderType":{"limit":{"tif":"Gtc"}}},"isTestnet":false}`))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "1.2.3.4:9999"
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rr.Code)
	}
	var out struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if out.Error != "address daily cap exceeded" {
		t.Fatalf("error = %q, want %q", out.Error, "address daily cap exceeded")
	}
}
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd backend && go test ./cmd/signer/ -run 'IPRateLimit|AddressDailyCap|InvalidRemoteAddr|MissingOwnerAddress' 2>&1 | tail -12`

Expected: failures/compile errors — no `OwnerAddress`/`IPRate*`/`AddressDailyMaxNotionalUsdc` fields in `policy.Config` before Task 1 is merged locally, no handler logic, no address-cap error string.

- [ ] **Step 3: Add the signer-side normalization helpers**

In `backend/cmd/signer/main.go`, add helpers near `parseAccounts` (same file, no new file needed):

```go
func normalizeOwnerAddress(addr string) (string, bool) {
	addr = strings.ToLower(strings.TrimSpace(addr))
	if len(addr) != 42 || !strings.HasPrefix(addr, "0x") {
		return "", false
	}
	for _, c := range addr[2:] {
		switch {
		case c >= '0' && c <= '9', c >= 'a' && c <= 'f':
		default:
			return "", false
		}
	}
	return addr, true
}

func canonicalRemoteIP(remoteAddr string) (string, bool) {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return "", false
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return "", false
	}
	return ip.String(), true
}

func ownerIPKey(ownerAddr, ip string) string { return ownerAddr + "|" + ip }
```

- [ ] **Step 4: Add the second limiter and pass address budget through**

In `handleSignL1`, change the signature to accept both limiters:

```go
func handleSignL1(ks *keystore.Keystore, policies *policy.Store, auth ledger.Authorizer, fencer Fencer, nowMs func() int64, keyLimiter, ipLimiter *ratelimit.Limiter) http.HandlerFunc
```

Inside the handler, after `cfg := policies.Get(req.KeyID)` and before the existing key limiter:

```go
		ownerAddr, ownerOK := normalizeOwnerAddress(cfg.OwnerAddress)
		if cfg.IPRatePerSec > 0 {
			if !ownerOK {
				writeErr(w, http.StatusTooManyRequests, "ip rate limit exceeded")
				return
			}
			ip, ok := canonicalRemoteIP(r.RemoteAddr)
			if !ok || !ipLimiter.Allow(ownerIPKey(ownerAddr, ip), cfg.IPRatePerSec, cfg.IPRateBurst) {
				writeErr(w, http.StatusTooManyRequests, "ip rate limit exceeded")
				return
			}
		}
		if !keyLimiter.Allow(req.KeyID, cfg.RatePerSec, cfg.RateBurst) {
			writeErr(w, http.StatusTooManyRequests, "rate limit exceeded")
			return
		}
```

And when calling `auth.Authorize`:

```go
		if cfg.AddressDailyMaxNotionalUsdc > 0 && !ownerOK {
			writeErr(w, http.StatusForbidden, "address daily cap exceeded")
			return
		}
		grant, err := auth.Authorize(r.Context(), ledger.Request{
			KeyID:           req.KeyID,
			Cloid:           req.Cloid,
			Digest:          digest,
			Fence:           fence,
			Notional:        intent.NotionalUsdc,
			DailyCap:        cfg.DailyMaxNotionalUsdc,
			AddressSpendKey: ownerAddr,
			AddressDailyCap: cfg.AddressDailyMaxNotionalUsdc,
			NowMs:           nowMs(),
		})
```

And add a new error mapping:

```go
			case errors.Is(err, ledger.ErrAddressDailyCap):
				writeErr(w, http.StatusForbidden, "address daily cap exceeded")
```

In `newMux`, create two limiter instances and pass both:

```go
	keyLimiter := ratelimit.New(nowMs)
	ipLimiter := ratelimit.New(nowMs)
	mux.HandleFunc("/v1/sign/l1", loggedRoute("sign_l1", handleSignL1(ks, policies, led, fencer, nowMs, keyLimiter, ipLimiter)))
```

- [ ] **Step 5: Run the signer tests to verify they pass**

Run: `cd backend && go test ./cmd/signer/ 2>&1 | tail -8`

Expected: the new ingress-quota tests pass and the full signer suite stays green.

- [ ] **Step 6: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/cmd/signer/main.go backend/cmd/signer/main_test.go
git commit --no-verify -m "feat(signer): enforce per-user IP budgets and address daily caps

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Roadmap docs

Reflect that **IP/地址级额度统管** is now landed, while **WS 分片配额** and **统一降级** remain future work.

**Files:**
- Modify: `docs/BACKEND-ARCHITECTURE.md`
- Modify: `README.md`

- [ ] **Step 1: Update the M10 status block in `docs/BACKEND-ARCHITECTURE.md`**

Replace the trailing status fragment:

```text
IP/地址级额度统管、WS 分片配额、临界统一降级 待做
```

with:

```text
IP/地址级额度统管（signer：per-(OwnerAddress, RemoteAddr) 令牌桶 + per-OwnerAddress 日 notional 额度，叠加现有 per-key 预算，cloid replay 不重复扣）落地；WS 分片配额、临界统一降级 待做
```

- [ ] **Step 2: Update the M10 summary row**

In the big M10 row, extend the signer status clause after the SLO phrase so it says signer quotas landed too:

```text
；signer SLO（...）落地；signer IP/地址级额度统管（per-user IP bucket + address daily cap）落地；IP/地址级额度统管·WS 分片配额·OTLP ...
```

Replace the old duplicated “IP/地址级额度统管” 待做 wording accordingly so only WS/OTLP remain pending.

- [ ] **Step 3: Update `README.md` roadmap row**

Replace the tail:

```text
...；signer SLO(3 个 + 多窗口燃烧率告警 + promtool 验证)落地；多 AZ、公开上架 待做
```

with:

```text
...；signer SLO(3 个 + 多窗口燃烧率告警 + promtool 验证)落地；signer IP/地址级额度统管(per-user IP bucket + address daily cap)落地；多 AZ、公开上架 待做
```

- [ ] **Step 4: Commit**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add docs/BACKEND-ARCHITECTURE.md README.md
git commit --no-verify -m "docs: mark signer IP/address quota governance landed in M10 roadmap

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Final Verification (before opening the PR)

- [ ] **Full backend gate:**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid/backend && \
go test ./... && go vet ./... && \
go test -race ./internal/... ./cmd/... && \
go build ./cmd/signer && rm -f signer && \
go test -c -tags=integration -o /dev/null ./...
```

Expected: all green.

- [ ] **Signer behavior spot-checks:**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid/backend && \
go test ./cmd/signer/ -run 'IPRateLimit|AddressDailyCap|InvalidRemoteAddr|MissingOwnerAddress' -v
```

Expected: all new ingress-quota tests green.

- [ ] **Atomic replay/cap invariants:**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid/backend && \
go test ./internal/ledger/... -v && \
go test -tags=integration ./internal/ledger/pg/... -v
```

Expected: conformance + PG concurrency tests green.
