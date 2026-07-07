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
	// 2. invalid notional fails closed (mirrors policy.SpendTracker.Charge).
	if math.IsNaN(r.Notional) || math.IsInf(r.Notional, 0) || r.Notional < 0 {
		return s, Grant{}, ErrInvalidNotional
	}
	// 3. daily cap check+reserve, UTC-day bucketed; rollover resets the total.
	day := r.NowMs / dayMs
	total := s.SpendTotal
	if s.SpendDay != day {
		total = 0
	}
	if r.DailyCap < 0 { // misconfigured cap → fail closed
		return s, Grant{}, ErrDailyCap
	}
	if r.DailyCap > 0 && total+r.Notional > r.DailyCap { // strict >, exactly-at-cap allowed
		return s, Grant{}, ErrDailyCap // deny does NOT advance nonce
	}
	// 4. nonce high-water advance: n = max(now, last+1), strictly increasing.
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
