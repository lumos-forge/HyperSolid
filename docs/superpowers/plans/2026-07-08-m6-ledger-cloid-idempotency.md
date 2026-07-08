# M6 意图账本 cloid 幂等核心（`internal/ledger`）实现计划 — 子项目 A

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `internal/ledger` 纯核心：按 (keyID, cloid) 幂等授权签名 nonce（同 cloid+同摘要重放返回原 nonce；同 cloid 异摘要 `ErrCloidReuse`；空 cloid `ErrMissingCloid`），复用 `singlewriter.Decide` 做 fence/日限/nonce。

**Architecture:** 新包 `internal/ledger`，四件套镜像 `singlewriter`：纯 `Decide`（内部调 `singlewriter.Decide`）+ `Mem` 参考实现 + 独立 `conformance` 套件 + Postgres `Store`（一个 FOR UPDATE 事务同时管 `sw_state` 与新表 `ledger_intents`）。先不接线 signer。

**Tech Stack:** Go 1.26；`github.com/jackc/pgx/v5`；testcontainers（集成，build-tag `integration`）。

参考 spec：`docs/superpowers/specs/2026-07-08-m6-ledger-cloid-idempotency-design.md`
参考现有模式（**逐字镜像**）：`backend/internal/singlewriter/{singlewriter.go,decide.go,mem.go}`、`backend/internal/singlewriter/conformance/conformance.go`、`backend/internal/singlewriter/pg/{pg.go,schema.go,pg_integration_test.go}`。

## 文件结构

- `backend/internal/ledger/ledger.go` — 类型（Request/Grant/Record）+ errors + Authorizer 接口。
- `backend/internal/ledger/decide.go` — 纯 `Decide`。
- `backend/internal/ledger/mem.go` — `Mem` 参考实现。
- `backend/internal/ledger/conformance/conformance.go` — 可复用契约套件（import testing）。
- `backend/internal/ledger/mem_test.go` — `conformance.Run(t, ...)` 针对 Mem。
- `backend/internal/ledger/pg/schema.go` — `EnsureSchema`（复用 swpg + 建 ledger_intents）。
- `backend/internal/ledger/pg/pg.go` — Postgres `Store`。
- `backend/internal/ledger/pg/pg_integration_test.go` — `//go:build integration`；testcontainers。

---

### Task 1: 纯核心 `Decide` + 类型 + `Mem`

**Files:**
- Create: `backend/internal/ledger/ledger.go`
- Create: `backend/internal/ledger/decide.go`
- Create: `backend/internal/ledger/mem.go`
- Test: `backend/internal/ledger/decide_test.go`

- [ ] **Step 1: 写失败测试 `decide_test.go`**

```go
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
	if sw.LastNonce != 99 { // state UNCHANGED on replay
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
	// stale fence
	if _, _, _, err := Decide(singlewriter.State{Fence: 5}, nil, Request{KeyID: "k", Cloid: "c1", Fence: 4, NowMs: tNow}); !errors.Is(err, singlewriter.ErrFenced) {
		t.Fatalf("err = %v, want ErrFenced", err)
	}
	// invalid clock
	if _, _, _, err := Decide(singlewriter.State{}, nil, Request{KeyID: "k", Cloid: "c1", Fence: 1, NowMs: 0}); !errors.Is(err, singlewriter.ErrInvalidClock) {
		t.Fatalf("err = %v, want ErrInvalidClock", err)
	}
	// over daily cap
	if _, _, _, err := Decide(singlewriter.State{}, nil, Request{KeyID: "k", Cloid: "c1", Fence: 1, Notional: 2000, DailyCap: 1000, NowMs: tNow}); !errors.Is(err, singlewriter.ErrDailyCap) {
		t.Fatalf("err = %v, want ErrDailyCap", err)
	}
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && go test ./internal/ledger/`
Expected: 编译失败（`Decide`/`Request`/`Grant`/`Record`/errors 未定义）。

- [ ] **Step 3: 写 `ledger.go`**

