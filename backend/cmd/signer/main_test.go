package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/lumos-forge/hypersolid/backend/internal/keystore"
	"github.com/lumos-forge/hypersolid/backend/internal/ledger"
	"github.com/lumos-forge/hypersolid/backend/internal/policy"
	"github.com/lumos-forge/hypersolid/backend/internal/reconciler"
)

// constFencer is a test Fencer with a fixed epoch and leadership flag.
type constFencer struct {
	epoch  uint64
	leader bool
}

func (c constFencer) Fence() (uint64, bool) { return c.epoch, c.leader }

// leaderMux builds a mux with a fresh in-memory single-writer, an always-leader
// fencer (epoch 1), and the given clock (nil → real time). It reproduces the
// pre-wiring in-memory nonce+cap behavior plus the fence gate.
func leaderMux(ks *keystore.Keystore, policies *policy.Store, nowMs func() int64) http.Handler {
	return newMux(ks, policies, ledger.NewMem(), constFencer{epoch: 1, leader: true}, nowMs)
}

func TestHealthz(t *testing.T) {
	srv := httptest.NewServer(leaderMux(keystore.New(), policy.NewStore(), nil))
	defer srv.Close()
	res, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
}

func TestDigestL1Endpoint(t *testing.T) {
	srv := httptest.NewServer(leaderMux(keystore.New(), policy.NewStore(), nil))
	defer srv.Close()
	body := `{"kind":"order","params":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"nonce":1700000000000,"isTestnet":false}`
	res, err := http.Post(srv.URL+"/v1/digest/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	var out struct {
		ActionHash  string `json:"actionHash"`
		AgentDigest string `json:"agentDigest"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !strings.HasPrefix(out.ActionHash, "0x") || len(out.ActionHash) != 66 {
		t.Fatalf("bad actionHash %q", out.ActionHash)
	}
	if !strings.HasPrefix(out.AgentDigest, "0x") || len(out.AgentDigest) != 66 {
		t.Fatalf("bad agentDigest %q", out.AgentDigest)
	}
}

func TestDigestL1BadRequests(t *testing.T) {
	srv := httptest.NewServer(leaderMux(keystore.New(), policy.NewStore(), nil))
	defer srv.Close()
	r1, err := http.Post(srv.URL+"/v1/digest/l1", "application/json", strings.NewReader(`{"kind":"nope","params":{},"nonce":1,"isTestnet":false}`))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer r1.Body.Close()
	if r1.StatusCode != 400 {
		t.Fatalf("unknown kind status = %d, want 400", r1.StatusCode)
	}
	r2, err := http.Post(srv.URL+"/v1/digest/l1", "application/json", strings.NewReader(`{not json`))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer r2.Body.Close()
	if r2.StatusCode != 400 {
		t.Fatalf("bad json status = %d, want 400", r2.StatusCode)
	}
}

type goldenSig struct {
	R string `json:"r"`
	S string `json:"s"`
	V int    `json:"v"`
}

type goldenVec struct {
	Name      string          `json:"name"`
	Kind      string          `json:"kind"`
	Params    json.RawMessage `json:"params"`
	Nonce     uint64          `json:"nonce"`
	IsTestnet bool            `json:"isTestnet"`
	PrivKey   string          `json:"privKey"`
	Sig       goldenSig       `json:"sig"`
}

func loadFirstGolden(t *testing.T) goldenVec {
	t.Helper()
	raw, err := os.ReadFile("../../internal/hl/testdata/golden.json")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var vs []goldenVec
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatalf("parse golden: %v", err)
	}
	if len(vs) == 0 {
		t.Fatal("no golden vectors")
	}
	return vs[0]
}

func TestSignL1Endpoint(t *testing.T) {
	v := loadFirstGolden(t)
	key, err := hex.DecodeString(v.PrivKey[2:])
	if err != nil {
		t.Fatalf("decode key: %v", err)
	}
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", key); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{v.Kind: true}, MaxNotionalUsdc: 1e12})
	// Fixed clock = the golden nonce, so Authorize returns v.Nonce and the produced
	// signature matches the golden vector byte-for-byte.
	srv := httptest.NewServer(leaderMux(ks, policies, func() int64 { return int64(v.Nonce) }))
	defer srv.Close()
	body, _ := json.Marshal(struct {
		KeyID     string          `json:"keyId"`
		Cloid     string          `json:"cloid"`
		Kind      string          `json:"kind"`
		Params    json.RawMessage `json:"params"`
		IsTestnet bool            `json:"isTestnet"`
	}{"k1", "golden-c1", v.Kind, v.Params, v.IsTestnet})
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	var out struct {
		R     string `json:"r"`
		S     string `json:"s"`
		V     int    `json:"v"`
		Nonce uint64 `json:"nonce"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.R != v.Sig.R || out.S != v.Sig.S || out.V != v.Sig.V {
		t.Fatalf("sig = {r:%s s:%s v:%d}, want {r:%s s:%s v:%d}", out.R, out.S, out.V, v.Sig.R, v.Sig.S, v.Sig.V)
	}
	if out.Nonce != v.Nonce {
		t.Fatalf("nonce = %d, want %d (server-generated)", out.Nonce, v.Nonce)
	}
}

func TestSignL1UnknownKey(t *testing.T) {
	srv := httptest.NewServer(leaderMux(keystore.New(), policy.NewStore(), nil))
	defer srv.Close()
	body := `{"keyId":"nope","kind":"order","params":{"asset":0,"isBuy":true,"px":"1","sz":"1","reduceOnly":false,"tif":"Gtc","grouping":"na"},"nonce":1,"isTestnet":false}`
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 404 {
		t.Fatalf("status = %d, want 404", res.StatusCode)
	}
}

func TestSignL1BadKind(t *testing.T) {
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"order": true}, MaxNotionalUsdc: 1e12})
	srv := httptest.NewServer(leaderMux(ks, policies, nil))
	defer srv.Close()
	body := `{"keyId":"k1","kind":"nope","params":{},"nonce":1,"isTestnet":false}`
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("status = %d, want 403 (policy rejects unknown kind before ActionFromKind)", res.StatusCode)
	}
}

