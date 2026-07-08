package ledger

// isTerminal reports whether s is a terminal lifecycle state (no further edges
// except the idempotent self-report).
func isTerminal(s Status) bool {
	return s == StatusFilled || s == StatusRejected || s == StatusCanceled
}

// allowedTransitions maps each source state to its permitted forward targets
// (excluding the always-allowed idempotent self-transition). Terminal states have
// no entry, so only their self-report is accepted.
var allowedTransitions = map[Status]map[Status]bool{
	StatusSigned:    {StatusSubmitted: true, StatusRejected: true},
	StatusSubmitted: {StatusOpen: true, StatusFilled: true, StatusRejected: true},
	StatusOpen:      {StatusFilled: true, StatusCanceled: true, StatusRejected: true},
}

// Transition validates a reconciliation step. An identical target is an idempotent
// no-op (returns current, nil); a permitted forward edge returns target; anything
// else — a backward, skipping, or cross-terminal edge — returns ErrInvalidTransition
// leaving the caller to keep the current state.
func Transition(current, target Status) (Status, error) {
	if current == target {
		return current, nil
	}
	if allowedTransitions[current][target] {
		return target, nil
	}
	return current, ErrInvalidTransition
}