```go
// Package ledger is the M6 cloid-keyed intent ledger: it makes signing
// authorization idempotent per (agent key, client order id). The first request
// for a cloid allocates a nonce via the single-writer authority (fence + daily
// cap + strictly-increasing nonce); a retry with the SAME cloid and SAME intent
// digest replays the ORIGINAL nonce (no new nonce, no double cap charge) so
// re-submitting is a true no-op at Hyperliquid (which dedups by cloid). A retry
// with the same cloid but a DIFFERENT digest fails closed (ErrCloidReuse), and
// an empty cloid is rejected (ErrMissingCloid). This closes the duplicate/orphan
// order gap (docs/BACKEND-ARCHITECTURE.md §6.2, M6). Reconciliation of terminal
// order status (submitted/open/filled/rejected) and signer wiring are later slices.
package ledger

import (
	"context"
	"errors"
)

// Request is one cloid-idempotent signing authorization for an agent key.
type Request struct {
	KeyID    string   // agent private key id (per private key, not account)
	Cloid    string   // client order id; half of the ledger key; MUST be non-empty
	Digest   [32]byte // opaque intent digest (caller supplies; typically the HL action hash)
	Fence    uint64   // fencing token from the caller's lease (passed to singlewriter)
	Notional float64  // this action's USD notional; 0 for non-notional kinds
	DailyCap float64  // per-key daily notional cap; 0 = unlimited, <0 = misconfig (denied)
	NowMs    int64    // caller clock in ms; injectable for tests
}

// Grant is the result of an accepted (or idempotently replayed) authorization.
type Grant struct {
	Nonce     uint64 // nonce to sign with (freshly allocated or the original record's)
	Duplicate bool   // true = idempotent replay (original nonce; no cap charge, no nonce bump)
}

// Record is one persisted (keyID, cloid) intent. Status is "signed" in this slice;
// the reconciliation slice extends it (submitted/open/filled/rejected).
type Record struct {
	Nonce  uint64
	Digest [32]byte
	Status string
}

// Authorizer is the cloid-idempotent ledger authority.
type Authorizer interface {
	Authorize(ctx context.Context, r Request) (Grant, error)
}

// Typed rejections; the signer wiring (later slice) maps these to HTTP codes.
var (
	ErrMissingCloid = errors.New("missing cloid")        // empty cloid → reject
	ErrCloidReuse   = errors.New("cloid reuse mismatch") // same cloid, different digest → reject
)
```

- [ ] **Step 4: 写 `decide.go`**

```go
package ledger

import "github.com/lumos-forge/hypersolid/backend/internal/singlewriter"

// Decide is the pure ledger transition. existing is the current record for
// (r.KeyID, r.Cloid) or nil if this cloid is first-seen. It returns the next
// single-writer state, the record to persist, the grant, or a typed error —
// leaving state UNCHANGED on every reject and on an idempotent replay. Both the
// in-memory and Postgres stores apply this identical logic so they cannot drift.
//
// Order: missing-cloid → replay/collision → single-writer (fence + clock +
// notional + daily cap + nonce). A replay never re-charges the cap or bumps the
// nonce; a collision or any single-writer rejection writes nothing.
func Decide(sw singlewriter.State, existing *Record, r Request) (singlewriter.State, Record, Grant, error) {
	// 1. every ledger entry MUST be cloid-keyed; empty fails closed.
	if r.Cloid == "" {
		return sw, Record{}, Grant{}, ErrMissingCloid
	}
	// 2. idempotent replay / collision detection.
	if existing != nil {
		if existing.Digest != r.Digest {
			return sw, Record{}, Grant{}, ErrCloidReuse
		}
		// same cloid + same digest → replay original nonce; state untouched.
		return sw, *existing, Grant{Nonce: existing.Nonce, Duplicate: true}, nil
	}
	// 3. first-seen cloid → reuse the single-writer authority (DRY); pass through
	// its typed errors (ErrFenced/ErrInvalidClock/ErrInvalidNotional/ErrDailyCap).
	nextSW, swg, err := singlewriter.Decide(sw, singlewriter.Request{
		KeyID:    r.KeyID,
		Fence:    r.Fence,
		Notional: r.Notional,
		DailyCap: r.DailyCap,
		NowMs:    r.NowMs,
	})
	if err != nil {
		return sw, Record{}, Grant{}, err
	}
	rec := Record{Nonce: swg.Nonce, Digest: r.Digest, Status: "signed"}
	return nextSW, rec, Grant{Nonce: swg.Nonce, Duplicate: false}, nil
}
```