func TestSignL1DeniedWithoutPolicy(t *testing.T) {
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add: %v", err)
	}
	srv := httptest.NewServer(leaderMux(ks, policy.NewStore(), nil))
	defer srv.Close()
	body := `{"keyId":"k1","kind":"order","params":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"nonce":1,"isTestnet":false}`
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("status = %d, want 403 (default-deny without policy)", res.StatusCode)
	}
	var out struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if out.Error != "kind not allowed" {
		t.Fatalf("reason = %q, want %q", out.Error, "kind not allowed")
	}
}

func TestSignL1OverNotionalCap(t *testing.T) {
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"order": true}, MaxNotionalUsdc: 100})
	srv := httptest.NewServer(leaderMux(ks, policies, nil))
	defer srv.Close()
	body := `{"keyId":"k1","kind":"order","params":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"nonce":1,"isTestnet":false}`
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("status = %d, want 403 (over notional cap)", res.StatusCode)
	}
	var out struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if out.Error != "over notional cap" {
		t.Fatalf("reason = %q, want %q", out.Error, "over notional cap")
	}
}

func TestSignL1BadParamsAfterPolicy(t *testing.T) {
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"cancel": true}, MaxNotionalUsdc: 1e12})
	srv := httptest.NewServer(leaderMux(ks, policies, nil))
	defer srv.Close()
	body := `{"keyId":"k1","kind":"cancel","params":{"cancels":"notarray"},"nonce":1,"isTestnet":false}`
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("status = %d, want 400 (bad params after policy pass)", res.StatusCode)
	}
}

