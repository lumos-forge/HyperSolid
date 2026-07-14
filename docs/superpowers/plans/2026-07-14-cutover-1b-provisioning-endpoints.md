# Cutover Phase 1b — Signer Provisioning Endpoints — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add `POST /v1/keys` (idempotent provision + full policy binding) and `DELETE /v1/keys/{keyId}` (zeroize+unbind) to the signer, both leader-gated, exposing the Phase-1a `keystore.Manager`.

**Architecture:** Add `policy.Store.Delete`; thread the `*keystore.Manager` through `buildHandler`→`newMux`; two new leader-gated handlers. `scheduleCancel` is already a supported action (no work).

**Tech Stack:** Go 1.26, net/http (method+wildcard patterns), pgx.

Spec: `docs/superpowers/specs/2026-07-14-cutover-1b-provisioning-endpoints-design.md`
Branch: `feat/cutover-1b-provisioning`
Validation: `cd backend && gofmt -w ./... && go test ./... && go vet ./... && go build ./cmd/signer && rm -f signer`.

---

### Task 1: `policy.Store.Delete`

**Files:** Modify `backend/internal/policy/store.go`; Test `backend/internal/policy/store_test.go`

- [ ] **Step 1: Write the failing test**

Add:
```go
func TestStoreDelete(t *testing.T) {
	s := NewStore()
	s.Set("k1", Config{OwnerAddress: "0xowner", AllowedKinds: map[string]bool{"order": true}, MaxNotionalUsdc: 100})
	if !s.Get("k1").AllowedKinds["order"] {
		t.Fatal("precondition: order should be allowed")
	}
	s.Delete("k1")
	if len(s.Get("k1").AllowedKinds) != 0 {
		t.Fatalf("expected default-deny (empty) Config after Delete, got %+v", s.Get("k1"))
	}
	s.Delete("k1") // idempotent
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test ./internal/policy/ -run TestStoreDelete`
Expected: FAIL (undefined: Delete).

- [ ] **Step 3: Implement** (after `Set`)

```go
// Delete removes the Config for keyID and clears any derived owner budget-conflict state.
func (s *Store) Delete(keyID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	owner := ownerKey(s.byKey[keyID].OwnerAddress)
	delete(s.byKey, keyID)
	delete(s.keyOwnerIPConflict, keyID)
	delete(s.keyOwnerAddrConflict, keyID)
	s.recomputeOwnerConflictsLocked(owner)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && go test ./internal/policy/ -run TestStoreDelete`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd backend && gofmt -w internal/policy/store.go internal/policy/store_test.go
git add internal/policy/store.go internal/policy/store_test.go
git commit -m "feat(cutover-1b): policy.Store.Delete (unbind a key's policy)"
```

---

### Task 2: Thread the Manager + provisioning endpoints (TDD)

**Files:** Modify `backend/cmd/signer/main.go`, `backend/cmd/signer/main_test.go`

- [ ] **Step 1: Write the failing tests**

Add to `main_test.go` (uses the existing `leaderMux`/`constFencer`/`httptest` helpers):
```go
func TestProvisionAndSignAndDelete(t *testing.T) {
	ks := keystore.New()
	policies := policy.NewStore()
	srv := httptest.NewServer(leaderMux(ks, policies, nil))
	defer srv.Close()

	// provision
	body := `{"keyId":"k1","ownerAddress":"0xowner","allowedKinds":["order"],"maxNotionalUsdc":1e12}`
	res, err := http.Post(srv.URL+"/v1/keys", "application/json", strings.NewReader(body))
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("provision status = %v, %v", res.StatusCode, err)
	}
	var pr struct{ KeyID, AgentAddress string }
	_ = json.NewDecoder(res.Body).Decode(&pr)
	if pr.KeyID != "k1" || len(pr.AgentAddress) != 42 || pr.AgentAddress[:2] != "0x" {
		t.Fatalf("bad provision response %+v", pr)
	}

	// idempotent: same address, key not regenerated
	res2, _ := http.Post(srv.URL+"/v1/keys", "application/json", strings.NewReader(body))
	var pr2 struct{ AgentAddress string }
	_ = json.NewDecoder(res2.Body).Decode(&pr2)
	if pr2.AgentAddress != pr.AgentAddress {
		t.Fatalf("re-provision changed the address: %s -> %s", pr.AgentAddress, pr2.AgentAddress)
	}

	// the key is registered + policy bound: signing an allowed kind is not 404/403 for policy;
	// a disallowed kind is 403.
	sign := func(kind string) int {
		b := `{"keyId":"k1","kind":"` + kind + `","params":{},"cloid":"0x` + strings.Repeat("1", 32) + `","isTestnet":true}`
		r, _ := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(b))
		return r.StatusCode
	}
	if code := sign("cancel"); code != 403 {
		t.Fatalf("disallowed kind should be 403, got %d", code)
	}

	// delete → 204, then the key is gone (sign → 404)
	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/v1/keys/k1", nil)
	dr, _ := http.DefaultClient.Do(req)
	if dr.StatusCode != 204 {
		t.Fatalf("delete status = %d", dr.StatusCode)
	}
	if code := sign("order"); code != 404 {
		t.Fatalf("after delete, sign should be 404, got %d", code)
	}
}

