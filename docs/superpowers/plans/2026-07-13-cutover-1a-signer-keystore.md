# Cutover Phase 1a — Signer Persistent Encrypted Keystore — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Go signer a durable, AES-256-GCM-encrypted key vault + a `Manager` API (generate/load/remove) so it can hold agent keys across restarts. Foundation only — no HTTP endpoint, no signing behavior change.

**Architecture:** `hl.AddressFromPriv` derives the agent address; `keystore.Seal/Open` encrypt at rest; a `Vault` interface (`mem` + `pg`) persists encrypted records; `keystore.Manager` wraps the in-memory `*Keystore` registry + vault; `buildHandler` reloads the vault at startup.

**Tech Stack:** Go, `github.com/decred/dcrd/dcrec/secp256k1/v4`, stdlib `crypto/aes`+`cipher` (GCM), `github.com/jackc/pgx/v5/pgxpool`, testcontainers (integration).

Spec: `docs/superpowers/specs/2026-07-13-cutover-1a-signer-keystore-design.md`
Module: `github.com/lumos-forge/hypersolid/backend`
Branch: `feat/cutover-1a-signer-keystore`
Validation: `cd backend && gofmt -w ./... && go test ./... && go vet ./... && go build ./cmd/signer && rm -f signer`.

---

### Task 1: `hl.AddressFromPriv`

**Files:**
- Create: `backend/internal/hl/address.go`
- Test: `backend/internal/hl/address_test.go`

- [ ] **Step 1: Write the failing test** (canonical vector: priv `…0001` → address `0x7e5f…95bdf`)

```go
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test ./internal/hl/ -run TestAddressFromPriv`
Expected: FAIL (undefined: AddressFromPriv).

- [ ] **Step 3: Implement**

```go
package hl

import (
	"encoding/hex"
	"errors"

	secp "github.com/decred/dcrd/dcrec/secp256k1/v4"
)

// AddressFromPriv derives the lowercase 0x Ethereum address of a secp256k1 private key:
// keccak256 of the uncompressed public key X||Y (drop the 0x04 prefix), last 20 bytes.
func AddressFromPriv(priv []byte) (string, error) {
	if len(priv) != 32 {
		return "", errors.New("hl: private key must be 32 bytes")
	}
	pub := secp.PrivKeyFromBytes(priv).PubKey().SerializeUncompressed() // 65 bytes: 0x04||X||Y
	h := keccak(pub[1:])
	return "0x" + hex.EncodeToString(h[20:]), nil
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && go test ./internal/hl/ -run TestAddressFromPriv`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd backend && gofmt -w internal/hl/address.go internal/hl/address_test.go
git add internal/hl/address.go internal/hl/address_test.go
git commit -m "feat(cutover-1a): hl.AddressFromPriv (agent address from a private key)"
```

---

### Task 2: `keystore.Seal` / `Open`

**Files:**
- Create: `backend/internal/keystore/seal.go`
- Test: `backend/internal/keystore/seal_test.go`

- [ ] **Step 1: Write the failing test**

```go
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test ./internal/keystore/ -run 'TestSeal|TestOpen'`
Expected: FAIL (undefined: Seal/Open).

- [ ] **Step 3: Implement**

```go
package keystore

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
)

// Seal encrypts plaintext with a 32-byte KEK using AES-256-GCM. Output = nonce(12) || ct||tag.
func Seal(kek, plaintext []byte) ([]byte, error) {
	gcm, err := newGCM(kek)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, plaintext, nil), nil
}

// Open reverses Seal; it fails on a wrong KEK or a tampered blob.
func Open(kek, blob []byte) ([]byte, error) {
	gcm, err := newGCM(kek)
	if err != nil {
		return nil, err
	}
	ns := gcm.NonceSize()
	if len(blob) < ns {
		return nil, errors.New("keystore: sealed blob too short")
	}
	return gcm.Open(nil, blob[:ns], blob[ns:], nil)
}