func TestSignL1ModifyOverNotionalCap(t *testing.T) {
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"modify": true}, MaxNotionalUsdc: 100})
	srv := httptest.NewServer(leaderMux(ks, policies, nil))
	defer srv.Close()
	// modify carrying an order with notional 50000*0.01 = 500 > cap 100.
	body := `{"keyId":"k1","kind":"modify","params":{"oidNum":123,"order":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc"}},"nonce":1,"isTestnet":false}`
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("status = %d, want 403 (modify over cap must be gated)", res.StatusCode)
	}
	var out struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if out.Error != "over notional cap" {
		t.Fatalf("reason = %q, want %q", out.Error, "over notional cap")
	}
}

func TestSignL1BatchModifyOverNotionalCap(t *testing.T) {
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"batchModify": true}, MaxNotionalUsdc: 100})
	srv := httptest.NewServer(leaderMux(ks, policies, nil))
	defer srv.Close()
	// two orders summing to 500 + 300 = 800 > cap 100.
	body := `{"keyId":"k1","kind":"batchModify","params":{"modifies":[{"oidNum":1,"order":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc"}},{"oidNum":2,"order":{"asset":0,"isBuy":true,"px":"30000","sz":"0.01","reduceOnly":false,"tif":"Gtc"}}]},"nonce":1,"isTestnet":false}`
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("status = %d, want 403 (batchModify sum over cap must be gated)", res.StatusCode)
	}
}

func TestSignL1BatchModifyNegativeLegMasking(t *testing.T) {
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"batchModify": true}, MaxNotionalUsdc: 100})
	srv := httptest.NewServer(leaderMux(ks, policies, nil))
	defer srv.Close()
	// A +50000 leg (over cap 100) masked by a negative leg so the naive sum is 40.
	// Must NOT be allowed: the negative leg is malformed → fail closed.
	body := `{"keyId":"k1","kind":"batchModify","params":{"modifies":[{"oidNum":1,"order":{"asset":0,"isBuy":true,"px":"50000","sz":"1","reduceOnly":false,"tif":"Gtc"}},{"oidNum":2,"order":{"asset":0,"isBuy":true,"px":"-49960","sz":"1","reduceOnly":false,"tif":"Gtc"}}]},"nonce":1,"isTestnet":false}`
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("status = %d, want 403 (negative leg must fail closed, not mask an over-cap leg)", res.StatusCode)
	}
	var out struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if out.Error != "invalid notional" {
		t.Fatalf("reason = %q, want %q", out.Error, "invalid notional")
	}
}

func TestSignL1OrderNegativePriceRejected(t *testing.T) {
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"order": true}, MaxNotionalUsdc: 1e12})
	srv := httptest.NewServer(leaderMux(ks, policies, nil))
	defer srv.Close()
	// Negative px AND negative sz would multiply to a positive product; must fail closed.
	body := `{"keyId":"k1","kind":"order","params":{"asset":0,"isBuy":true,"px":"-50000","sz":"-1","reduceOnly":false,"tif":"Gtc","grouping":"na"},"nonce":1,"isTestnet":false}`
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("status = %d, want 403 (negative px/sz must fail closed)", res.StatusCode)
	}
	var out struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if out.Error != "invalid notional" {
		t.Fatalf("reason = %q, want %q", out.Error, "invalid notional")
	}
}

func TestSignL1GeneratesMonotonicNonce(t *testing.T) {
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"order": true}, MaxNotionalUsdc: 1e12})
	srv := httptest.NewServer(leaderMux(ks, policies, func() int64 { return 1700000000000 }))
	defer srv.Close()
	sign := func(cloid string) uint64 {
		body := `{"keyId":"k1","cloid":"` + cloid + `","kind":"order","params":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"isTestnet":false}`
		res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			t.Fatalf("status = %d, want 200", res.StatusCode)
		}
		var out struct {
			Nonce uint64 `json:"nonce"`
		}
		if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return out.Nonce
	}
	n1 := sign("monotonic-c1")
	n2 := sign("monotonic-c2")
	if n1 != 1700000000000 {
		t.Fatalf("n1 = %d, want 1700000000000", n1)
	}
	if n2 != n1+1 {
		t.Fatalf("n2 = %d, want %d (strictly increasing, server single-writer)", n2, n1+1)
	}
}

