package keystore

import (
	"bytes"
	"context"
	"testing"
)

func TestManagerProvisionLoadRemove(t *testing.T) {
	ctx := context.Background()
	kek := bytes.Repeat([]byte{5}, 32)
	vault := NewMemVault()

	reg1 := New()
	m1 := NewManager(reg1, vault, kek)
	addr, err := m1.Provision(ctx, "k1")
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if len(addr) != 42 || addr[:2] != "0x" {
		t.Fatalf("bad agent address %q", addr)
	}
	if _, ok := reg1.Signer("k1"); !ok {
		t.Fatalf("signer not registered after Provision")
	}
	if got, ok := m1.AgentAddress("k1"); !ok || got != addr {
		t.Fatalf("AgentAddress = %q,%v want %q", got, ok, addr)
	}

	// A fresh Manager over the SAME vault reloads the key + resolves the same address.
	reg2 := New()
	m2 := NewManager(reg2, vault, kek)
	if err := m2.Load(ctx); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if _, ok := reg2.Signer("k1"); !ok {
		t.Fatalf("signer not registered after Load")
	}
	if got, _ := m2.AgentAddress("k1"); got != addr {
		t.Fatalf("reloaded address = %q want %q", got, addr)
	}

	// Distinct keys.
	addr2, _ := m1.Provision(ctx, "k2")
	if addr2 == addr {
		t.Fatalf("expected distinct keys to have distinct addresses")
	}

	// Remove zeroizes + deletes.
	if err := m1.Remove(ctx, "k1"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if _, ok := reg1.Signer("k1"); ok {
		t.Fatalf("signer still present after Remove")
	}
	reg3 := New()
	if err := NewManager(reg3, vault, kek).Load(ctx); err != nil {
		t.Fatal(err)
	}
	if _, ok := reg3.Signer("k1"); ok {
		t.Fatalf("removed key reappeared after reload")
	}
}
