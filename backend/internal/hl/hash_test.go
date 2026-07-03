package hl

import (
	"encoding/hex"
	"testing"
)

func TestL1ActionHashGolden(t *testing.T) {
	for _, v := range loadGolden(t) {
		t.Run(v.Name, func(t *testing.T) {
			action := actionForVector(t, v)
			got, err := L1ActionHash(action, v.Nonce, nil, nil)
			if err != nil {
				t.Fatalf("L1ActionHash: %v", err)
			}
			want := v.ActionHash[2:]
			if hex.EncodeToString(got[:]) != want {
				t.Fatalf("actionHash = 0x%s, want 0x%s", hex.EncodeToString(got[:]), want)
			}
		})
	}
}