func TestProvisionKeyBadRequests(t *testing.T) {
	srv := httptest.NewServer(leaderMux(keystore.New(), policy.NewStore(), nil))
	defer srv.Close()
	// empty keyId → 400
	r, _ := http.Post(srv.URL+"/v1/keys", "application/json", strings.NewReader(`{"keyId":""}`))
	if r.StatusCode != 400 {
		t.Fatalf("empty keyId → %d", r.StatusCode)
	}
	// bad json → 400
	r, _ = http.Post(srv.URL+"/v1/keys", "application/json", strings.NewReader(`{`))
	if r.StatusCode != 400 {
		t.Fatalf("bad json → %d", r.StatusCode)
	}
	// wrong method → 405
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/v1/keys", nil)
	r, _ = http.DefaultClient.Do(req)
	if r.StatusCode != 405 {
		t.Fatalf("GET /v1/keys → %d", r.StatusCode)
	}
}

func TestProvisionNonLeader(t *testing.T) {
	nowMs := func() int64 { return 0 }
	mgr := keystore.NewManager(keystore.New(), keystore.NewMemVault(), bytes.Repeat([]byte{9}, 32))
	mux := newMux(keystore.New(), mgr, policy.NewStore(), ledger.NewMem(), constFencer{epoch: 1, leader: false}, nowMs)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	r, _ := http.Post(srv.URL+"/v1/keys", "application/json", strings.NewReader(`{"keyId":"k1"}`))
	if r.StatusCode != 503 {
		t.Fatalf("non-leader provision → %d, want 503", r.StatusCode)
	}
}
```
Ensure the test imports include `bytes` and `strings` (add if missing).

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test ./cmd/signer/ -run 'TestProvision'`
Expected: FAIL (compile error: `newMux`/`leaderMux` don't take a Manager; handlers undefined).

- [ ] **Step 3: Update `leaderMux` + `newMux` signature and register routes**

In `main_test.go`, change `leaderMux` to build a Manager:
```go
func leaderMux(ks *keystore.Keystore, policies *policy.Store, nowMs func() int64) http.Handler {
	mgr := keystore.NewManager(ks, keystore.NewMemVault(), bytes.Repeat([]byte{0x2a}, 32))
	return newMux(ks, mgr, policies, ledger.NewMem(), constFencer{epoch: 1, leader: true}, nowMs)
}
```
(Add the `bytes` import to `main_test.go` if missing.)

In `main.go`, change `newMux` to accept the Manager and register the routes:
```go
func newMux(ks *keystore.Keystore, mgr *keystore.Manager, policies *policy.Store, led ledger.Ledger, fencer Fencer, nowMs func() int64) http.Handler {
	// ... existing routes unchanged ...
	mux.HandleFunc("/v1/keys", loggedRoute("provision_key", handleProvisionKey(mgr, policies, fencer)))
	mux.HandleFunc("DELETE /v1/keys/{keyId}", loggedRoute("delete_key", handleDeleteKey(mgr, policies, fencer)))
	// ... /metrics ...
}
```

- [ ] **Step 4: Implement the handlers** (in `main.go`)

```go
type provisionKeyRequest struct {
	KeyID                       string             `json:"keyId"`
	OwnerAddress                string             `json:"ownerAddress"`
	AllowedKinds                []string           `json:"allowedKinds"`
	MaxNotionalUsdc             float64            `json:"maxNotionalUsdc"`
	PerCoinMaxUsdc              map[string]float64 `json:"perCoinMaxUsdc"`
	DailyMaxNotionalUsdc        float64            `json:"dailyMaxNotionalUsdc"`
	RatePerSec                  float64            `json:"ratePerSec"`
	RateBurst                   float64            `json:"rateBurst"`
	IPRatePerSec                float64            `json:"ipRatePerSec"`
	IPRateBurst                 float64            `json:"ipRateBurst"`
	AddressDailyMaxNotionalUsdc float64            `json:"addressDailyMaxNotionalUsdc"`
}

type provisionKeyResponse struct {
	KeyID        string `json:"keyId"`
	AgentAddress string `json:"agentAddress"`
}

func policyConfigFromProvision(req provisionKeyRequest) policy.Config {
	allowed := make(map[string]bool, len(req.AllowedKinds))
	for _, k := range req.AllowedKinds {
		allowed[k] = true
	}
	return policy.Config{
		AllowedKinds:                allowed,
		MaxNotionalUsdc:             req.MaxNotionalUsdc,
		PerCoinMaxUsdc:              req.PerCoinMaxUsdc,
		DailyMaxNotionalUsdc:        req.DailyMaxNotionalUsdc,
		RatePerSec:                  req.RatePerSec,
		RateBurst:                   req.RateBurst,
		OwnerAddress:                req.OwnerAddress,
		IPRatePerSec:                req.IPRatePerSec,
		IPRateBurst:                 req.IPRateBurst,
		AddressDailyMaxNotionalUsdc: req.AddressDailyMaxNotionalUsdc,
	}
}

// handleProvisionKey provisions (idempotently) an agent key inside the signer and binds its
// reject-first policy. Leader-gated. Never returns/logs private key material.
func handleProvisionKey(mgr *keystore.Manager, policies *policy.Store, fencer Fencer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req provisionKeyRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json: "+err.Error())
			return
		}
		if req.KeyID == "" {
			writeErr(w, http.StatusBadRequest, "missing keyId")
			return
		}
		if _, isLeader := fencer.Fence(); !isLeader {
			writeErr(w, http.StatusServiceUnavailable, "not leader")
			return
		}
		addr, ok := mgr.AgentAddress(req.KeyID)
		if !ok {
			var err error
			addr, err = mgr.Provision(r.Context(), req.KeyID)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "provision failed")
				return
			}
		}
		policies.Set(req.KeyID, policyConfigFromProvision(req))
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(provisionKeyResponse{KeyID: req.KeyID, AgentAddress: addr})
	}
}

// handleDeleteKey zeroizes+deletes an agent key and unbinds its policy. Leader-gated, idempotent.
func handleDeleteKey(mgr *keystore.Manager, policies *policy.Store, fencer Fencer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		keyID := r.PathValue("keyId")
		if keyID == "" {
			writeErr(w, http.StatusBadRequest, "missing keyId")
			return
		}
		if _, isLeader := fencer.Fence(); !isLeader {
			writeErr(w, http.StatusServiceUnavailable, "not leader")
			return
		}
		if err := mgr.Remove(r.Context(), keyID); err != nil {
			writeErr(w, http.StatusInternalServerError, "remove failed")
			return
		}
		policies.Delete(keyID)
		w.WriteHeader(http.StatusNoContent)
	}
}
```

- [ ] **Step 5: Update `buildHandler` to construct + pass the Manager**

In `buildHandler`, in the **no-DB** branch add `keyMgr := keystore.NewManager(ks, keystore.NewMemVault(), cfg.signerKEK)`; in the **DB** branch rename the existing `keyManager` local so it's returned/used (it already exists — drop the `_ = keyManager` and use it). Declare `var keyMgr *keystore.Manager` before the branch and assign in both, then pass it to `newMux`:
```go
	h := newMux(ks, keyMgr, policies, led, fencer, nowMs)
```
(In the DB branch, `keyMgr = keystore.NewManager(ks, keystorepg.New(pool), cfg.signerKEK)` and call `keyMgr.Load(ctx)`; remove the `_ = keyManager` placeholder.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && go test ./cmd/signer/ -run 'TestProvision'`
Expected: PASS (all provisioning tests).

- [ ] **Step 7: Full build + vet + tests**

Run: `cd backend && gofmt -w cmd/signer/main.go cmd/signer/main_test.go && go build ./cmd/signer && rm -f signer && go vet ./... && go test ./...`
Expected: build ok; vet clean; all tests pass.

- [ ] **Step 8: Commit**

```bash
cd backend
git add cmd/signer/main.go cmd/signer/main_test.go
git commit -m "feat(cutover-1b): POST/DELETE /v1/keys provisioning endpoints (leader-gated, policy-bound)"
```

---

### Task 3: Finish the branch

- [ ] **Step 1: Final validation**

Run: `cd backend && gofmt -l cmd/signer/ internal/policy/ && go test ./... && go vet ./... && go build ./cmd/signer && rm -f signer`
Expected: no gofmt diffs in touched dirs; all green.

- [ ] **Step 2: Push + PR** — `gh pr create --title "feat(cutover-1b): signer provisioning endpoints" --body-file <body>`. Body: `policy.Store.Delete` + Manager threaded into the mux + `POST /v1/keys` (idempotent, full policy binding, leader-gated) + `DELETE /v1/keys/{keyId}` (zeroize+unbind); scheduleCancel already supported.

- [ ] **Step 3: Code review + CI** — dispatch code-review (background; emphasize: idempotent provision never regenerates an existing key, leader-gating, no key-material leak, policy bound/unbound correctly) + `gh pr checks <n> --watch`.

- [ ] **Step 4: Merge** — clean review + green CI → `gh pr merge --squash --delete-branch`; sync main.

---

## Self-review

- **Spec coverage:** `policy.Store.Delete` (T1); Manager threaded + `POST /v1/keys` idempotent+policy-bound+leader-gated + `DELETE /v1/keys/{keyId}` zeroize+unbind (T2). `scheduleCancel` already done (noted).
- **Placeholder scan:** none — full code + commands.
- **Type consistency:** `provisionKeyRequest`/`provisionKeyResponse`, `policyConfigFromProvision`, `handleProvisionKey`/`handleDeleteKey`, `newMux(ks, mgr, policies, led, fencer, nowMs)`, `keystore.NewManager/NewMemVault` used consistently; `r.PathValue("keyId")` matches the `{keyId}` pattern.
- **Security:** idempotent provision returns the existing address (never regenerates → never invalidates an approved agent); both endpoints leader-gated; only the public address is returned; delete zeroizes via `Manager.Remove`.
