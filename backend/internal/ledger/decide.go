package ledger

import "github.com/lumos-forge/hypersolid/backend/internal/singlewriter"

// Decide is the pure ledger transition. existing is the current record for
// (r.KeyID, r.Cloid) or nil if this cloid is first-seen. It returns the next
// single-writer state, shared address-spend state, the record to persist, the
// grant, or a typed error — leaving state UNCHANGED on every reject and on an
// idempotent replay. Both the in-memory and Postgres stores apply this
// identical logic so they cannot drift.
//
// Order: missing-cloid → replay/collision → single-writer (fence + clock +
// notional + daily cap + nonce) → shared address spend. A replay never
// re-charges either the per-key or per-address cap or bumps the nonce; a
// collision or any rejection writes nothing.
func Decide(sw singlewriter.State, addr SpendState, existing *Record, r Request) (singlewriter.State, SpendState, Record, Grant, error) {
	if r.Cloid == "" {
		return sw, addr, Record{}, Grant{}, ErrMissingCloid
	}
	if existing != nil {
		if existing.Digest != r.Digest {
			return sw, addr, Record{}, Grant{}, ErrCloidReuse
		}
		return sw, addr, *existing, Grant{Nonce: existing.Nonce, Duplicate: true}, nil
	}
	nextSW, swg, err := singlewriter.Decide(sw, singlewriter.Request{
		KeyID:    r.KeyID,
		Fence:    r.Fence,
		Notional: r.Notional,
		DailyCap: r.DailyCap,
		NowMs:    r.NowMs,
	})
	if err != nil {
		return sw, addr, Record{}, Grant{}, err
	}
	nextAddr := addr
	if r.AddressDailyCap < 0 {
		return sw, addr, Record{}, Grant{}, ErrAddressDailyCap
	}
	if r.AddressDailyCap > 0 {
		nextAddr, err = DecideSpend(addr, r.Notional, r.AddressDailyCap, r.NowMs)
		if err != nil {
			return sw, addr, Record{}, Grant{}, err
		}
	}
	rec := Record{Nonce: swg.Nonce, Digest: r.Digest, Status: StatusSigned}
	return nextSW, nextAddr, rec, Grant{Nonce: swg.Nonce, Duplicate: false}, nil
}
