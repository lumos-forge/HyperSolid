package hl

import (
	"encoding/json"
	"os"
	"testing"
)

type goldenSig struct {
	R string `json:"r"`
	S string `json:"s"`
	V int    `json:"v"`
}

type goldenVector struct {
	Name        string          `json:"name"`
	Kind        string          `json:"kind"`
	Params      json.RawMessage `json:"params"`
	Nonce       uint64          `json:"nonce"`
	IsTestnet   bool            `json:"isTestnet"`
	PrivKey     string          `json:"privKey"`
	ActionHash  string          `json:"actionHash"`
	AgentDigest string          `json:"agentDigest"`
	Sig         goldenSig       `json:"sig"`
}

func loadGolden(t *testing.T) []goldenVector {
	t.Helper()
	raw, err := os.ReadFile("testdata/golden.json")
	if err != nil {
		t.Fatalf("read golden.json: %v", err)
	}
	var vs []goldenVector
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatalf("parse golden.json: %v", err)
	}
	if len(vs) == 0 {
		t.Fatal("golden.json is empty")
	}
	return vs
}

func actionForVector(t *testing.T, v goldenVector) Map {
	t.Helper()
	a, err := ActionFromKind(v.Kind, v.Params)
	if err != nil {
		t.Fatalf("actionForVector(%q): %v", v.Kind, err)
	}
	return a
}

func mustJSON(t *testing.T, raw json.RawMessage, dst any) {
	t.Helper()
	if err := json.Unmarshal(raw, dst); err != nil {
		t.Fatalf("params: %v", err)
	}
}
