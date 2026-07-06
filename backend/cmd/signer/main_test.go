package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/lumos-forge/hypersolid/backend/internal/keystore"
)

func TestHealthz(t *testing.T) {
	srv := httptest.NewServer(newMux(keystore.New()))
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
	srv := httptest.NewServer(newMux(keystore.New()))
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
	srv := httptest.NewServer(newMux(keystore.New()))
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
	srv := httptest.NewServer(newMux(ks))
	defer srv.Close()
	body, _ := json.Marshal(struct {
		KeyID     string          `json:"keyId"`
		Kind      string          `json:"kind"`
		Params    json.RawMessage `json:"params"`
		Nonce     uint64          `json:"nonce"`
		IsTestnet bool            `json:"isTestnet"`
	}{"k1", v.Kind, v.Params, v.Nonce, v.IsTestnet})
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	var out goldenSig
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.R != v.Sig.R || out.S != v.Sig.S || out.V != v.Sig.V {
		t.Fatalf("sig = {r:%s s:%s v:%d}, want {r:%s s:%s v:%d}", out.R, out.S, out.V, v.Sig.R, v.Sig.S, v.Sig.V)
	}
}

func TestSignL1UnknownKey(t *testing.T) {
	srv := httptest.NewServer(newMux(keystore.New()))
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
	srv := httptest.NewServer(newMux(ks))
	defer srv.Close()
	body := `{"keyId":"k1","kind":"nope","params":{},"nonce":1,"isTestnet":false}`
	res, err := http.Post(srv.URL+"/v1/sign/l1", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("status = %d, want 400", res.StatusCode)
	}
}