func newGCM(kek []byte) (cipher.AEAD, error) {
	if len(kek) != 32 {
		return nil, errors.New("keystore: KEK must be 32 bytes")
	}
	block, err := aes.NewCipher(kek)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && go test ./internal/keystore/ -run 'TestSeal|TestOpen'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd backend && gofmt -w internal/keystore/seal.go internal/keystore/seal_test.go
git add internal/keystore/seal.go internal/keystore/seal_test.go
git commit -m "feat(cutover-1a): AES-256-GCM Seal/Open for the key vault"
```

---

### Task 3: `Vault` interface + `MemVault`

**Files:**
- Create: `backend/internal/keystore/vault.go`
- Test: `backend/internal/keystore/vault_test.go`

- [ ] **Step 1: Write the failing test**

```go
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test ./internal/keystore/ -run TestMemVault`
Expected: FAIL (undefined: NewMemVault/Record/Vault).

- [ ] **Step 3: Implement**

```go
package keystore

import (
	"context"
	"sync"
)

// Record is a persisted, encrypted agent key: EncPriv = Seal(kek, priv).
type Record struct {
	KeyID        string
	AgentAddress string
	EncPriv      []byte
}

// Vault is durable, encrypted-at-rest persistence for agent keys.
type Vault interface {
	Put(ctx context.Context, r Record) error       // upsert by KeyID
	List(ctx context.Context) ([]Record, error)     // all records
	Delete(ctx context.Context, keyID string) error // idempotent
}

// MemVault is an in-memory Vault for tests and the no-DB path.
type MemVault struct {
	mu   sync.Mutex
	byID map[string]Record
}

func NewMemVault() *MemVault { return &MemVault{byID: make(map[string]Record)} }

func (m *MemVault) Put(_ context.Context, r Record) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.byID[r.KeyID] = r
	return nil
}

func (m *MemVault) List(_ context.Context) ([]Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Record, 0, len(m.byID))
	for _, r := range m.byID {
		out = append(out, r)
	}
	return out, nil
}

func (m *MemVault) Delete(_ context.Context, keyID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.byID, keyID)
	return nil
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && go test ./internal/keystore/ -run TestMemVault`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd backend && gofmt -w internal/keystore/vault.go internal/keystore/vault_test.go
git add internal/keystore/vault.go internal/keystore/vault_test.go
git commit -m "feat(cutover-1a): Vault interface + MemVault"
```

---

### Task 4: `keystore.Manager` (Provision/Load/Remove/AgentAddress)

**Files:**
- Create: `backend/internal/keystore/manager.go`
- Test: `backend/internal/keystore/manager_test.go`

- [ ] **Step 1: Write the failing test**

```go
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test ./internal/keystore/ -run TestManager`
Expected: FAIL (undefined: NewManager).

- [ ] **Step 3: Implement**

```go
package keystore

import (
	"context"
	"fmt"
	"sync"

	secp "github.com/decred/dcrd/dcrec/secp256k1/v4"

	"github.com/lumos-forge/hypersolid/backend/internal/hl"
)

// Manager is the signer's key-custody API: it generates/holds agent keys inside the process,
// persists them encrypted (Vault), and reloads them at startup. Private key material never
// leaves the process.
type Manager struct {
	registry *Keystore
	vault    Vault
	kek      []byte
	mu       sync.RWMutex
	addrs    map[string]string // keyID -> agent address
}

func NewManager(registry *Keystore, vault Vault, kek []byte) *Manager {
	return &Manager{registry: registry, vault: vault, kek: kek, addrs: make(map[string]string)}
}

// Provision generates a fresh secp256k1 key, seals+persists it, registers it for signing, and
// returns the agent address.
func (m *Manager) Provision(ctx context.Context, keyID string) (string, error) {
	pk, err := secp.GeneratePrivateKey()
	if err != nil {
		return "", err
	}
	priv := pk.Serialize()
	addr, err := hl.AddressFromPriv(priv)
	if err != nil {
		return "", err
	}
	enc, err := Seal(m.kek, priv)
	if err != nil {
		return "", err
	}
	if err := m.vault.Put(ctx, Record{KeyID: keyID, AgentAddress: addr, EncPriv: enc}); err != nil {
		return "", err
	}
	if err := m.registry.Add(keyID, priv); err != nil {
		_ = m.vault.Delete(ctx, keyID) // no orphaned encrypted key
		return "", err
	}
	m.setAddr(keyID, addr)
	return addr, nil
}

// Load decrypts every persisted key into the in-memory registry + address map.
func (m *Manager) Load(ctx context.Context) error {
	recs, err := m.vault.List(ctx)
	if err != nil {
		return err
	}
	for _, r := range recs {
		priv, err := Open(m.kek, r.EncPriv)
		if err != nil {
			return fmt.Errorf("keystore: decrypt %s: %w", r.KeyID, err)
		}
		if err := m.registry.Add(r.KeyID, priv); err != nil {
			return fmt.Errorf("keystore: register %s: %w", r.KeyID, err)
		}
		m.setAddr(r.KeyID, r.AgentAddress)
	}
	return nil
}

// Remove zeroizes (registry) + deletes (vault) the key.
func (m *Manager) Remove(ctx context.Context, keyID string) error {
	m.registry.Remove(keyID)
	m.mu.Lock()
	delete(m.addrs, keyID)
	m.mu.Unlock()
	return m.vault.Delete(ctx, keyID)
}

// AgentAddress returns the agent address bound to a keyID.
func (m *Manager) AgentAddress(keyID string) (string, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	a, ok := m.addrs[keyID]
	return a, ok
}

func (m *Manager) setAddr(keyID, addr string) {
	m.mu.Lock()
	m.addrs[keyID] = addr
	m.mu.Unlock()
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && go test ./internal/keystore/ -run TestManager`
Expected: PASS.

