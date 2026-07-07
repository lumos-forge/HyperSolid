package singlewriter

import "math"

// decide is the pure single-writer transition. Given the current persisted
// state and a request it returns the next state and grant, or a typed error
// (leaving state UNCHANGED on every reject). Both the in-memory and Postgres
// writers apply this identical logic so their behavior cannot drift.
//
// Order: fence → invalid notional → daily cap → nonce. A fenced, invalid, or
// cap-denied request never advances the nonce (matches the M5 sign pipeline).
func decide(s State, r Request) (State, Grant, error) {
	// 1. fence: a stale writer (lower token) is rejected without touching state.
	if r.Fence < s.Fence {
		return s, Grant{}, ErrFenced
	}
	// 2. clock sanity: a non-positive NowMs is a corrupt/misconfigured caller
	// clock. Fail closed, because uint64(negative) poisons the nonce high-water
	// and the next LastNonce+1 wraps back to a lower nonce (regression).
	if r.NowMs <= 0 {
		return s, Grant{}, ErrInvalidClock
	}
	// 3. invalid notional fails closed (mirrors policy.SpendTracker.Charge).
	if math.IsNaN(r.Notional) || math.IsInf(r.Notional, 0) || r.Notional < 0 {
		return s, Grant{}, ErrInvalidNotional
	}
	// 4. daily cap check+reserve. A negative cap is a misconfiguration → fail
	// closed. Otherwise bucket by UTC day; a day rollover resets the running total.
	if r.DailyCap < 0 {
		return s, Grant{}, ErrDailyCap
	}
	day := r.NowMs / dayMs
	total := s.SpendTotal
	if s.SpendDay != day {
		total = 0
	}
	if r.DailyCap > 0 && total+r.Notional > r.DailyCap { // strict >, exactly-at-cap allowed
		// Deny does NOT advance the nonce and returns the UNCHANGED state. Unlike
		// SpendTracker.Charge we intentionally do not persist the day-reset on this
		// path, so a Postgres impl can safely ROLLBACK; the next accepted call
		// recomputes the day and resets anyway.
		return s, Grant{}, ErrDailyCap
	}
	// 5. nonce high-water advance: n = max(now, last+1), strictly increasing.
	n := uint64(r.NowMs)
	if n <= s.LastNonce {
		n = s.LastNonce + 1
	}
	return State{
		Fence:      r.Fence, // monotonic: r.Fence >= s.Fence here
		LastNonce:  n,
		SpendDay:   day,
		SpendTotal: total + r.Notional,
	}, Grant{Nonce: n}, nil
}