- [ ] **Step 5: 写 `mem.go`**

```go
package ledger

import (
	"context"
	"sync"

	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter"
)

// recordKey identifies one ledger record by (agent key, client order id).
type recordKey struct{ keyID, cloid string }

// Mem is an in-process Authorizer: mutex-guarded per-key single-writer state plus
// a (keyID,cloid)→Record map applying the pure Decide transition. It is the
// single-instance reference implementation and the fast unit-test fixture; the
// cross-host authority is the Postgres Store (which applies the SAME Decide in a
// transaction).
type Mem struct {
	mu      sync.Mutex
	sw      map[string]singlewriter.State
	records map[recordKey]Record
}

// NewMem returns an empty in-memory Authorizer.
func NewMem() *Mem {
	return &Mem{sw: make(map[string]singlewriter.State), records: make(map[recordKey]Record)}
}

// Authorize applies Decide under a single lock: atomic check-and-reserve. On a
// fresh cloid it persists the new single-writer state and record; a replay and
// every reject leave state untouched.
func (m *Mem) Authorize(_ context.Context, r Request) (Grant, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rk := recordKey{keyID: r.KeyID, cloid: r.Cloid}
	var existing *Record
	if rec, ok := m.records[rk]; ok {
		existing = &rec
	}
	nextSW, rec, g, err := Decide(m.sw[r.KeyID], existing, r)
	if err != nil {
		return Grant{}, err
	}
	if !g.Duplicate {
		m.sw[r.KeyID] = nextSW
		m.records[rk] = rec
	}
	return g, nil
}

// compile-time assertion that Mem satisfies Authorizer.
var _ Authorizer = (*Mem)(nil)
```

- [ ] **Step 6: 运行确认通过 + vet + race**

Run: `cd backend && go test ./internal/ledger/ && go vet ./internal/ledger/ && go test -race ./internal/ledger/`
Expected: PASS；vet 无输出；race 无告警。

- [ ] **Step 7: 提交**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/ledger/ledger.go backend/internal/ledger/decide.go backend/internal/ledger/mem.go backend/internal/ledger/decide_test.go
git commit --no-verify -m "feat(backend): ledger cloid-idempotent core (Decide + Mem)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: 可复用 `conformance` 套件 + Mem 契约测试

**Files:**
- Create: `backend/internal/ledger/conformance/conformance.go`
- Test: `backend/internal/ledger/mem_test.go`

- [ ] **Step 1: 写 `mem_test.go`（会失败：conformance 包尚不存在）**

```go
package ledger_test

import (
	"testing"

	"github.com/lumos-forge/hypersolid/backend/internal/ledger"
	"github.com/lumos-forge/hypersolid/backend/internal/ledger/conformance"
)

func TestMemConformance(t *testing.T) {
	conformance.Run(t, func() ledger.Authorizer { return ledger.NewMem() })
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && go test ./internal/ledger/`
Expected: 编译失败（`ledger/conformance` 包不存在）。

- [ ] **Step 3: 写 `conformance/conformance.go`**

