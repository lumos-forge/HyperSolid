package ledger

import (
	"errors"
	"testing"

	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter"
)

const tNow int64 = 1_700_000_000_000

func TestDecideFreshCloidAllocatesNonce(t *testing.T) {
	sw, rec, g, err := Decide(singlewriter.State{}, nil, Request{KeyID: "k", Cloid: "c1", Digest: [32]byte{1}, Fence: 1, NowMs: tNow})
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if g.Nonce != uint64(tNow) || g.Duplicate {
		t.Fatalf("g = %+v, want nonce %d dup false", g, uint64(tNow))
	}
	if rec.Nonce != uint64(tNow) || rec.Status != "signed" || rec.Digest != [32]byte{1} {
		t.Fatalf("rec = %+v, want nonce %d status signed digest{1}", rec, uint64(tNow))
	}
	if sw.LastNonce != uint64(tNow) {
		t.Fatalf("sw.LastNonce = %d, want %d", sw.LastNonce, uint64(tNow))
	}
}

func TestDecideMissingCloid(t *testing.T) {
	if _, _, _, err := Decide(singlewriter.State{}, nil, Request{KeyID: "k", Cloid: "", Fence: 1, NowMs: tNow}); !errors.Is(err, ErrMissingCloid) {
		t.Fatalf("err = %v, want ErrMissingCloid", err)
	}
}

func TestDecideDuplicateSameDigestReplaysNonce(t *testing.T) {
	existing := &Record{Nonce: 42, Digest: [32]byte{7}, Status: "signed"}
	sw, rec, g, err := Decide(singlewriter.State{LastNonce: 99}, existing, Request{KeyID: "k", Cloid: "c1", Digest: [32]byte{7}, Fence: 1, NowMs: tNow})
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if g.Nonce != 42 || !g.Duplicate {
		t.Fatalf("g = %+v, want nonce 42 dup true", g)
	}
	if sw.LastNonce != 99 {
		t.Fatalf("sw.LastNonce = %d, want 99 (unchanged)", sw.LastNonce)
	}
	if rec != *existing {
		t.Fatalf("rec = %+v, want unchanged %+v", rec, *existing)
	}
}

func TestDecideCloidReuseDifferentDigest(t *testing.T) {
	existing := &Record{Nonce: 42, Digest: [32]byte{7}, Status: "signed"}
	if _, _, _, err := Decide(singlewriter.State{}, existing, Request{KeyID: "k", Cloid: "c1", Digest: [32]byte{8}, Fence: 1, NowMs: tNow}); !errors.Is(err, ErrCloidReuse) {
		t.Fatalf("err = %v, want ErrCloidReuse", err)
	}
}

func TestDecidePassesThroughSingleWriterErrors(t *testing.T) {
	if _, _, _, err := Decide(singlewriter.State{Fence: 5}, nil, Request{KeyID: "k", Cloid: "c1", Fence: 4, NowMs: tNow}); !errors.Is(err, singlewriter.ErrFenced) {
		t.Fatalf("err = %v, want ErrFenced", err)
	}
	if _, _, _, err := Decide(singlewriter.State{}, nil, Request{KeyID: "k", Cloid: "c1", Fence: 1, NowMs: 0}); !errors.Is(err, singlewriter.ErrInvalidClock) {
		t.Fatalf("err = %v, want ErrInvalidClock", err)
	}
	if _, _, _, err := Decide(singlewriter.State{}, nil, Request{KeyID: "k", Cloid: "c1", Fence: 1, Notional: 2000, DailyCap: 1000, NowMs: tNow}); !errors.Is(err, singlewriter.ErrDailyCap) {
		t.Fatalf("err = %v, want ErrDailyCap", err)
	}
}
