package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealthz(t *testing.T) {
	srv := httptest.NewServer(newMux())
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
	srv := httptest.NewServer(newMux())
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
	srv := httptest.NewServer(newMux())
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