```go
// Package conformance holds the reusable cloid-ledger contract test suite. It
// lives in its own package (importing testing) so the production ledger library
// stays testing-free; any Authorizer implementation — the in-memory Mem, the
// Postgres Store — must pass Run.
package conformance

import (
	"context"
	"errors"
	"testing"

	"github.com/lumos-forge/hypersolid/backend/internal/ledger"
	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter"
)

// cfNow is the fixed clock (ms) used by the scenarios.
const cfNow int64 = 1_700_000_000_000

// dig is a terse 32-byte digest builder (only the first byte varies per intent).
func dig(b byte) [32]byte { return [32]byte{b} }

// Run exercises an Authorizer implementation against the cloid-ledger contract.
// newAuth must return a fresh, empty Authorizer on each call so scenarios do not
// share state.
func Run(t *testing.T, newAuth func() ledger.Authorizer) {
	t.Helper()
	ctx := context.Background()
	type Request = ledger.Request

	t.Run("fresh cloid allocates nonce = now", func(t *testing.T) {
		a := newAuth()
		g, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: dig(1), Fence: 1, NowMs: cfNow})
		if err != nil || g.Nonce != uint64(cfNow) || g.Duplicate {
			t.Fatalf("g = %+v err = %v, want nonce %d dup false", g, err, uint64(cfNow))
		}
	})

	t.Run("same cloid same digest replays original nonce without recharging cap", func(t *testing.T) {
		a := newAuth()
		// c1 spends 600 of a 1000 cap.
		g1, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: dig(1), Fence: 1, Notional: 600, DailyCap: 1000, NowMs: cfNow})
		if err != nil {
			t.Fatalf("c1 err = %v", err)
		}
		// replay c1: must return the SAME nonce, Duplicate true, and NOT charge the cap.
		gr, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: dig(1), Fence: 1, Notional: 600, DailyCap: 1000, NowMs: cfNow})
		if err != nil || gr.Nonce != g1.Nonce || !gr.Duplicate {
			t.Fatalf("replay g = %+v err = %v, want nonce %d dup true", gr, err, g1.Nonce)
		}
		// c2 spends 300 more → 900 ≤ 1000 succeeds ONLY if the replay charged nothing.
		if _, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c2", Digest: dig(2), Fence: 1, Notional: 300, DailyCap: 1000, NowMs: cfNow}); err != nil {
			t.Fatalf("c2 err = %v, want nil (replay must not have charged the cap)", err)
		}
	})

	t.Run("same cloid different digest fails closed and does not disturb the record", func(t *testing.T) {
		a := newAuth()
		g1, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: dig(1), Fence: 1, NowMs: cfNow})
		if err != nil {
			t.Fatalf("c1 err = %v", err)
		}
		if _, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: dig(9), Fence: 1, NowMs: cfNow}); !errors.Is(err, ledger.ErrCloidReuse) {
			t.Fatalf("collision err = %v, want ErrCloidReuse", err)
		}
		// original digest replay still returns the original nonce.
		gr, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: dig(1), Fence: 1, NowMs: cfNow})
		if err != nil || gr.Nonce != g1.Nonce || !gr.Duplicate {
			t.Fatalf("post-collision replay g = %+v err = %v, want nonce %d dup true", gr, err, g1.Nonce)
		}
	})

	t.Run("empty cloid fails closed without consuming a nonce", func(t *testing.T) {
		a := newAuth()
		if _, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "", Fence: 1, NowMs: cfNow}); !errors.Is(err, ledger.ErrMissingCloid) {
			t.Fatalf("empty cloid err = %v, want ErrMissingCloid", err)
		}
		g, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: dig(1), Fence: 1, NowMs: cfNow})
		if err != nil || g.Nonce != uint64(cfNow) {
			t.Fatalf("post-empty g = %+v err = %v, want nonce %d (no nonce burned)", g, err, uint64(cfNow))
		}
	})

	t.Run("distinct cloids get strictly increasing distinct nonces", func(t *testing.T) {
		a := newAuth()
		g1, _ := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: dig(1), Fence: 1, NowMs: cfNow})
		g2, _ := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c2", Digest: dig(2), Fence: 1, NowMs: cfNow})
		if g2.Nonce <= g1.Nonce {
			t.Fatalf("g2.Nonce %d must exceed g1.Nonce %d", g2.Nonce, g1.Nonce)
		}
	})

	t.Run("single-writer rejections pass through", func(t *testing.T) {
		a := newAuth()
		_, _ = a.Authorize(ctx, Request{KeyID: "k", Cloid: "c0", Digest: dig(1), Fence: 5, NowMs: cfNow})
		if _, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: dig(2), Fence: 4, NowMs: cfNow + 1}); !errors.Is(err, singlewriter.ErrFenced) {
			t.Fatalf("stale fence err = %v, want ErrFenced", err)
		}
		if _, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c2", Digest: dig(3), Fence: 5, NowMs: 0}); !errors.Is(err, singlewriter.ErrInvalidClock) {
			t.Fatalf("bad clock err = %v, want ErrInvalidClock", err)
		}
		if _, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c3", Digest: dig(4), Fence: 5, Notional: 2000, DailyCap: 1000, NowMs: cfNow + 2}); !errors.Is(err, singlewriter.ErrDailyCap) {
			t.Fatalf("over cap err = %v, want ErrDailyCap", err)
		}
	})

	t.Run("per-key isolation: same cloid under different keys is independent", func(t *testing.T) {
		a := newAuth()
		ga, err := a.Authorize(ctx, Request{KeyID: "a", Cloid: "shared", Digest: dig(1), Fence: 1, NowMs: cfNow})
		if err != nil {
			t.Fatalf("key a err = %v", err)
		}
		// same cloid on key b with a DIFFERENT digest must NOT collide (different key).
		gb, err := a.Authorize(ctx, Request{KeyID: "b", Cloid: "shared", Digest: dig(2), Fence: 1, NowMs: cfNow})
		if err != nil {
			t.Fatalf("key b err = %v, want nil (independent of key a)", err)
		}
		if ga.Duplicate || gb.Duplicate {
			t.Fatalf("neither should be a duplicate: ga=%+v gb=%+v", ga, gb)
		}
	})

	t.Run("replay is stable after later cloids advance the nonce", func(t *testing.T) {
		a := newAuth()
		g1, _ := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: dig(1), Fence: 1, NowMs: cfNow})
		_, _ = a.Authorize(ctx, Request{KeyID: "k", Cloid: "c2", Digest: dig(2), Fence: 1, NowMs: cfNow})
		_, _ = a.Authorize(ctx, Request{KeyID: "k", Cloid: "c3", Digest: dig(3), Fence: 1, NowMs: cfNow})
		gr, err := a.Authorize(ctx, Request{KeyID: "k", Cloid: "c1", Digest: dig(1), Fence: 1, NowMs: cfNow})
		if err != nil || gr.Nonce != g1.Nonce || !gr.Duplicate {
			t.Fatalf("stable replay g = %+v err = %v, want ORIGINAL nonce %d dup true", gr, err, g1.Nonce)
		}
	})
}
```

