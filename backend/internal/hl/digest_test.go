package hl

import (
	"encoding/hex"
	"testing"
)

func TestActionFromKindUnknown(t *testing.T) {
	if _, err := ActionFromKind("nope", []byte(`{}`)); err == nil {
		t.Fatal("expected error for unknown kind")
	}
	if _, err := ActionFromKind("order", []byte(`{not json`)); err == nil {
		t.Fatal("expected error for bad JSON")
	}
}

func TestDigestL1MatchesGolden(t *testing.T) {
	for _, v := range loadGolden(t) {
		t.Run(v.Name, func(t *testing.T) {
			ah, ad, err := DigestL1(v.Kind, v.Params, v.Nonce, v.IsTestnet)
			if err != nil {
				t.Fatalf("DigestL1: %v", err)
			}
			if "0x"+hex.EncodeToString(ah[:]) != v.ActionHash {
				t.Fatalf("actionHash = 0x%s, want %s", hex.EncodeToString(ah[:]), v.ActionHash)
			}
			if "0x"+hex.EncodeToString(ad[:]) != v.AgentDigest {
				t.Fatalf("agentDigest = 0x%s, want %s", hex.EncodeToString(ad[:]), v.AgentDigest)
			}
		})
	}
}
