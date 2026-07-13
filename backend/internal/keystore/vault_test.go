package keystore

import (
	"context"
	"testing"
)

func TestMemVaultPutListDelete(t *testing.T) {
	ctx := context.Background()
	v := NewMemVault()
	if err := v.Put(ctx, Record{KeyID: "k1", AgentAddress: "0xabc", EncPriv: []byte{1}}); err != nil {
		t.Fatal(err)
	}
	if err := v.Put(ctx, Record{KeyID: "k1", AgentAddress: "0xdef", EncPriv: []byte{2}}); err != nil {
		t.Fatal(err) // upsert
	}
	recs, err := v.List(ctx)
	if err != nil || len(recs) != 1 || recs[0].AgentAddress != "0xdef" {
		t.Fatalf("List = %+v, %v", recs, err)
	}
	if err := v.Delete(ctx, "k1"); err != nil {
		t.Fatal(err)
	}
	if err := v.Delete(ctx, "k1"); err != nil {
		t.Fatalf("Delete must be idempotent: %v", err)
	}
	if recs, _ := v.List(ctx); len(recs) != 0 {
		t.Fatalf("expected empty after delete, got %+v", recs)
	}
}