func TestSignL1DailyCapExceeded(t *testing.T) {
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	// Per-order cap is generous (1e12); the DAILY cap is 600 and each order is 500.
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
	if s := post("dailycap-c1"); s != 200 {
		t.Fatalf("first sign status = %d, want 200 (500 <= daily cap 600)", s)
	}
	body := `{"keyId":"k1","cloid":"dailycap-c2","kind":"order","params":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"isTestnet":false}`
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("second sign status = %d, want 403 (500+500 > daily cap 600)", res.StatusCode)
	}
	var out struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if out.Error != "daily cap exceeded" {
		t.Fatalf("reason = %q, want %q", out.Error, "daily cap exceeded")
	}
}

func TestSignL1TwapOrderDeniedNoPrice(t *testing.T) {
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	// twapOrder is explicitly allowed and caps are generous; it must STILL be
	// denied because a TWAP has no request price and cannot be notional-checked.
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"twapOrder": true}, MaxNotionalUsdc: 1e12, DailyMaxNotionalUsdc: 1e12})
	srv := httptest.NewServer(leaderMux(ks, policies, func() int64 { return 1700000000000 }))
	defer srv.Close()
	body := `{"keyId":"k1","kind":"twapOrder","params":{"asset":0,"isBuy":true,"sz":"0.01","reduceOnly":false,"minutes":30,"randomize":false},"isTestnet":false}`
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("twapOrder status = %d, want 403 (unpriceable size-bearing order, fail-closed)", res.StatusCode)
	}
	var out struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if out.Error != "invalid notional" {
		t.Fatalf("reason = %q, want %q", out.Error, "invalid notional")
	}
}

func TestSignL1NonLeader503(t *testing.T) {
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"order": true}, MaxNotionalUsdc: 1e12})
	// A non-leader must refuse to sign (503) even for an otherwise-valid request.
	srv := httptest.NewServer(newMux(ks, policies, ledger.NewMem(), constFencer{epoch: 1, leader: false}, nil))
	defer srv.Close()
	body := `{"keyId":"k1","kind":"order","params":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"isTestnet":false}`
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 503 {
		t.Fatalf("status = %d, want 503 (not leader)", res.StatusCode)
	}
	var out struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if out.Error != "not leader" {
		t.Fatalf("reason = %q, want %q", out.Error, "not leader")
	}
}

func TestSignL1FencedConflict(t *testing.T) {
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", bytes.Repeat([]byte{0x11}, 32)); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"order": true}, MaxNotionalUsdc: 1e12})
	// A newer leader has already advanced this key's fence to 5 in the ledger's
	// single-writer state.
	auth := ledger.NewMem()
	if _, err := auth.Authorize(context.Background(), ledger.Request{
		KeyID: "k1", Cloid: "seed", Digest: [32]byte{9}, Fence: 5, Notional: 0, DailyCap: 0, NowMs: 1700000000000,
	}); err != nil {
		t.Fatalf("seed fence: %v", err)
	}
	srv := httptest.NewServer(newMux(ks, policies, auth, constFencer{epoch: 1, leader: true}, func() int64 { return 1700000000000 }))
	defer srv.Close()
	body := `{"keyId":"k1","cloid":"req-c1","kind":"order","params":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"isTestnet":false}`
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 409 {
		t.Fatalf("status = %d, want 409 (stale fence)", res.StatusCode)
	}
	var out struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if out.Error != "fenced" {
		t.Fatalf("reason = %q, want %q", out.Error, "fenced")
	}
}