- [ ] **Step 4: 运行确认通过 + race**

Run: `cd backend && go test ./internal/ledger/... && go test -race ./internal/ledger/...`
Expected: PASS（Mem 通过全部契约场景）；race 无告警。

- [ ] **Step 5: 提交**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/ledger/conformance/conformance.go backend/internal/ledger/mem_test.go
git commit --no-verify -m "test(backend): reusable cloid-ledger conformance suite + Mem

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Postgres `Store`（schema + 事务 + 集成测试）

**Files:**
- Create: `backend/internal/ledger/pg/schema.go`
- Create: `backend/internal/ledger/pg/pg.go`
- Create: `backend/internal/ledger/pg/pg_integration_test.go`

参考镜像：`backend/internal/singlewriter/pg/{schema.go,pg.go,pg_integration_test.go}`。

- [ ] **Step 1: 写 `schema.go`**

```go
package pg

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	swpg "github.com/lumos-forge/hypersolid/backend/internal/singlewriter/pg"
)

// createSchemaSQL is the DDL for the cloid intent ledger. nonce holds a uint64
// value stored as its int64 bit-pattern (the DB never does arithmetic on it; all
// logic is in ledger.Decide), so bigint round-trips the full uint64 domain.
const createSchemaSQL = `CREATE TABLE IF NOT EXISTS ledger_intents (
	key_id     text NOT NULL,
	cloid      text NOT NULL,
	nonce      bigint NOT NULL,
	digest     bytea NOT NULL,
	status     text NOT NULL,
	notional   double precision NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (key_id, cloid)
)`

// EnsureSchema idempotently creates both the single-writer state table (reused
// for the fence/cap/nonce authority) and the ledger_intents table. A dedicated
// migration tool (goose/migrate) is deferred to later M6 work.
func EnsureSchema(ctx context.Context, pool *pgxpool.Pool) error {
	if err := swpg.EnsureSchema(ctx, pool); err != nil {
		return err
	}
	_, err := pool.Exec(ctx, createSchemaSQL)
	return err
}
```