- [ ] **Step 5: Full keystore + hl package tests + vet**

Run: `cd backend && go test ./internal/keystore/ ./internal/hl/ && go vet ./internal/keystore/ ./internal/hl/`
Expected: PASS; clean.

- [ ] **Step 6: Commit**

```bash
cd backend && gofmt -w internal/keystore/manager.go internal/keystore/manager_test.go
git add internal/keystore/manager.go internal/keystore/manager_test.go
git commit -m "feat(cutover-1a): keystore.Manager (provision/load/remove agent keys)"
```

---

### Task 5: Postgres `Vault`

**Files:**
- Create: `backend/internal/keystore/pg/pg.go`, `backend/internal/keystore/pg/schema.go`
- Test: `backend/internal/keystore/pg/pg_integration_test.go`

- [ ] **Step 1: Write `schema.go`**

```go
package pg

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

const createSchemaSQL = `CREATE TABLE IF NOT EXISTS agent_keys (
	key_id        text PRIMARY KEY,
	agent_address text NOT NULL,
	enc_priv      bytea NOT NULL,
	created_at    timestamptz NOT NULL DEFAULT now()
)`

// EnsureSchema idempotently creates the agent_keys table.
func EnsureSchema(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, createSchemaSQL)
	return err
}
```

- [ ] **Step 2: Write `pg.go`**

```go
package pg

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumos-forge/hypersolid/backend/internal/keystore"
)

// Vault is a Postgres-backed keystore.Vault storing AES-256-GCM-sealed agent keys.
type Vault struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Vault { return &Vault{pool: pool} }

func (v *Vault) Put(ctx context.Context, r keystore.Record) error {
	_, err := v.pool.Exec(ctx,
		`INSERT INTO agent_keys (key_id, agent_address, enc_priv) VALUES ($1,$2,$3)
		 ON CONFLICT (key_id) DO UPDATE SET agent_address = EXCLUDED.agent_address, enc_priv = EXCLUDED.enc_priv`,
		r.KeyID, r.AgentAddress, r.EncPriv)
	return err
}

func (v *Vault) List(ctx context.Context) ([]keystore.Record, error) {
	rows, err := v.pool.Query(ctx, `SELECT key_id, agent_address, enc_priv FROM agent_keys`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []keystore.Record
	for rows.Next() {
		var r keystore.Record
		if err := rows.Scan(&r.KeyID, &r.AgentAddress, &r.EncPriv); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (v *Vault) Delete(ctx context.Context, keyID string) error {
	_, err := v.pool.Exec(ctx, `DELETE FROM agent_keys WHERE key_id = $1`, keyID)
	return err
}
```

- [ ] **Step 3: Write the integration test** (mirrors `internal/ledger/pg/pg_integration_test.go`)

```go
//go:build integration

package pg_test

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/lumos-forge/hypersolid/backend/internal/keystore"
	kpg "github.com/lumos-forge/hypersolid/backend/internal/keystore/pg"
)

var testPool *pgxpool.Pool

func TestMain(m *testing.M) {
	ctx := context.Background()
	container, err := tcpostgres.Run(ctx, "postgres:16-alpine",
		tcpostgres.WithDatabase("test"), tcpostgres.WithUsername("t"), tcpostgres.WithPassword("t"),
		testcontainers.WithWaitStrategy(wait.ForListeningPort("5432/tcp")))
	if err != nil {
		os.Exit(0) // no docker → skip
	}
	dsn, _ := container.ConnectionString(ctx, "sslmode=disable")
	testPool, _ = pgxpool.New(ctx, dsn)
	_ = kpg.EnsureSchema(ctx, testPool)
	code := m.Run()
	testPool.Close()
	_ = container.Terminate(ctx)
	os.Exit(code)
}

func TestPGVaultRoundTrip(t *testing.T) {
	ctx := context.Background()
	v := kpg.New(testPool)
	if err := v.Put(ctx, keystore.Record{KeyID: "k1", AgentAddress: "0xabc", EncPriv: []byte{1, 2, 3}}); err != nil {
		t.Fatal(err)
	}
	if err := v.Put(ctx, keystore.Record{KeyID: "k1", AgentAddress: "0xdef", EncPriv: []byte{4}}); err != nil {
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
}
```

- [ ] **Step 4: Verify build + (if docker) integration**

