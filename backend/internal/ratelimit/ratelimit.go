// Package ratelimit provides a per-key token-bucket rate limiter for the signing
// boundary. Config (ratePerSec, burst) is supplied per call — mirroring
// policy.SpendTracker.Charge — so the limiter holds only bucket state, not policy.
// It is fail-closed: misconfiguration or a NaN/Inf parameter denies the request.
// Safe for concurrent use.
package ratelimit

import (
	"math"
	"sync"
	"time"
)

type bucket struct {
	tokens float64 // available tokens (fractional)
	lastMs int64   // last refill timestamp (ms)
}

// Limiter enforces a per-key token-bucket budget.
type Limiter struct {
	nowMs   func() int64
	mu      sync.Mutex
	buckets map[string]bucket
}

// New returns a Limiter. If nowMs is nil, it uses the real clock
// (time.Now().UnixMilli()); tests inject a fake clock.
func New(nowMs func() int64) *Limiter {
	if nowMs == nil {
		nowMs = func() int64 { return time.Now().UnixMilli() }
	}
	return &Limiter{nowMs: nowMs, buckets: make(map[string]bucket)}
}

// Allow atomically charges one token against keyID's bucket, refilling by elapsed
// time at ratePerSec (capped at burst). It returns true when a token was consumed.
//
// Config semantics (fail-closed):
//   - ratePerSec == 0: limiting disabled → always true, without allocating a bucket.
//   - ratePerSec < 0, or (ratePerSec > 0 and burst <= 0), or NaN/Inf on either:
//     misconfiguration → false, without allocating a bucket.
//   - ratePerSec > 0 and burst > 0: active token bucket. A first-seen key starts
//     full (tokens = burst).
func (l *Limiter) Allow(keyID string, ratePerSec, burst float64) bool {
	// Fail closed on non-finite parameters: they would corrupt the bucket math.
	if math.IsNaN(ratePerSec) || math.IsInf(ratePerSec, 0) ||
		math.IsNaN(burst) || math.IsInf(burst, 0) {
		return false
	}
	if ratePerSec < 0 {
		return false // negative rate is a misconfiguration → deny
	}
	if ratePerSec == 0 {
		return true // disabled: no limit, no bucket allocation
	}
	if burst <= 0 {
		return false // rate>0 requires a positive burst; otherwise deny
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.nowMs()
	b, ok := l.buckets[keyID]
	if !ok {
		b = bucket{tokens: burst, lastMs: now} // first-seen key starts full
	} else {
		if elapsed := now - b.lastMs; elapsed > 0 {
			b.tokens += float64(elapsed) / 1000.0 * ratePerSec
			if b.tokens > burst {
				b.tokens = burst
			}
		}
		b.lastMs = now
	}
	if b.tokens >= 1 {
		b.tokens -= 1
		l.buckets[keyID] = b
		return true
	}
	l.buckets[keyID] = b
	return false
}