func TestBuildHandlerInMemory(t *testing.T) {
	h, cleanup, err := buildHandler(context.Background(), config{}, keystore.New(), policy.NewStore())
	if err != nil {
		t.Fatalf("buildHandler: %v", err)
	}
	defer cleanup()
	srv := httptest.NewServer(h)
	defer srv.Close()

	res, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatalf("healthz: %v", err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("healthz status = %d, want 200", res.StatusCode)
	}
	// The sign route is wired; an unknown key returns 404 (empty keystore).
	body := `{"keyId":"nope","kind":"order","params":{"asset":0,"isBuy":true,"px":"1","sz":"1","reduceOnly":false,"tif":"Gtc","grouping":"na"},"isTestnet":false}`
	sr, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	sr.Body.Close()
	if sr.StatusCode != 404 {
		t.Fatalf("sign unknown key status = %d, want 404", sr.StatusCode)
	}
}

func TestSignL1IdempotentReplay(t *testing.T) {
	v := loadFirstGolden(t)
	key, err := hex.DecodeString(v.PrivKey[2:])
	if err != nil {
		t.Fatalf("decode key: %v", err)
	}
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", key); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{v.Kind: true}, MaxNotionalUsdc: 1e12})
	srv := httptest.NewServer(leaderMux(ks, policies, func() int64 { return int64(v.Nonce) }))
	defer srv.Close()

	type out struct {
		R         string `json:"r"`
		S         string `json:"s"`
		V         int    `json:"v"`
		Nonce     uint64 `json:"nonce"`
		Duplicate bool   `json:"duplicate"`
	}
	post := func(cloid string) (int, out) {
		body, _ := json.Marshal(map[string]any{"keyId": "k1", "cloid": cloid, "kind": v.Kind, "params": v.Params, "isTestnet": v.IsTestnet})
		res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		defer res.Body.Close()
		var o out
		_ = json.NewDecoder(res.Body).Decode(&o)
		return res.StatusCode, o
	}

	code1, o1 := post("c1")
	if code1 != 200 || o1.Duplicate {
		t.Fatalf("first: code=%d dup=%v, want 200 dup=false", code1, o1.Duplicate)
	}
	code2, o2 := post("c1")
	if code2 != 200 || !o2.Duplicate {
		t.Fatalf("replay: code=%d dup=%v, want 200 dup=true", code2, o2.Duplicate)
	}
	if o2.Nonce != o1.Nonce || o2.R != o1.R || o2.S != o1.S || o2.V != o1.V {
		t.Fatalf("replay sig/nonce differ: o1=%+v o2=%+v", o1, o2)
	}
}

func TestSignL1CloidReuseConflict(t *testing.T) {
	v := loadFirstGolden(t)
	key, _ := hex.DecodeString(v.PrivKey[2:])
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", key); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"order": true}, MaxNotionalUsdc: 1e12})
	srv := httptest.NewServer(leaderMux(ks, policies, func() int64 { return int64(v.Nonce) }))
	defer srv.Close()

	post := func(px string) int {
		body := `{"keyId":"k1","cloid":"cx","kind":"order","params":{"asset":0,"isBuy":true,"px":"` + px + `","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"isTestnet":false}`
		res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		defer res.Body.Close()
		return res.StatusCode
	}
	if c := post("50000"); c != 200 {
		t.Fatalf("first px status = %d, want 200", c)
	}
	if c := post("51000"); c != 409 {
		t.Fatalf("reuse (same cloid, different intent) status = %d, want 409", c)
	}
}

func TestSignL1MissingCloid(t *testing.T) {
	v := loadFirstGolden(t)
	key, _ := hex.DecodeString(v.PrivKey[2:])
	ks := keystore.New()
	defer ks.Close()
	if err := ks.Add("k1", key); err != nil {
		t.Fatalf("add: %v", err)
	}
	policies := policy.NewStore()
	policies.Set("k1", policy.Config{AllowedKinds: map[string]bool{"order": true}, MaxNotionalUsdc: 1e12})
	srv := httptest.NewServer(leaderMux(ks, policies, func() int64 { return int64(v.Nonce) }))
	defer srv.Close()
	body := `{"keyId":"k1","kind":"order","params":{"asset":0,"isBuy":true,"px":"50000","sz":"0.01","reduceOnly":false,"tif":"Gtc","grouping":"na"},"isTestnet":false}`
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("missing cloid status = %d, want 400", res.StatusCode)
	}
}

