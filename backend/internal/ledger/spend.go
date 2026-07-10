package ledger

import "math"

const spendDayMs int64 = 24 * 60 * 60 * 1000

type SpendState struct {
	SpendDay   int64
	SpendTotal float64
}

func DecideSpend(s SpendState, notional, dailyCap float64, nowMs int64) (SpendState, error) {
	if math.IsNaN(notional) || math.IsInf(notional, 0) || notional < 0 {
		return s, ErrAddressDailyCap
	}
	if dailyCap < 0 {
		return s, ErrAddressDailyCap
	}
	day := nowMs / spendDayMs
	total := s.SpendTotal
	if s.SpendDay != day {
		total = 0
	}
	if dailyCap > 0 && total+notional > dailyCap {
		return s, ErrAddressDailyCap
	}
	return SpendState{SpendDay: day, SpendTotal: total + notional}, nil
}
