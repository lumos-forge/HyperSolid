# Cutover Phase 1a — Signer Persistent Encrypted Keystore

Date: 2026-07-13
Status: Approved (per the cutover baseline `2026-07-13-engine-signer-cutover-design.md`)

## Context

Phase 1a of the engine→signer cutover. The signer's keystore is in-memory and starts empty
(`keystore.New()` in `backend/cmd/signer/main.go`), so it can't hold real agent keys across a
restart. This unit gives the signer a **durable, encrypted key vault** and a Go-level
`Manager` API (generate/load/remove) so a subsequent phase (1b) can expose provisioning over
HTTP. No HTTP endpoint and no runtime signing behavior change here — the foundation only.

Mirrors the ledger's `interface + mem + pg` layering
(`internal/ledger/{ledger.go,mem.go,pg/pg.go,pg/schema.go}`).

## Goal

The signer can persist an agent private key **encrypted at rest** (AES-256-GCM, env KEK),
reload all keys at startup into the in-memory `hl.Signer` registry, resolve `keyId →
agentAddress`, and zeroize+delete on removal — all behind a small Go `Manager` API.

## Design (all in `backend/`)

### 1. `internal/hl/address.go` — agent address from a private key

```go
// AddressFromPriv derives the lowercase 0x Ethereum address of a secp256k1 private key
// (keccak256 of the uncompressed pubkey X||Y, last 20 bytes).
func AddressFromPriv(priv []byte) (string, error)
```
Uses the existing `secp` (`github.com/decred/dcrd/dcrec/secp256k1/v4`) + `keccak` already in
`eip712.go`. `PubKey().SerializeUncompressed()` → drop the `0x04` prefix → keccak256 → hex the
last 20 bytes, lowercase, `0x`-prefixed.

### 2. `internal/keystore/seal.go` — AES-256-GCM sealing

```go
// Seal encrypts plaintext with a 32-byte KEK: output = nonce(12) || ciphertext||tag.
func Seal(kek, plaintext []byte) ([]byte, error)
// Open reverses Seal; fails on a bad KEK / tampered blob.
func Open(kek, blob []byte) ([]byte, error)
```
`crypto/aes` + `crypto/cipher` (GCM) + `crypto/rand` nonce. `kek` must be 32 bytes (else error).

### 3. `internal/keystore/vault.go` — persistence interface

```go
type Record struct { KeyID, AgentAddress string; EncPriv []byte } // EncPriv = Seal(kek, priv)

type Vault interface {
    Put(ctx context.Context, r Record) error       // upsert by KeyID
    List(ctx context.Context) ([]Record, error)
    Delete(ctx context.Context, keyID string) error // idempotent
}
```

### 4. `internal/keystore/mem.go` — in-memory Vault (tests / no-DB)

`MemVault` backed by a mutex-guarded `map[string]Record`.

### 5. `internal/keystore/pg/pg.go` + `schema.go` — Postgres Vault

- `EnsureSchema`: `CREATE TABLE IF NOT EXISTS agent_keys (key_id text PRIMARY KEY, agent_address
  text NOT NULL, enc_priv bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`.
- `PGVault{pool}` with `Put` (upsert `ON CONFLICT (key_id) DO UPDATE`), `List`, `Delete`, using
  `pgxpool` like `ledger/pg`.

### 6. `internal/keystore/manager.go` — the key-custody API

Wraps the existing in-memory registry (`*Keystore`) + a `Vault` + the KEK, and tracks
`keyId → agentAddress`:

