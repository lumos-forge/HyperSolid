package keystore

import (
	"fmt"
	"sync"
	"testing"

	"github.com/lumos-forge/hypersolid/backend/internal/hl"
)

func testKey(b byte) []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = b
	}
	return k
}

func canSign(s *hl.Signer) error {
	_, err := s.SignL1Action(hl.BuildTwapCancelAction(0, 1), 1, false)
	return err
}

func TestAddAndSign(t *testing.T) {
	ks := New()
	defer ks.Close()
	if err := ks.Add("k1", testKey(0x11)); err != nil {
		t.Fatalf("Add: %v", err)
	}
	s, ok := ks.Signer("k1")
	if !ok {
		t.Fatal("expected signer present")
	}
	if err := canSign(s); err != nil {
		t.Fatalf("sign: %v", err)
	}
}

func TestAddInvalidKey(t *testing.T) {
	ks := New()
	defer ks.Close()
	if err := ks.Add("bad", make([]byte, 16)); err == nil {
		t.Fatal("expected error for short key")
	}
	if _, ok := ks.Signer("bad"); ok {
		t.Fatal("invalid key must not be stored")
	}
}

func TestRemoveZeroizes(t *testing.T) {
	ks := New()
	defer ks.Close()
	_ = ks.Add("k1", testKey(0x22))
	s, _ := ks.Signer("k1")
	ks.Remove("k1")
	if _, ok := ks.Signer("k1"); ok {
		t.Fatal("expected removed")
	}
	if err := canSign(s); err == nil {
		t.Fatal("expected zeroized signer to fail signing")
	}
}

func TestReAddClosesOld(t *testing.T) {
	ks := New()
	defer ks.Close()
	_ = ks.Add("k1", testKey(0x33))
	old, _ := ks.Signer("k1")
	_ = ks.Add("k1", testKey(0x44))
	if err := canSign(old); err == nil {
		t.Fatal("expected old signer closed after re-add")
	}
	newS, ok := ks.Signer("k1")
	if !ok || newS == old {
		t.Fatal("expected a new signer after re-add")
	}
	if err := canSign(newS); err != nil {
		t.Fatalf("new signer should sign: %v", err)
	}
}

func TestCloseAll(t *testing.T) {
	ks := New()
	_ = ks.Add("a", testKey(0x55))
	_ = ks.Add("b", testKey(0x66))
	ks.Close()
	if _, ok := ks.Signer("a"); ok {
		t.Fatal("a should be gone")
	}
	if _, ok := ks.Signer("b"); ok {
		t.Fatal("b should be gone")
	}
}

func TestConcurrentAccess(t *testing.T) {
	ks := New()
	defer ks.Close()
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			id := fmt.Sprintf("k%d", n%8)
			_ = ks.Add(id, testKey(byte(n)))
			if s, ok := ks.Signer(id); ok {
				_ = canSign(s)
			}
			if n%3 == 0 {
				ks.Remove(id)
			}
		}(i)
	}
	wg.Wait()
}
