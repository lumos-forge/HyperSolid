package hl

// OrderInput is the semantic input for one limit order (first-slice: limit orders only).
type OrderInput struct {
	Asset      int64
	IsBuy      bool
	Px         string
	Sz         string
	ReduceOnly bool
	Tif        string // "Gtc" | "Ioc" | "Alo"
	Cloid      string // optional; omitted from the action when ""
}

// CancelInput is one cancel-by-oid.
type CancelInput struct {
	Asset int64
	Oid   int64
}

// BuildOrderAction builds the ordered msgpack Map for an `order` action (fields in HL byte order).
func BuildOrderAction(orders []OrderInput, grouping string) Map {
	arr := make([]any, len(orders))
	for i, o := range orders {
		tuple := Map{
			{"a", o.Asset}, {"b", o.IsBuy}, {"p", o.Px}, {"s", o.Sz}, {"r", o.ReduceOnly},
			{"t", Map{{"limit", Map{{"tif", o.Tif}}}}},
		}
		if o.Cloid != "" {
			tuple = append(tuple, KV{"c", o.Cloid})
		}
		arr[i] = tuple
	}
	return Map{{"type", "order"}, {"orders", arr}, {"grouping", grouping}}
}

// BuildCancelAction builds the ordered Map for a `cancel` action.
func BuildCancelAction(cancels []CancelInput) Map {
	arr := make([]any, len(cancels))
	for i, c := range cancels {
		arr[i] = Map{{"a", c.Asset}, {"o", c.Oid}}
	}
	return Map{{"type", "cancel"}, {"cancels", arr}}
}

// BuildTwapOrderAction builds the ordered Map for a `twapOrder` action.
func BuildTwapOrderAction(asset int64, isBuy bool, sz string, reduceOnly bool, minutes int64, randomize bool) Map {
	return Map{{"type", "twapOrder"}, {"twap", Map{
		{"a", asset}, {"b", isBuy}, {"s", sz}, {"r", reduceOnly}, {"m", minutes}, {"t", randomize},
	}}}
}

// BuildTwapCancelAction builds the ordered Map for a `twapCancel` action.
func BuildTwapCancelAction(asset, twapID int64) Map {
	return Map{{"type", "twapCancel"}, {"a", asset}, {"t", twapID}}
}
