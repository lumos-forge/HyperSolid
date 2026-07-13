package keystore

import (
	"bytes"
	"testing"
)

func TestSealOpenRoundTrip(t *testing.T) {
	kek := bytes.Repeat([]byte{7}, 32)
	priv := bytes.Repeat([]byte{9}, 32)
	blob, err := Seal(kek, priv)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if bytes.Contains(blob, priv) {
		t.Fatalf("ciphertext leaks plaintext")
	}
	got, err := Open(kek, blob)
	if err != nil || !bytes.Equal(got, priv) {
		t.Fatalf("Open = %x, %v; want %x", got, err, priv)
	}
}

func TestOpenRejectsBadKekAndTamper(t *testing.T) {
	kek := bytes.Repeat([]byte{7}, 32)
	blob, _ := Seal(kek, []byte("secret-key-material-32-bytes!!!!"))
	if _, err := Open(bytes.Repeat([]byte{8}, 32), blob); err == nil {
		t.Fatalf("expected error for a wrong KEK")
	}
	tampered := append([]byte{}, blob...)
	tampered[len(tampered)-1] ^= 0xff
	if _, err := Open(kek, tampered); err == nil {
		t.Fatalf("expected error for a tampered blob")
	}
	if _, err := Seal(bytes.Repeat([]byte{7}, 16), []byte("x")); err == nil {
		t.Fatalf("expected error for a non-32-byte KEK")
	}
}