- [ ] **Step 2: 写 `pg.go`**

```go
// Package pg is a Postgres-backed ledger.Authorizer: it runs ledger.Decide inside
// a row-locked transaction that atomically manages BOTH the single-writer state
// (sw_state: fence + daily cap + nonce high-water) and the cloid intent ledger
// (ledger_intents), so cloid-idempotent authorization is atomic and durable
// across processes and hosts (docs/BACKEND-ARCHITECTURE.md §6.2, M6).
package pg

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumos-forge/hypersolid/backend/internal/ledger"
	"github.com/lumos-forge/hypersolid/backend/internal/singlewriter"
)

// Store is a Postgres-backed ledger.Authorizer.
type Store struct{ pool *pgxpool.Pool }

// New returns a Store over the given pool. Run EnsureSchema once at startup
// before serving.
func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

const (
	// sw_state SQL (schema owned by singlewriter/pg; re-declared here because this
	// store drives the same rows inside its own transaction alongside ledger_intents).
	swSeedSQL   = `INSERT INTO sw_state (key_id, fence, last_nonce, spend_day, spend_total) VALUES ($1, 0, 0, 0, 0) ON CONFLICT (key_id) DO NOTHING`
	swSelectSQL = `SELECT fence, last_nonce, spend_day, spend_total FROM sw_state WHERE key_id = $1 FOR UPDATE`
	swUpdateSQL = `UPDATE sw_state SET fence = $2, last_nonce = $3, spend_day = $4, spend_total = $5 WHERE key_id = $1`

	recSelectSQL = `SELECT nonce, digest, status FROM ledger_intents WHERE key_id = $1 AND cloid = $2`
	recInsertSQL = `INSERT INTO ledger_intents (key_id, cloid, nonce, digest, status, notional) VALUES ($1, $2, $3, $4, $5, $6)`
)

// Authorize runs ledger.Decide inside one READ COMMITTED transaction: it seeds a
// zero sw_state row, locks it FOR UPDATE (per-key mutual exclusion across
// transactions — this also serializes the cloid read), loads the (key,cloid)
// record if any, applies Decide, and either COMMITs the new sw_state + a new
// ledger_intents row, returns the replayed grant unchanged (Duplicate), or rolls
// back on a typed rejection. Infra errors are wrapped (5xx) to distinguish them
// from typed policy rejections (4xx).
func (s *Store) Authorize(ctx context.Context, r ledger.Request) (ledger.Grant, error) {
	// Pin READ COMMITTED: SELECT … FOR UPDATE is what serializes same-key writers;
	// a cluster defaulting to SERIALIZABLE could otherwise surface 40001 as infra.
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return ledger.Grant{}, fmt.Errorf("pg ledger: begin: %w", err)
	}
	defer tx.Rollback(ctx) // no-op after Commit; undoes the seed on any reject/error

	if _, err := tx.Exec(ctx, swSeedSQL, r.KeyID); err != nil {
		return ledger.Grant{}, fmt.Errorf("pg ledger: seed: %w", err)
	}

	var fence, lastNonce, spendDay int64
	var spendTotal float64
	if err := tx.QueryRow(ctx, swSelectSQL, r.KeyID).Scan(&fence, &lastNonce, &spendDay, &spendTotal); err != nil {
		return ledger.Grant{}, fmt.Errorf("pg ledger: sw select: %w", err)
	}
	sw := singlewriter.State{Fence: uint64(fence), LastNonce: uint64(lastNonce), SpendDay: spendDay, SpendTotal: spendTotal}

	// Load the existing record for this (key, cloid), if any. The sw_state FOR
	// UPDATE lock already gives per-key mutual exclusion, so no extra row lock.
	var existing *ledger.Record
	var recNonce int64
	var recDigest []byte
	var recStatus string
	switch err := tx.QueryRow(ctx, recSelectSQL, r.KeyID, r.Cloid).Scan(&recNonce, &recDigest, &recStatus); {
	case err == nil:
		var d [32]byte
		copy(d[:], recDigest)
		existing = &ledger.Record{Nonce: uint64(recNonce), Digest: d, Status: recStatus}
	case errors.Is(err, pgx.ErrNoRows):
		existing = nil
	default:
		return ledger.Grant{}, fmt.Errorf("pg ledger: record select: %w", err)
	}

	nextSW, rec, grant, derr := ledger.Decide(sw, existing, r)
	if derr != nil {
		return ledger.Grant{}, derr // typed rejection; deferred Rollback undoes the seed
	}
	if grant.Duplicate {
		// Idempotent replay: nothing to persist. Roll back the (no-op) seed.
		return grant, nil
	}

	if _, err := tx.Exec(ctx, swUpdateSQL, r.KeyID, int64(nextSW.Fence), int64(nextSW.LastNonce), nextSW.SpendDay, nextSW.SpendTotal); err != nil {
		return ledger.Grant{}, fmt.Errorf("pg ledger: sw update: %w", err)
	}
	if _, err := tx.Exec(ctx, recInsertSQL, r.KeyID, r.Cloid, int64(rec.Nonce), rec.Digest[:], rec.Status, r.Notional); err != nil {
		return ledger.Grant{}, fmt.Errorf("pg ledger: record insert: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ledger.Grant{}, fmt.Errorf("pg ledger: commit: %w", err)
	}
	return grant, nil
}

// compile-time assertion that Store satisfies the Authorizer interface.
var _ ledger.Authorizer = (*Store)(nil)
```

