// Package singlewriter is the cross-process single-writer authority for one
// agent key: it fences stale writers and, for the current lease-holder,
// advances the per-key nonce high-water and charges the daily notional spend —
// atomically. It composes what today are two in-process allocators
// (internal/nonce.Allocator + internal/policy.SpendTracker) into one persisted,
// fence-guarded authorization (docs/BACKEND-ARCHITECTURE.md §6.2, M6 slice ①).
//
// The fencing token is minted by the lease layer (a later slice); here the store
// only enforces monotonicity: a token lower than the highest seen is rejected.
package singlewriter

import (
	"context"
	"errors"
)

// dayMs is the number of milliseconds in a UTC calendar day; the daily spend is
// bucketed by NowMs/dayMs (matches internal/policy).
const dayMs int64 = 24 * 60 * 60 * 1000

// Request is one signing authorization for an agent key.
type Request struct {
	KeyID    string  // agent private key id (per private key, not account)
	Fence    uint64  // fencing token from the caller's lease (minted in a later slice)
	Notional float64 // this action's USD notional; 0 for non-notional kinds
	DailyCap float64 // per-key daily notional cap; 0 = unlimited, <0 = misconfig (denied)
	NowMs    int64   // caller clock in ms; injectable for tests
}

// Grant is the result of an accepted authorization.
type Grant struct {
	Nonce uint64 // strictly-increasing per-key ms nonce to sign with
}

// State is the per-key persisted single-writer state.
type State struct {
	Fence      uint64  // highest fencing token accepted so far
	LastNonce  uint64  // last issued nonce (high-water)
	SpendDay   int64   // UTC day number of SpendTotal (NowMs/dayMs)
	SpendTotal float64 // notional spent within SpendDay
}

// Writer is the cross-process single-writer authority. Authorize atomically
// fences stale writers and, for the current lease-holder, advances the per-key
// nonce high-water and charges the daily spend — all or nothing.
type Writer interface {
	Authorize(ctx context.Context, r Request) (Grant, error)
}

// Typed rejections; callers/endpoints map these to HTTP status codes.
var (
	ErrFenced          = errors.New("fenced: stale fencing token") // stale lease token → future 409
	ErrDailyCap        = errors.New("daily cap exceeded")          // over/under (misconfig) daily cap → 403
	ErrInvalidNotional = errors.New("invalid notional")           // NaN/Inf/negative notional → 403
)
