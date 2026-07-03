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
	switch v.Kind {
	case "order":
		var p struct {
			Asset      int64  `json:"asset"`
			IsBuy      bool   `json:"isBuy"`
			Px         string `json:"px"`
			Sz         string `json:"sz"`
			ReduceOnly bool   `json:"reduceOnly"`
			Tif        string `json:"tif"`
			Grouping   string `json:"grouping"`
			Cloid      string `json:"cloid"`
		}
		mustJSON(t, v.Params, &p)
		return BuildOrderAction([]OrderInput{{Asset: p.Asset, IsBuy: p.IsBuy, Px: p.Px, Sz: p.Sz, ReduceOnly: p.ReduceOnly, Tif: p.Tif, Cloid: p.Cloid}}, p.Grouping)
	case "cancel":
		var p struct {
			Cancels []struct {
				Asset int64 `json:"asset"`
				Oid   int64 `json:"oid"`
			} `json:"cancels"`
		}
		mustJSON(t, v.Params, &p)
		ins := make([]CancelInput, len(p.Cancels))
		for i, c := range p.Cancels {
			ins[i] = CancelInput{Asset: c.Asset, Oid: c.Oid}
		}
		return BuildCancelAction(ins)
	case "twapOrder":
		var p struct {
			Asset      int64  `json:"asset"`
			IsBuy      bool   `json:"isBuy"`
			Sz         string `json:"sz"`
			ReduceOnly bool   `json:"reduceOnly"`
			Minutes    int64  `json:"minutes"`
			Randomize  bool   `json:"randomize"`
		}
		mustJSON(t, v.Params, &p)
		return BuildTwapOrderAction(p.Asset, p.IsBuy, p.Sz, p.ReduceOnly, p.Minutes, p.Randomize)
	case "twapCancel":
		var p struct {
			Asset  int64 `json:"asset"`
			TwapID int64 `json:"twapId"`
		}
		mustJSON(t, v.Params, &p)
		return BuildTwapCancelAction(p.Asset, p.TwapID)
	}
	t.Fatalf("unknown kind %q", v.Kind)
	return nil
}

func mustJSON(t *testing.T, raw json.RawMessage, dst any) {
	t.Helper()
	if err := json.Unmarshal(raw, dst); err != nil {
		t.Fatalf("params: %v", err)
	}
}