```go
type Manager struct { /* registry *Keystore; vault Vault; kek []byte; addrs map[string]string; mu */ }
func NewManager(registry *Keystore, vault Vault, kek []byte) *Manager

// Provision generates a fresh secp256k1 key inside the signer, seals+persists it, registers it
// for signing, and returns the agent address. Private key material never leaves the process.
func (m *Manager) Provision(ctx context.Context, keyID string) (agentAddress string, err error)

// Load decrypts every persisted key into the in-memory registry + address map (startup reload).
func (m *Manager) Load(ctx context.Context) error

// Remove zeroizes (registry) + deletes (vault) the key.
func (m *Manager) Remove(ctx context.Context, keyID string) error

// AgentAddress returns the address bound to a keyId.
func (m *Manager) AgentAddress(keyID string) (string, bool)
```
- `Provision`: `secp.GeneratePrivateKey()` → `priv := key.Serialize()` (32B, always valid) →
  `AddressFromPriv` → `Seal(kek, priv)` → `vault.Put` → `registry.Add(keyID, priv)` → track
  address. On any error nothing is registered/persisted (persist before register; if register
  fails, best-effort `vault.Delete`).
- `Load`: `vault.List` → `Open(kek, r.EncPriv)` → `registry.Add` → track address.
- `Remove`: `registry.Remove` (zeroizes via `hl.Signer.Close`) + `vault.Delete`.

### 7. `cmd/signer/main.go` — wire the vault + startup reload

- Config: `signerKEK` from env `SIGNER_KEK` (base64, must decode to 32 bytes).
- In `buildHandler` (where the `pgxpool` is already built for the ledger): when `databaseURL !=
  ""`, `keystorepg.EnsureSchema(pool)`, build `PGVault`, build `Manager(ks, vault, kek)`, and
  `Manager.Load(ctx)` to repopulate `ks` from persisted keys. **Fail closed** if a DB is
  configured but `SIGNER_KEK` is missing/invalid (can't safely decrypt/persist). When
  `databaseURL == ""`, use a `MemVault` (nothing to load) — consistent with the ledger's mem path.
- Hold the `Manager` for Phase 1b (the provisioning endpoints); `handleSignL1` keeps using the
  `*Keystore` registry unchanged.

## Data flow

```
provision (Go API, 1b wraps in HTTP): Manager.Provision(keyId)
  → secp.GeneratePrivateKey → priv, addr
  → Seal(kek, priv) → vault.Put{keyId, addr, encPriv}
  → registry.Add(keyId, priv) ; addrs[keyId]=addr → return addr
startup: Manager.Load → for each vault Record: Open → registry.Add → addrs[keyId]=addr
sign (unchanged): handleSignL1 → registry.Signer(keyId) → SignL1Action
```

## Error handling / edge cases

- Missing/!=32B KEK with a DB configured → startup fails closed.
- `Open` failure (wrong KEK / tampered blob) during `Load` → error (don't silently drop a key).
- `Provision` persists to the vault **before** registering; a registry failure best-effort
  deletes the vault record so there's no orphaned encrypted key.
- `Remove`/`Delete` are idempotent.
- No behavior change to `/v1/sign/l1` (the registry is populated the same way, just now also
  from the vault at startup).

## Testing (`backend/`)

- `internal/hl/address_test.go`: `AddressFromPriv` against a known priv→address vector (cross-
  checked with the agent address `@nktkas`/viem derives for the same key).
- `internal/keystore/seal_test.go`: Seal→Open round-trip; wrong-KEK/tampered blob → error;
  non-32B KEK → error.
- `internal/keystore/manager_test.go` (with `MemVault`): `Provision` returns a valid address and
  registers a usable signer (`registry.Signer(keyId)` ok); a fresh `Manager` over the SAME vault
  `Load`s it and resolves the same address + a signer; `Remove` zeroizes + deletes (subsequent
  `Load` doesn't see it). Provisioned keys are distinct.
- `internal/keystore/pg/pg_integration_test.go` (behind `-tags=integration`): `Put`/`List`/
  `Delete` round-trip + upsert, mirroring `ledger/pg` integration style.
- Validation: `cd backend && gofmt -w ./... && go test ./... && go vet ./... && go build ./cmd/signer && rm -f signer`;
  PG: `go test -tags=integration ./internal/keystore/pg/...`.

## Out of scope (later phases)

- 1b: `POST/DELETE /v1/keys` HTTP endpoints + per-keyId policy binding + `scheduleCancel` action.
- 2a+: server `SignerClient`, provisioning + signing cutover, cleanup.
- KMS-backed KEK (the `kek []byte` seam allows a later drop-in).
