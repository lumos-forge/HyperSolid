package hl

import (
	"encoding/hex"
	"testing"
)

func TestSignL1ActionGolden(t *testing.T) {
	for _, v := range loadGolden(t) {
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
			action := actionForVector(t, v)
			sig, err := s.SignL1Action(action, v.Nonce, v.IsTestnet)
			if err != nil {
				t.Fatalf("SignL1Action: %v", err)
			}
			gotR := "0x" + hex.EncodeToString(sig.R[:])
			gotS := "0x" + hex.EncodeToString(sig.S[:])
			if gotR != v.Sig.R || gotS != v.Sig.S || int(sig.V) != v.Sig.V {
				t.Fatalf("sig = {r:%s s:%s v:%d}, want {r:%s s:%s v:%d}", gotR, gotS, sig.V, v.Sig.R, v.Sig.S, v.Sig.V)
			}
		})
	}
}

func TestSignerCloseZeroizes(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = 0x11
	}
	s, err := NewSigner(key)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	if _, err := s.SignL1Action(BuildTwapCancelAction(0, 1), 1, false); err == nil {
		t.Fatal("expected signing after Close to fail")
	}
}
