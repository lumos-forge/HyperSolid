package hl

import "testing"

func TestAddressFromPriv(t *testing.T) {
	priv := make([]byte, 32)
	priv[31] = 1 // secp256k1 private key = 1 → pubkey is the generator point
	got, err := AddressFromPriv(priv)
	if err != nil {
		t.Fatalf("AddressFromPriv: %v", err)
	}
	const want = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
	if got != want {
		t.Fatalf("address = %s, want %s", got, want)
	}
	if _, err := AddressFromPriv(make([]byte, 31)); err == nil {
		t.Fatalf("expected error for a 31-byte key")
	}
}
