// Package reconciler polls Hyperliquid for each configured account's open orders
// and fills and advances the ledger lifecycle (open/filled) by cloid. It reads
// only — it signs nothing and allocates no nonces.
package reconciler

import (
	"context"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/lumos-forge/hypersolid/backend/internal/hlinfo"
	"github.com/lumos-forge/hypersolid/backend/internal/ledger"
)

// Account binds an agent key id to the HL master account address whose orders it places.
type Account struct {
	KeyID   string
	Address string
}

// Observer receives reconciler telemetry. The default (nopObserver) discards all,
// so the reconciler carries no hard dependency on any metrics backend.
type Observer interface {
	// ReconcileStep records one completed step by outcome: "ok", "error", or "skipped".
	ReconcileStep(outcome string)
	// Reap records one reap-pass transition actually applied, by target status.
	Reap(target ledger.Status)
	// LeaderState reports whether this instance currently holds reconciler leadership.
	LeaderState(isLeader bool)
}

type nopObserver struct{}

func (nopObserver) ReconcileStep(string) {}
func (nopObserver) Reap(ledger.Status)   {}
func (nopObserver) LeaderState(bool)     {}

// step outcome labels.
const (
	outcomeOK      = "ok"
	outcomeError   = "error"
	outcomeSkipped = "skipped"
)

// allNonTerminalCutoffMs is a far-future cutoff (year ~2096) so Orphans returns
// every currently non-terminal intent; their min updatedAt is the per-key fills anchor.
const allNonTerminalCutoffMs int64 = 4_000_000_000_000

// maxAnchorLookbackMs bounds how far back the fills anchor can reach. The auto-loop
// only advances intents to open/filled — it cannot reap a canceled/rejected order —
// so a stuck non-terminal intent would otherwise pin the anchor at an ever-older
// timestamp, growing per-tick pagination without bound. Fills for intents within the
// window are still caught; older stuck intents are surfaced via /v1/orphans.
const maxAnchorLookbackMs int64 = 7 * 24 * 60 * 60 * 1000 // 7 days

// clampAnchor bounds anchor to at most maxAnchorLookbackMs before nowMs.
func clampAnchor(anchor, nowMs int64) int64 {
	if floor := nowMs - maxAnchorLookbackMs; anchor < floor {
		return floor
	}
	return anchor
}

// InfoClient is the read-side HL surface the reconciler needs (hlinfo.Client satisfies it).
type InfoClient interface {
	OpenCloids(ctx context.Context, user string) (map[string]hlinfo.OpenOrder, error)
	FillsByCloidSince(ctx context.Context, user string, startMs int64) (map[string]hlinfo.Fill, error)
	OrderStatus(ctx context.Context, user, cloid string) (hlinfo.OrderStatusResult, error)
}

// Reconciler advances ledger intents from observed HL state, one poll at a time.
type Reconciler struct {
	client   InfoClient
	led      ledger.Reconciler
	accounts []Account
	isLeader func() bool // optional leader gate; nil = always run
	obs      Observer    // telemetry sink; never nil (defaults to nopObserver)
}

// Option configures a Reconciler.
type Option func(*Reconciler)

// WithLeaderGate makes step a no-op unless isLeader() is true, so in a
// multi-instance deployment only the current lease holder polls HL.
func WithLeaderGate(isLeader func() bool) Option {
	return func(r *Reconciler) { r.isLeader = isLeader }
}

// WithObserver injects a telemetry sink. A nil observer keeps the no-op default.
func WithObserver(obs Observer) Option {
	return func(r *Reconciler) {
		if obs != nil {
			r.obs = obs
		}
	}
}

// New returns a Reconciler over the given HL info client, ledger, and accounts.
func New(client InfoClient, led ledger.Reconciler, accounts []Account, opts ...Option) *Reconciler {
	r := &Reconciler{client: client, led: led, accounts: accounts, obs: nopObserver{}}
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

// reapTarget maps an HL order status string to the ledger status to advance toward,
// ok=false for statuses that don't imply a lifecycle change. Mirrors the mobile
// normalizeOrderStatus classification.
func reapTarget(hlStatus string) (ledger.Status, bool) {
	switch {
	case strings.HasSuffix(hlStatus, "Rejected"), hlStatus == "rejected":
		return ledger.StatusRejected, true
	case strings.HasSuffix(hlStatus, "Canceled"), hlStatus == "canceled", hlStatus == "scheduledCancel":
		return ledger.StatusCanceled, true
	case hlStatus == "filled":
		return ledger.StatusFilled, true
	case hlStatus == "open", hlStatus == "resting", hlStatus == "triggered":
		return ledger.StatusOpen, true
	default:
		return "", false
	}
}

// reconcileOne applies one transition. It reports applied=true when the ledger
// accepted the transition, and swallows benign per-cloid rejections
// (ErrUnknownIntent = not our order; ErrInvalidTransition = stale/idempotent)
// as applied=false, surfacing only infrastructure errors.
func (r *Reconciler) reconcileOne(ctx context.Context, keyID, cloid string, target ledger.Status) (bool, error) {
	if _, err := r.led.Reconcile(ctx, keyID, cloid, target); err != nil {
		if errors.Is(err, ledger.ErrUnknownIntent) || errors.Is(err, ledger.ErrInvalidTransition) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// step runs one poll+reconcile pass over all accounts, returning the first
// infrastructure error (HL query or ledger infra) encountered.
func (r *Reconciler) step(ctx context.Context) (err error) {
	leader := r.isLeader == nil || r.isLeader()
	r.obs.LeaderState(leader)
	if r.isLeader != nil && !leader {
		r.obs.ReconcileStep(outcomeSkipped)
		return nil // not the leader; another instance polls
	}
	defer func() {
		if err != nil {
			r.obs.ReconcileStep(outcomeError)
		} else {
			r.obs.ReconcileStep(outcomeOK)
		}
	}()
	orphs, err := r.led.Orphans(ctx, allNonTerminalCutoffMs)
	if err != nil {
		return err
	}
	byKey := make(map[string][]ledger.Orphan)
	for _, o := range orphs {
		byKey[o.KeyID] = append(byKey[o.KeyID], o)
	}
	now := time.Now().UnixMilli()
	for _, a := range r.accounts {
		group := byKey[a.KeyID]
		anchor := now
		for _, o := range group {
			if o.UpdatedAtMs < anchor {
				anchor = o.UpdatedAtMs
			}
		}
		anchor = clampAnchor(anchor, now)
		open, err := r.client.OpenCloids(ctx, a.Address)
		if err != nil {
			return err
		}
		fills, err := r.client.FillsByCloidSince(ctx, a.Address, anchor)
		if err != nil {
			return err
		}
		// advance open/filled from the batch snapshots.
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
			if _, err := r.reconcileOne(ctx, a.KeyID, cloid, target); err != nil {
				return err
			}
		}
		// reap non-terminal intents HL no longer reports as open/filled: the
		// authoritative orderStatus advances canceled/rejected (or filled) to terminal.
		for _, o := range group {
			if _, inOpen := open[o.Cloid]; inOpen {
				continue
			}
			if _, inFills := fills[o.Cloid]; inFills {
				continue
			}
			res, err := r.client.OrderStatus(ctx, a.Address, o.Cloid)
			if err != nil {
				return err
			}
			if !res.Found {
				continue // unknownOid → HL has no record; leave (may be mid-submission)
			}
			target, ok := reapTarget(res.Status)
			if !ok {
				continue
			}
			applied, err := r.reconcileOne(ctx, a.KeyID, o.Cloid, target)
			if err != nil {
				return err
			}
			if applied {
				r.obs.Reap(target)
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
