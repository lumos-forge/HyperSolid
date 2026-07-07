package policy

import (
	"math"
	"sync"
	"time"
)

const dayMs int64 = 24 * 60 * 60 * 1000

type daySpend struct {
	day   int64   // UTC day number = nowMs / dayMs
	total float64 // notional spent within that day
}

// SpendTracker accumulates per-key notional spent within the current UTC day and
// enforces a per-key daily cap. It is the stateful complement to the pure
// Evaluate. Safe for concurrent use.
type SpendTracker struct {
	nowMs func() int64
	mu    sync.Mutex
	spent map[string]daySpend
}

// NewSpendTracker returns a tracker. If nowMs is nil, it uses the real clock
// (time.Now().UnixMilli()); tests inject a fake clock.
func NewSpendTracker(nowMs func() int64) *SpendTracker {
	if nowMs == nil {
		nowMs = func() int64 { return time.Now().UnixMilli() }
	}
	return &SpendTracker{nowMs: nowMs, spent: make(map[string]daySpend)}
}

// Charge atomically enforces the per-key daily cap. If the current UTC day rolled
// over, the key's total resets to 0; if dailyCap > 0 and total+notional would
// exceed it, Charge returns false WITHOUT adding; otherwise it adds notional to
// the day's total and returns true. dailyCap == 0 means no daily limit.
func (s *SpendTracker) Charge(keyID string, notional, dailyCap float64) bool {
	// Fail closed on invalid notional: NaN/Inf/negative would corrupt the daily
	// total or defeat the cap comparison, silently disabling the limit.
	if math.IsNaN(notional) || math.IsInf(notional, 0) || notional < 0 {
		return false
	}
	// A negative daily cap is a misconfiguration; fail closed rather than treat
	// it as unlimited (dailyCap == 0 remains the explicit "no limit" sentinel).
	if dailyCap < 0 {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.nowMs() / dayMs
	e := s.spent[keyID]
	if e.day != d {
		e = daySpend{day: d, total: 0}
	}
	if dailyCap > 0 && e.total+notional > dailyCap {
		s.spent[keyID] = e
		return false
	}
	e.total += notional
	e.day = d
	s.spent[keyID] = e
	return true
}

// Spent returns the notional spent by keyID within the current UTC day (0 if the
// stored day has rolled). For tests/observability.
func (s *SpendTracker) Spent(keyID string) float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.nowMs() / dayMs
	e := s.spent[keyID]
	if e.day != d {
		return 0
	}
	return e.total
}
