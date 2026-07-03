package hl

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

type usVector struct {
	Name             string    `json:"name"`
	SignatureChainID string    `json:"signatureChainId"`
	HyperliquidChain string    `json:"hyperliquidChain"`
	AgentAddress     string    `json:"agentAddress"`
	AgentName        string    `json:"agentName"`
	Nonce            uint64    `json:"nonce"`
	PrivKey          string    `json:"privKey"`
	Digest           string    `json:"digest"`
	Sig              goldenSig `json:"sig"`
}

func loadUserGolden(t *testing.T) []usVector {
	t.Helper()
	raw, err := os.ReadFile("testdata/golden_usersigned.json")
	if err != nil {
		t.Fatalf("read golden_usersigned.json: %v", err)
	}
	var vs []usVector
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(vs) == 0 {
		t.Fatal("golden_usersigned.json is empty")
	}
	return vs
}

func inputOf(v usVector) ApproveAgentInput {
	return ApproveAgentInput{
		SignatureChainID: v.SignatureChainID,
		HyperliquidChain: v.HyperliquidChain,
		AgentAddress:     v.AgentAddress,
		AgentName:        v.AgentName,
		Nonce:            v.Nonce,
	}
}

func TestApproveAgentDigestGolden(t *testing.T) {
	for _, v := range loadUserGolden(t) {
		t.Run(v.Name, func(t *testing.T) {
			got, err := ApproveAgentDigest(inputOf(v))
			if err != nil {
				t.Fatalf("ApproveAgentDigest: %v", err)
			}
			if hex.EncodeToString(got[:]) != v.Digest[2:] {
				t.Fatalf("digest = 0x%s, want %s", hex.EncodeToString(got[:]), v.Digest)
			}
		})
	}
}

func TestSignApproveAgentGolden(t *testing.T) {
	for _, v := range loadUserGolden(t) {
		t.Run(v.Name, func(t *testing.T) {
			key, err := hex.DecodeString(v.PrivKey[2:])
			if err != nil {
				t.Fatalf("decode key: %v", err)
			}
			s, err := NewSigner(key)
			if err != nil {
				t.Fatalf("NewSigner: %v", err)
			}
			defer s.Close()
			sig, err := s.SignApproveAgent(inputOf(v))
			if err != nil {
				t.Fatalf("SignApproveAgent: %v", err)
			}
			gotR := "0x" + hex.EncodeToString(sig.R[:])
			gotS := "0x" + hex.EncodeToString(sig.S[:])
			if gotR != v.Sig.R || gotS != v.Sig.S || int(sig.V) != v.Sig.V {
				t.Fatalf("sig = {r:%s s:%s v:%d}, want {r:%s s:%s v:%d}", gotR, gotS, sig.V, v.Sig.R, v.Sig.S, v.Sig.V)
			}
		})
	}
}
