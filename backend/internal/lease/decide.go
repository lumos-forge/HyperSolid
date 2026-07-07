package lease

// Row is the current persisted lease row (a seeded brand-new name is
// {Holder:"", Epoch:0, ExpiresAtMs:0} — already expired). A Store backend reads
// this row (and the DB clock) under a lock and feeds it to Decide.
type Row struct {
	Holder      string
	Epoch       uint64
	ExpiresAtMs int64
}

// Op selects the lease operation.
type Op int

const (
	OpAcquire Op = iota
	OpRenew
	OpRelease
)

// Req is one lease operation evaluated at DB time NowMs.
type Req struct {
	Op     Op
	Holder string
	NowMs  int64
	TtlMs  int64
}

// Decide computes the outcome of an operation against the current row at DB time
// NowMs. On a mutation it returns the next row to persist with write=true and the
// resulting Lease in out; on an idempotent no-op (Release by a non-holder)
// write=false and err=nil; on a rejection it returns a typed err
// (ErrHeld/ErrNotHolder/ErrExpired) with write=false and the state unchanged.
//
// Epoch is a per-name monotonic counter: acquiring a free/expired lease bumps it;
// renew keeps it; release preserves it (only expiring the lease). Rows are never
// deleted so the epoch can never regress below singlewriter's stored fence.
func Decide(cur Row, req Req) (next Row, write bool, out Lease, err error) {
	switch req.Op {
	case OpAcquire:
		if cur.ExpiresAtMs <= req.NowMs { // free or expired (incl. seed row)
			next = Row{Holder: req.Holder, Epoch: cur.Epoch + 1, ExpiresAtMs: req.NowMs + req.TtlMs}
			return next, true, leaseToOut(next), nil
		}
		return cur, false, Lease{}, ErrHeld
	case OpRenew:
		if cur.Holder == req.Holder && cur.ExpiresAtMs > req.NowMs {
			next = Row{Holder: cur.Holder, Epoch: cur.Epoch, ExpiresAtMs: req.NowMs + req.TtlMs}
			return next, true, leaseToOut(next), nil
		}
		if cur.Holder == req.Holder { // holder matches but already expired
			return cur, false, Lease{}, ErrExpired
		}
		return cur, false, Lease{}, ErrNotHolder
	case OpRelease:
		if cur.Holder == req.Holder {
			next = Row{Holder: cur.Holder, Epoch: cur.Epoch, ExpiresAtMs: req.NowMs} // expire now, keep epoch
			return next, true, leaseToOut(next), nil
		}
		return cur, false, Lease{}, nil // idempotent no-op; never touch another's lease
	default:
		return cur, false, Lease{}, ErrNotHolder
	}
}

// leaseToOut builds the public Lease from a row (Name is filled by the Store,
// which knows the name).
func leaseToOut(r Row) Lease {
	return Lease{Holder: r.Holder, Epoch: r.Epoch, ExpiresAtMs: r.ExpiresAtMs}
}
