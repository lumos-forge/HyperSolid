package policy

import (
	"math"
	"testing"
)

func TestEvaluate(t *testing.T) {
	allowOrder := map[string]bool{"order": true, "cancelByCloid": true}
	cases := []struct {
		name       string
		intent     Intent
		cfg        Config
		wantAllow  bool
		wantReason string
	}{
		{
			name:       "kill-switch denies even an allowed within-cap order",
			intent:     Intent{Kind: "order", Coin: "BTC", NotionalUsdc: 10},
			cfg:        Config{AllowedKinds: allowOrder, KillSwitch: true, MaxNotionalUsdc: 1000},
			wantAllow:  false,
			wantReason: "kill-switch active",
		},
		{
			name:       "zero-value config denies everything (default deny)",
			intent:     Intent{Kind: "order", NotionalUsdc: 1},
			cfg:        Config{},
			wantAllow:  false,
			wantReason: "kind not allowed",
		},
		{
			name:       "kind not in allowlist is denied",
			intent:     Intent{Kind: "withdraw3", NotionalUsdc: 0},
			cfg:        Config{AllowedKinds: allowOrder, MaxNotionalUsdc: 1000},
			wantAllow:  false,
			wantReason: "kind not allowed",
		},
		{
			name:      "allowed order within global cap is allowed",
			intent:    Intent{Kind: "order", Coin: "BTC", NotionalUsdc: 500},
			cfg:       Config{AllowedKinds: allowOrder, MaxNotionalUsdc: 1000},
			wantAllow: true,
		},
		{
			name:       "allowed order over global cap is denied",
			intent:     Intent{Kind: "order", Coin: "BTC", NotionalUsdc: 1500},
			cfg:        Config{AllowedKinds: allowOrder, MaxNotionalUsdc: 1000},
			wantAllow:  false,
			wantReason: "over notional cap",
		},
		{
			name:       "per-coin cap tighter than global: over per-coin is denied",
			intent:     Intent{Kind: "order", Coin: "DOGE", NotionalUsdc: 300},
			cfg:        Config{AllowedKinds: allowOrder, MaxNotionalUsdc: 1000, PerCoinMaxUsdc: map[string]float64{"DOGE": 200}},
			wantAllow:  false,
			wantReason: "over notional cap",
		},
		{
			name:      "per-coin cap tighter than global: within per-coin is allowed",
			intent:    Intent{Kind: "order", Coin: "DOGE", NotionalUsdc: 150},
			cfg:       Config{AllowedKinds: allowOrder, MaxNotionalUsdc: 1000, PerCoinMaxUsdc: map[string]float64{"DOGE": 200}},
			wantAllow: true,
		},
		{
			name:       "per-coin explicit 0 blocks any notional for that coin",
			intent:     Intent{Kind: "order", Coin: "SHIB", NotionalUsdc: 1},
			cfg:        Config{AllowedKinds: allowOrder, MaxNotionalUsdc: 1000, PerCoinMaxUsdc: map[string]float64{"SHIB": 0}},
			wantAllow:  false,
			wantReason: "over notional cap",
		},
		{
			name:      "non-notional kind skips the cap even with zero global cap",
			intent:    Intent{Kind: "cancelByCloid", NotionalUsdc: 0},
			cfg:       Config{AllowedKinds: allowOrder, MaxNotionalUsdc: 0},
			wantAllow: true,
		},
		{
			name:      "notional exactly equal to the cap is allowed (strict >)",
			intent:    Intent{Kind: "order", Coin: "BTC", NotionalUsdc: 1000},
			cfg:       Config{AllowedKinds: allowOrder, MaxNotionalUsdc: 1000},
			wantAllow: true,
		},
		{
			name:       "negative notional is rejected (fail-closed)",
			intent:     Intent{Kind: "order", Coin: "BTC", NotionalUsdc: -5},
			cfg:        Config{AllowedKinds: allowOrder, MaxNotionalUsdc: 1000},
			wantAllow:  false,
			wantReason: "invalid notional",
		},
		{
			name:       "NaN notional is rejected (fail-closed)",
			intent:     Intent{Kind: "order", Coin: "BTC", NotionalUsdc: math.NaN()},
			cfg:        Config{AllowedKinds: allowOrder, MaxNotionalUsdc: 1000},
			wantAllow:  false,
			wantReason: "invalid notional",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Evaluate(c.intent, c.cfg)
			if got.Allow != c.wantAllow {
				t.Fatalf("Allow = %v, want %v (reason %q)", got.Allow, c.wantAllow, got.Reason)
			}
			if !c.wantAllow && got.Reason != c.wantReason {
				t.Fatalf("Reason = %q, want %q", got.Reason, c.wantReason)
			}
			if c.wantAllow && got.Reason != "" {
				t.Fatalf("allowed decision should have empty reason, got %q", got.Reason)
			}
		})
	}
}