func reconcileMux(led ledger.Ledger) http.Handler {
	return newMux(keystore.New(), policy.NewStore(), led, constFencer{epoch: 1, leader: true}, func() int64 { return 1700000000000 })
}

func TestReconcileHappyPath(t *testing.T) {
	led := ledger.NewMem()
	if _, err := led.Authorize(context.Background(), ledger.Request{KeyID: "k", Cloid: "c1", Digest: [32]byte{1}, Fence: 1, NowMs: 1700000000000}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	srv := httptest.NewServer(reconcileMux(led))
	defer srv.Close()
	res, err := http.Post(srv.URL+"/v1/reconcile", "application/json", strings.NewReader(`{"keyId":"k","cloid":"c1","status":"submitted"}`))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	var out struct {
		Status string `json:"status"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if out.Status != "submitted" {
		t.Fatalf("status = %q, want submitted", out.Status)
	}
}

func TestReconcileUnknownIntent(t *testing.T) {
	srv := httptest.NewServer(reconcileMux(ledger.NewMem()))
	defer srv.Close()
	res, err := http.Post(srv.URL+"/v1/reconcile", "application/json", strings.NewReader(`{"keyId":"k","cloid":"nope","status":"submitted"}`))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 404 {
		t.Fatalf("status = %d, want 404", res.StatusCode)
	}
}

func TestReconcileInvalidTransition(t *testing.T) {
	led := ledger.NewMem()
	_, _ = led.Authorize(context.Background(), ledger.Request{KeyID: "k", Cloid: "c1", Digest: [32]byte{1}, Fence: 1, NowMs: 1700000000000})
	srv := httptest.NewServer(reconcileMux(led))
	defer srv.Close()
	// signed->canceled is not an allowed edge (signed may go to submitted/open/filled/rejected).
	res, err := http.Post(srv.URL+"/v1/reconcile", "application/json", strings.NewReader(`{"keyId":"k","cloid":"c1","status":"canceled"}`))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 409 {
		t.Fatalf("status = %d, want 409", res.StatusCode)
	}
}

func TestReconcileBadStatus(t *testing.T) {
	led := ledger.NewMem()
	_, _ = led.Authorize(context.Background(), ledger.Request{KeyID: "k", Cloid: "c1", Digest: [32]byte{1}, Fence: 1, NowMs: 1700000000000})
	srv := httptest.NewServer(reconcileMux(led))
	defer srv.Close()
	res, err := http.Post(srv.URL+"/v1/reconcile", "application/json", strings.NewReader(`{"keyId":"k","cloid":"c1","status":"bogus"}`))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("status = %d, want 400 (bad status)", res.StatusCode)
	}
}

func TestReconcileBadJSONAndMethod(t *testing.T) {
	srv := httptest.NewServer(reconcileMux(ledger.NewMem()))
	defer srv.Close()
	res, err := http.Post(srv.URL+"/v1/reconcile", "application/json", strings.NewReader(`{bad`))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("bad json status = %d, want 400", res.StatusCode)
	}
	res2, err := http.Get(srv.URL + "/v1/reconcile")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	res2.Body.Close()
	if res2.StatusCode != 405 {
		t.Fatalf("GET status = %d, want 405", res2.StatusCode)
	}
}

func TestOrphansEndpoint(t *testing.T) {
	led := ledger.NewMem()
	ctx := context.Background()
	for _, c := range []string{"a", "b", "term"} {
		if _, err := led.Authorize(ctx, ledger.Request{KeyID: "k", Cloid: c, Digest: [32]byte{1}, Fence: 1, NowMs: 1700000000000}); err != nil {
			t.Fatalf("seed %s: %v", c, err)
		}
	}
	if _, err := led.Reconcile(ctx, "k", "term", ledger.StatusSubmitted); err != nil {
		t.Fatalf("term->submitted: %v", err)
	}
	if _, err := led.Reconcile(ctx, "k", "term", ledger.StatusFilled); err != nil {
		t.Fatalf("term->filled: %v", err)
	}
	srv := httptest.NewServer(reconcileMux(led))
	defer srv.Close()

	res, err := http.Get(srv.URL + "/v1/orphans?olderThanMs=4000000000000")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	var out struct {
		Orphans []struct {
			KeyID  string `json:"keyId"`
			Cloid  string `json:"cloid"`
			Status string `json:"status"`
		} `json:"orphans"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	got := map[string]string{}
	for _, o := range out.Orphans {
		got[o.Cloid] = o.Status
	}
	if len(got) != 2 || got["a"] != "signed" || got["b"] != "signed" {
		t.Fatalf("orphans = %+v; want {a:signed, b:signed} (term excluded)", got)
	}

	res2, err := http.Get(srv.URL + "/v1/orphans?olderThanMs=1000000000")
	if err != nil {
		t.Fatalf("get2: %v", err)
	}
	defer res2.Body.Close()
	var out2 struct {
		Orphans []any `json:"orphans"`
	}
	if err := json.NewDecoder(res2.Body).Decode(&out2); err != nil {
		t.Fatalf("decode2: %v", err)
	}
	if out2.Orphans == nil || len(out2.Orphans) != 0 {
		t.Fatalf("orphans(past) = %+v; want empty non-nil array", out2.Orphans)
	}
}

func TestOrphansBadParamAndMethod(t *testing.T) {
	srv := httptest.NewServer(reconcileMux(ledger.NewMem()))
	defer srv.Close()
	res, _ := http.Get(srv.URL + "/v1/orphans")
	res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("missing param status = %d, want 400", res.StatusCode)
	}
	res2, _ := http.Get(srv.URL + "/v1/orphans?olderThanMs=abc")
	res2.Body.Close()
	if res2.StatusCode != 400 {
		t.Fatalf("bad param status = %d, want 400", res2.StatusCode)
	}
	res3, _ := http.Post(srv.URL+"/v1/orphans", "application/json", strings.NewReader(`{}`))
	res3.Body.Close()
	if res3.StatusCode != 405 {
		t.Fatalf("POST status = %d, want 405", res3.StatusCode)
	}
}

func TestParseAccounts(t *testing.T) {
	got := parseAccounts("k1=0xabc, k2 = 0xdef ")
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	if got[0].KeyID != "k1" || got[0].Address != "0xabc" {
		t.Fatalf("got[0] = %+v", got[0])
	}
	if got[1].KeyID != "k2" || got[1].Address != "0xdef" {
		t.Fatalf("got[1] = %+v", got[1])
	}
	if a := parseAccounts(""); a != nil {
		t.Fatalf("empty = %+v, want nil", a)
	}
	m := parseAccounts("bad,=x,y=,a=b")
	if len(m) != 1 || m[0].KeyID != "a" || m[0].Address != "b" {
		t.Fatalf("malformed-filter = %+v, want [a=b]", m)
	}
}

func TestBuildHandlerStartsReconciler(t *testing.T) {
	polled := make(chan struct{}, 8)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		select {
		case polled <- struct{}{}:
		default:
		}
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	cfg := config{
		hlInfoURL:         srv.URL,
		reconcileAccounts: []reconciler.Account{{KeyID: "k", Address: "0xacc"}},
		reconcileInterval: time.Millisecond,
		hlTimeout:         time.Second,
	}
	h, cleanup, err := buildHandler(context.Background(), cfg, keystore.New(), policy.NewStore())
	if err != nil {
		t.Fatalf("buildHandler: %v", err)
	}
	defer cleanup()
	if h == nil {
		t.Fatal("nil handler")
	}
	select {
	case <-polled:
	case <-time.After(2 * time.Second):
		t.Fatal("reconciler did not poll HL (loop not started or leader gate blocked)")
	}
}
