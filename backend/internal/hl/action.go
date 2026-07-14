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

// orderTuple builds one order's ordered msgpack tuple: {a,b,p,s,r,t(,c)}.
func orderTuple(o OrderInput) Map {
	tuple := Map{
		{"a", o.Asset}, {"b", o.IsBuy}, {"p", o.Px}, {"s", o.Sz}, {"r", o.ReduceOnly},
		{"t", Map{{"limit", Map{{"tif", o.Tif}}}}},
	}
	if o.Cloid != "" {
		tuple = append(tuple, KV{"c", o.Cloid})
	}
	return tuple
}

// BuilderInput is the optional action-level builder fee: an address paid a fee of FeeTenthBps (1/10 bps).
type BuilderInput struct {
	Address     string
	FeeTenthBps int64
}

// BuildOrderAction builds the ordered msgpack Map for an `order` action (fields in HL byte order).
// The optional builder fee is appended last (`{b,f}`) and omitted entirely when nil (HL omit rule).
func BuildOrderAction(orders []OrderInput, grouping string, builder *BuilderInput) Map {
	arr := make([]any, len(orders))
	for i, o := range orders {
		arr[i] = orderTuple(o)
	}
	m := Map{{"type", "order"}, {"orders", arr}, {"grouping", grouping}}
	if builder != nil {
		m = append(m, KV{"builder", Map{{"b", builder.Address}, {"f", builder.FeeTenthBps}}})
	}
	return m
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

// CancelByCloidInput is one cancel-by-cloid (asset + 34-char 0x client order id).
type CancelByCloidInput struct {
	Asset int64
	Cloid string
}

// BuildCancelByCloidAction builds the ordered Map for a `cancelByCloid` action.
func BuildCancelByCloidAction(cancels []CancelByCloidInput) Map {
	arr := make([]any, len(cancels))
	for i, c := range cancels {
		arr[i] = Map{{"asset", c.Asset}, {"cloid", c.Cloid}}
	}
	return Map{{"type", "cancelByCloid"}, {"cancels", arr}}
}

// ModifyInput is the semantic input for a `modify` action. Oid is used when Cloid is "";
// otherwise the 34-char 0x Cloid string is used as the oid value (HL oid union: uint | cloid).
type ModifyInput struct {
	Oid   int64
	Cloid string
	Order OrderInput
}

// modifyEntry builds one modify's {oid, order} tuple, shared by modify and batchModify.
// oid = the 34-char 0x Cloid string when Cloid != "", otherwise the int64 Oid.
func modifyEntry(in ModifyInput) Map {
	var oid any
	if in.Cloid != "" {
		oid = in.Cloid
	} else {
		oid = in.Oid
	}
	return Map{{"oid", oid}, {"order", orderTuple(in.Order)}}
}

// BuildModifyAction builds the ordered Map for a `modify` action: {type, oid, order}.
func BuildModifyAction(in ModifyInput) Map {
	return append(Map{{"type", "modify"}}, modifyEntry(in)...)
}

// BuildBatchModifyAction builds the ordered Map for a `batchModify` action: {type, modifies:[{oid, order}]}.
func BuildBatchModifyAction(mods []ModifyInput) Map {
	arr := make([]any, len(mods))
	for i, m := range mods {
		arr[i] = modifyEntry(m)
	}
	return Map{{"type", "batchModify"}, {"modifies", arr}}
}

// BuildUpdateLeverageAction builds the ordered Map for an `updateLeverage` action.
// leverage is an integer; isCross=true → cross margin, false → isolated.
func BuildUpdateLeverageAction(asset int64, isCross bool, leverage int64) Map {
	return Map{
		{"type", "updateLeverage"},
		{"asset", asset},
		{"isCross", isCross},
		{"leverage", leverage},
	}
}

// BuildUpdateIsolatedMarginAction builds the ordered Map for an `updateIsolatedMargin` action.
// ntli is a SIGNED integer (positive = add margin, negative = remove); isBuy selects the position side.
func BuildUpdateIsolatedMarginAction(asset int64, isBuy bool, ntli int64) Map {
	return Map{
		{"type", "updateIsolatedMargin"},
		{"asset", asset},
		{"isBuy", isBuy},
		{"ntli", ntli},
	}
}

// BuildScheduleCancelAction builds the ordered Map for a `scheduleCancel` action (dead man's switch).
// time == nil clears the schedule ({type} only); a non-nil time sets it ({type, time}).
// The optional field is fully omitted (not sent as 0) when clearing, matching HL wire semantics.
func BuildScheduleCancelAction(time *int64) Map {
	if time == nil {
		return Map{{"type", "scheduleCancel"}}
	}
	return Map{{"type", "scheduleCancel"}, {"time", *time}}
}
