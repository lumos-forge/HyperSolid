package hl

import (
	"encoding/hex"
	"testing"
)

func TestAgentDigestGolden(t *testing.T) {
	for _, v := range loadGolden(t) {
		t.Run(v.Name, func(t *testing.T) {
			var conn [32]byte
			b, err := hex.DecodeString(v.ActionHash[2:])
			if err != nil {
				t.Fatalf("decode actionHash: %v", err)
			}
			copy(conn[:], b)
			got := AgentDigest(conn, v.IsTestnet)
			want := v.AgentDigest[2:]
			if hex.EncodeToString(got[:]) != want {
				t.Fatalf("agentDigest = 0x%s, want 0x%s", hex.EncodeToString(got[:]), want)
			}
		})
	}
}
