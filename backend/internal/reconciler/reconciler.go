// Package reconciler polls Hyperliquid for each configured account's open orders
// and fills and advances the ledger lifecycle (open/filled) by cloid. It reads
// only — it signs nothing and allocates no nonces.
package reconciler

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/lumos-forge/hypersolid/backend/internal/hlinfo"
	"github.com/lumos-forge/hypersolid/backend/internal/ledger"
)

// Account binds an agent key id to the HL master account address whose orders it places.
type Account struct {
	KeyID   string
	Address string
}

// allNonTerminalCutoffMs is a far-future cutoff (year ~2096) so Orphans returns
// every currently non-terminal intent; their min updatedAt is the per-key fills anchor.
const allNonTerminalCutoffMs int64 = 4_000_000_000_000

// InfoClient is the read-side HL surface the reconciler needs (hlinfo.Client satisfies it).
type InfoClient interface {
	OpenCloids(ctx context.Context, user string) (map[string]hlinfo.OpenOrder, error)
	FillsByCloidSince(ctx context.Context, user string, startMs int64) (map[string]hlinfo.Fill, error)
}

// Reconciler advances ledger intents from observed HL state, one poll at a time.
type Reconciler struct {
	client   InfoClient
	led      ledger.Reconciler
	accounts []Account
	isLeader func() bool // optional leader gate; nil = always run
}

// Option configures a Reconciler.
type Option func(*Reconciler)

// WithLeaderGate makes step a no-op unless isLeader() is true, so in a
// multi-instance deployment only the current lease holder polls HL.
func WithLeaderGate(isLeader func() bool) Option {
	return func(r *Reconciler) { r.isLeader = isLeader }
}

// New returns a Reconciler over the given HL info client, ledger, and accounts.
func New(client InfoClient, led ledger.Reconciler, accounts []Account, opts ...Option) *Reconciler {
	r := &Reconciler{client: client, led: led, accounts: accounts}
	for _, o := range opts {
		o(r)
	}
	return r
}

// targetFor returns the ledger status a cloid should advance toward given the open
// and fills snapshots; ok=false when neither mentions it (no-op this cycle). Open
// wins over fills so a partially-filled resting order stays open.
func targetFor(cloid string, open map[string]hlinfo.OpenOrder, fills map[string]hlinfo.Fill) (ledger.Status, bool) {
	if _, ok := open[cloid]; ok {
		return ledger.StatusOpen, true
	}
	if _, ok := fills[cloid]; ok {
		return ledger.StatusFilled, true
	}
	return "", false
}

// reconcileOne applies one transition, swallowing benign per-cloid rejections
// (ErrUnknownIntent = not our order; ErrInvalidTransition = stale/idempotent) and
// surfacing only infrastructure errors.
func (r *Reconciler) reconcileOne(ctx context.Context, keyID, cloid string, target ledger.Status) error {
	if _, err := r.led.Reconcile(ctx, keyID, cloid, target); err != nil &&
		!errors.Is(err, ledger.ErrUnknownIntent) && !errors.Is(err, ledger.ErrInvalidTransition) {
		return err
	}
	return nil
}

// step runs one poll+reconcile pass over all accounts, returning the first
// infrastructure error (HL query or ledger infra) encountered.
func (r *Reconciler) step(ctx context.Context) error {
	if r.isLeader != nil && !r.isLeader() {
		return nil // not the leader; another instance polls
	}
	orphs, err := r.led.Orphans(ctx, allNonTerminalCutoffMs)
	if err != nil {
		return err
	}
	// oldest non-terminal intent's updatedAt per keyID = that key's fills anchor.
	anchorByKey := make(map[string]int64)
	for _, o := range orphs {
		if cur, ok := anchorByKey[o.KeyID]; !ok || o.UpdatedAtMs < cur {
			anchorByKey[o.KeyID] = o.UpdatedAtMs
		}
	}
	now := time.Now().UnixMilli()
	for _, a := range r.accounts {
		anchor, ok := anchorByKey[a.KeyID]
		if !ok {
			anchor = now // no pending intents → fills window from now (≈empty)
		}
		open, err := r.client.OpenCloids(ctx, a.Address)
		if err != nil {
			return err
		}
		fills, err := r.client.FillsByCloidSince(ctx, a.Address, anchor)
		if err != nil {
			return err
		}
		seen := make(map[string]struct{}, len(open)+len(fills))
		for cloid := range open {
			seen[cloid] = struct{}{}
		}
		for cloid := range fills {
			seen[cloid] = struct{}{}
		}
		for cloid := range seen {
			target, ok := targetFor(cloid, open, fills)
			if !ok {
				continue
			}
			if err := r.reconcileOne(ctx, a.KeyID, cloid, target); err != nil {
				return err
			}
		}
	}
	return nil
}

// Run drives step on a ticker until ctx is done. Step errors are transient
// (retried next tick) and logged, never fatal.
func (r *Reconciler) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := r.step(ctx); err != nil {
				log.Printf("reconciler step: %v", err)
			}
		}
	}
}