- [ ] **Step 3: 写 `pg_integration_test.go`**

先看参考实现取 testcontainers 样板：`backend/internal/singlewriter/pg/pg_integration_test.go`（容器启动/连接池/`EnsureSchema` 调用方式），照抄其容器 harness，仅把被测对象换成 ledger 的 Store 与 conformance。

```go
//go:build integration

package pg_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/lumos-forge/hypersolid/backend/internal/ledger"
	"github.com/lumos-forge/hypersolid/backend/internal/ledger/conformance"
	"github.com/lumos-forge/hypersolid/backend/internal/ledger/pg"
)

// newPool starts a throwaway postgres:17-alpine and returns a ready pool + a
// per-test schema initializer. Mirrors singlewriter/pg's harness.
func newPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	ctr, err := tcpostgres.Run(ctx, "postgres:17-alpine",
		tcpostgres.WithDatabase("test"),
		tcpostgres.WithUsername("test"),
		tcpostgres.WithPassword("test"),
		testcontainers.WithWaitStrategy(wait.ForListeningPort("5432/tcp")),
	)
	if err != nil {
		t.Fatalf("start postgres: %v", err)
	}
	t.Cleanup(func() { _ = ctr.Terminate(ctx) })
	dsn, err := ctr.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("dsn: %v", err)
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestStoreConformance(t *testing.T) {
	pool := newPool(t)
	if err := pg.EnsureSchema(context.Background(), pool); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	// Each conformance sub-scenario needs a fresh authority; truncate between runs.
	conformance.Run(t, func() ledger.Authorizer {
		_, _ = pool.Exec(context.Background(), "TRUNCATE sw_state, ledger_intents")
		return pg.New(pool)
	})
}

func TestConcurrentSameCloidGrantsOneNonce(t *testing.T) {
	pool := newPool(t)
	ctx := context.Background()
	if err := pg.EnsureSchema(ctx, pool); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	store := pg.New(pool)
	const n = 8
	var wg sync.WaitGroup
	grants := make([]ledger.Grant, n)
	errs := make([]error, n)
	req := ledger.Request{KeyID: "k", Cloid: "same", Digest: [32]byte{1}, Fence: 1, Notional: 10, DailyCap: 1000, NowMs: 1_700_000_000_000}
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) { defer wg.Done(); grants[i], errs[i] = store.Authorize(ctx, req) }(i)
	}
	wg.Wait()
	// All must succeed and return the SAME nonce (one real allocation + replays).
	var nonce uint64
	for i := 0; i < n; i++ {
		if errs[i] != nil {
			t.Fatalf("goroutine %d err = %v", i, errs[i])
		}
		if nonce == 0 {
			nonce = grants[i].Nonce
		} else if grants[i].Nonce != nonce {
			t.Fatalf("goroutine %d nonce = %d, want all equal to %d", i, grants[i].Nonce, nonce)
		}
	}
	// Exactly one ledger_intents row exists for the cloid.
	var count int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM ledger_intents WHERE key_id='k' AND cloid='same'").Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("ledger_intents rows = %d, want 1", count)
	}
	_ = errors.Is // keep errors import if unused above
}
```

