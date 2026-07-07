// Package policy is a stateless, reject-first evaluator for the signing boundary
// (docs/BACKEND-ARCHITECTURE.md §5.1a). It is default-deny: only a recognized,
// non-killed, within-cap Intent is allowed. It performs no signing and holds no
// state; the wiring layer must populate Intent fields authoritatively from the action.
package policy

import "math"

// Intent is the semantic view of a signing request that the policy evaluates.
type Intent struct {
	Kind         string  // "order" / "cancel" / "cancelByCloid" / "scheduleCancel" / …
	Coin         string  // symbol for per-coin caps; "" when not applicable
	NotionalUsdc float64 // order notional (px*sz); 0 for non-notional kinds
}

// Config is the per-user policy bound at the signing boundary.
type Config struct {
	AllowedKinds    map[string]bool    // reject-first allowlist; a kind absent/false is denied
	KillSwitch      bool               // when true, every intent is rejected
	MaxNotionalUsdc float64            // global per-order notional cap
	PerCoinMaxUsdc  map[string]float64 // optional tighter per-coin cap (overrides global)
}

// Decision is the policy verdict. Allow is false unless every rule passes.
type Decision struct {
	Allow  bool
	Reason string // set when Allow is false
}

func deny(reason string) Decision { return Decision{Allow: false, Reason: reason} }

// Evaluate applies the reject-first policy: default-deny, allowing only a
// recognized, non-killed, within-cap intent. Rule order is deterministic
// (kill-switch, then kind allowlist, then notional cap) so the reason is stable.
// Malformed notional values (negative or NaN) are denied (fail-closed).
func Evaluate(intent Intent, cfg Config) Decision {
	if cfg.KillSwitch {
		return deny("kill-switch active")
	}
	if !cfg.AllowedKinds[intent.Kind] {
		return deny("kind not allowed")
	}
	if intent.NotionalUsdc != 0 {
		if math.IsNaN(intent.NotionalUsdc) || intent.NotionalUsdc < 0 {
			return deny("invalid notional")
		}
		limit := cfg.MaxNotionalUsdc
		if c, ok := cfg.PerCoinMaxUsdc[intent.Coin]; ok {
			limit = c
		}
		if intent.NotionalUsdc > limit {
			return deny("over notional cap")
		}
	}
	return Decision{Allow: true}
}