Run: `cd backend && go build ./internal/keystore/... && go vet ./internal/keystore/...`
Expected: clean.
Run (optional, needs docker): `cd backend && go test -tags=integration ./internal/keystore/pg/...`
Expected: PASS (or a clean skip when docker is unavailable).

- [ ] **Step 5: Commit**

```bash
cd backend && gofmt -w internal/keystore/pg/*.go
git add internal/keystore/pg/
git commit -m "feat(cutover-1a): Postgres Vault for the encrypted keystore"
```

---

### Task 6: Wire the vault into `cmd/signer` startup

**Files:**
- Modify: `backend/cmd/signer/main.go`

- [ ] **Step 1: Add the KEK config**

In the `config` struct add `signerKEK []byte`. In `configFromEnv`, parse it:
```go
	if raw := os.Getenv("SIGNER_KEK"); raw != "" {
		if b, err := base64.StdEncoding.DecodeString(raw); err == nil {
			cfg.signerKEK = b
		}
	}
```
(Add `encoding/base64` to the imports.)

- [ ] **Step 2: Load the vault in `buildHandler`**

In `buildHandler`, in the `databaseURL != ""` branch (where `pool` is created and the ledger/lease
schemas are ensured), after those schemas:
```go
		if len(cfg.signerKEK) != 32 {
			pool.Close()
			return nil, nil, fmt.Errorf("signer: SIGNER_KEK must be 32 bytes (base64) when a DB is configured")
		}
		if err := keystorepg.EnsureSchema(ctx, pool); err != nil {
			pool.Close()
			return nil, nil, fmt.Errorf("signer: keystore schema: %w", err)
		}
		keyManager := keystore.NewManager(ks, keystorepg.New(pool), cfg.signerKEK)
		if err := keyManager.Load(ctx); err != nil {
			pool.Close()
			return nil, nil, fmt.Errorf("signer: keystore load: %w", err)
		}
		_ = keyManager // held for Phase 1b (provisioning endpoints)
```
Add imports: `"github.com/lumos-forge/hypersolid/backend/internal/keystore"` and
`keystorepg "github.com/lumos-forge/hypersolid/backend/internal/keystore/pg"`.
(The `_ = keyManager` line is a deliberate Phase-1a placeholder; 1b consumes it. If `go vet`
flags an unused variable in a way that fails the build, keep the blank assignment — a local
assigned-and-blanked var compiles cleanly.)

- [ ] **Step 3: Build + vet + full backend tests**

Run: `cd backend && gofmt -w cmd/signer/main.go && go build ./cmd/signer && rm -f signer && go vet ./... && go test ./...`
Expected: build ok; vet clean; all tests pass.

- [ ] **Step 4: Commit**

```bash
cd backend
git add cmd/signer/main.go
git commit -m "feat(cutover-1a): load the encrypted keystore at signer startup"
```

---

### Task 7: Finish the branch

- [ ] **Step 1: Final validation**

Run: `cd backend && gofmt -l ./ && go test ./... && go vet ./... && go build ./cmd/signer && rm -f signer`
Expected: no gofmt diffs; all green.

- [ ] **Step 2: Push + PR**

```bash
git push -u origin feat/cutover-1a-signer-keystore
gh pr create --title "feat(cutover-1a): signer persistent encrypted keystore" --body-file <body>
```
Body: `hl.AddressFromPriv` + Seal/Open + Vault(mem/pg) + Manager + startup reload; no HTTP/behavior change; Phase 1b wires the provisioning endpoints. Note the PG integration test is behind `-tags=integration`.

- [ ] **Step 3: Code review + CI** — dispatch code-review (background, emphasize: key material never logged/returned, zeroization on remove, fail-closed without KEK, no signing behavior change) + `gh pr checks <n> --watch`.

- [ ] **Step 4: Merge** — clean review + green CI → `gh pr merge --squash --delete-branch`; sync main.

---

## Self-review

- **Spec coverage:** address derivation (T1), sealing (T2), Vault iface+mem (T3), Manager provision/load/remove/address (T4), PG vault + integration (T5), startup reload + fail-closed KEK (T6). All spec §Design items covered.
- **Placeholder scan:** none — full code + commands. (The `_ = keyManager` in T6 is an intentional, documented Phase-1a seam, not a placeholder for missing logic.)
- **Type consistency:** `Record{KeyID,AgentAddress,EncPriv}`, `Vault{Put,List,Delete}`, `Manager{Provision,Load,Remove,AgentAddress}`, `NewMemVault`, `pg.New`, `hl.AddressFromPriv` used identically across tasks and the PG impl.
- **Security:** private keys are generated via `secp.GeneratePrivateKey` (valid keys), sealed before persist, zeroized on remove (`hl.Signer.Close` via `registry.Remove`), never logged/returned; DB-without-KEK fails closed.