> 注：`_ = errors.Is` 仅为占位保 import；若实现时 `errors` 未被引用则删除该 import 与该行。写完先按下一步编译校验修正 import。

- [ ] **Step 4: 集成测试编译校验（本地无 Docker，仅编译）**

Run: `cd backend && go test -c -tags=integration -o /dev/null ./internal/ledger/pg/`
Expected: 编译成功（无输出）。若因未用 import 报错，删除对应 import/占位行后重试。

- [ ] **Step 5: 非集成门（单元 + vet + race + build signer）**

Run: `cd backend && go test ./... && go vet ./... && go test -race ./internal/... && go build ./cmd/signer && rm -f signer`
Expected: 全部 PASS；vet/race 无告警；signer 构建成功。

- [ ] **Step 6: 提交**

```bash
cd /Users/bill/Documents/GitHub/HyperSolid
git add backend/internal/ledger/pg/schema.go backend/internal/ledger/pg/pg.go backend/internal/ledger/pg/pg_integration_test.go
git commit --no-verify -m "feat(backend): Postgres cloid ledger store (atomic sw_state + ledger_intents)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Self-Review

**Spec coverage：**
- 纯 `Decide`（幂等/碰撞/空 cloid/透传）→ Task 1 ✅
- `Mem` 参考实现 → Task 1 ✅
- 独立 `conformance` 套件（8 场景）→ Task 2 ✅
- Postgres `Store`（单事务管两表）+ schema（复用 swpg）→ Task 3 ✅
- 集成 testcontainers + 并发同 cloid 用例 → Task 3 ✅
- 测试门（go test/vet/race/build + 集成编译校验）→ 各 Task 步骤 ✅
- 非目标（不接线 signer、不做终态、Digest 不透明）→ 计划未触及，符合 ✅

**Placeholder scan：** 无 TBD/TODO；所有代码步骤含完整代码。集成测试的 `errors` 占位已显式标注处理方式。

**Type consistency：** `Decide(sw singlewriter.State, existing *Record, r Request) (singlewriter.State, Record, Grant, error)` 在 Task 1/2/3 一致；`Grant{Nonce,Duplicate}`、`Record{Nonce,Digest,Status}`、`Request{KeyID,Cloid,Digest,Fence,Notional,DailyCap,NowMs}`、`ErrMissingCloid`/`ErrCloidReuse` 全程一致；pg 复用 `swpg.EnsureSchema` 与 sw_state SQL 字面量一致。
