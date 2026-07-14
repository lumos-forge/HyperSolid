package hl

import (
	"reflect"
	"testing"
)

func TestBuildOrderAction(t *testing.T) {
	got := BuildOrderAction([]OrderInput{{Asset: 0, IsBuy: true, Px: "50000", Sz: "0.01", ReduceOnly: false, Tif: "Gtc"}}, "na", nil)
	want := Map{
		{"type", "order"},
		{"orders", []any{Map{
			{"a", int64(0)}, {"b", true}, {"p", "50000"}, {"s", "0.01"}, {"r", false},
			{"t", Map{{"limit", Map{{"tif", "Gtc"}}}}},
		}}},
		{"grouping", "na"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("order action mismatch:\n got %#v\nwant %#v", got, want)
	}
}

func TestBuildOrderActionWithCloid(t *testing.T) {
	got := BuildOrderAction([]OrderInput{{Asset: 0, IsBuy: true, Px: "50000", Sz: "0.01", Tif: "Gtc", Cloid: "0x00000000000000000000000000000001"}}, "na", nil)
	orders := got[1].V.([]any)
	tuple := orders[0].(Map)
	last := tuple[len(tuple)-1]
	if last.K != "c" || last.V.(string) != "0x00000000000000000000000000000001" {
		t.Fatalf("expected trailing cloid field, got %#v", tuple)
	}
}

func TestBuildOrderActionWithBuilder(t *testing.T) {
	got := BuildOrderAction(
		[]OrderInput{{Asset: 0, IsBuy: true, Px: "50000", Sz: "0.01", Tif: "Gtc"}},
		"na",
		&BuilderInput{Address: "0x1111111111111111111111111111111111111111", FeeTenthBps: 20},
	)
	last := got[len(got)-1]
	if last.K != "builder" {
		t.Fatalf("expected trailing builder field, got %#v", got)
	}
	b := last.V.(Map)
	if b[0].K != "b" || b[0].V.(string) != "0x1111111111111111111111111111111111111111" || b[1].K != "f" || b[1].V.(int64) != 20 {
		t.Fatalf("builder field mismatch: %#v", b)
	}
}

func TestBuildOrderActionOmitsBuilderWhenNil(t *testing.T) {
	got := BuildOrderAction([]OrderInput{{Asset: 0, IsBuy: true, Px: "1", Sz: "1", Tif: "Gtc"}}, "na", nil)
	if got[len(got)-1].K != "grouping" {
		t.Fatalf("expected no builder field when nil, got %#v", got)
	}
}

func TestBuildCancelAction(t *testing.T) {
	got := BuildCancelAction([]CancelInput{{Asset: 0, Oid: 123}})
	want := Map{{"type", "cancel"}, {"cancels", []any{Map{{"a", int64(0)}, {"o", int64(123)}}}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("cancel action mismatch:\n got %#v\nwant %#v", got, want)
	}
}

func TestBuildTwapActions(t *testing.T) {
	twap := BuildTwapOrderAction(0, true, "0.02", false, 30, true)
	wantTwap := Map{{"type", "twapOrder"}, {"twap", Map{{"a", int64(0)}, {"b", true}, {"s", "0.02"}, {"r", false}, {"m", int64(30)}, {"t", true}}}}
	if !reflect.DeepEqual(twap, wantTwap) {
		t.Fatalf("twapOrder mismatch:\n got %#v\nwant %#v", twap, wantTwap)
	}
	cancel := BuildTwapCancelAction(0, 7)
	wantCancel := Map{{"type", "twapCancel"}, {"a", int64(0)}, {"t", int64(7)}}
	if !reflect.DeepEqual(cancel, wantCancel) {
		t.Fatalf("twapCancel mismatch:\n got %#v\nwant %#v", cancel, wantCancel)
	}
}

func TestBuildCancelByCloidAction(t *testing.T) {
	got := BuildCancelByCloidAction([]CancelByCloidInput{{Asset: 0, Cloid: "0x00000000000000000000000000000001"}})
	want := Map{
		{"type", "cancelByCloid"},
		{"cancels", []any{Map{
			{"asset", int64(0)},
			{"cloid", "0x00000000000000000000000000000001"},
		}}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("cancelByCloid action mismatch:\n got %#v\nwant %#v", got, want)
	}
}

func TestBuildModifyActionNumericOid(t *testing.T) {
	got := BuildModifyAction(ModifyInput{
		Oid:   123,
		Order: OrderInput{Asset: 0, IsBuy: true, Px: "50000", Sz: "0.01", ReduceOnly: false, Tif: "Gtc"},
	})
	want := Map{
		{"type", "modify"},
		{"oid", int64(123)},
		{"order", Map{
			{"a", int64(0)}, {"b", true}, {"p", "50000"}, {"s", "0.01"}, {"r", false},
			{"t", Map{{"limit", Map{{"tif", "Gtc"}}}}},
		}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("modify(numeric oid) mismatch:\n got %#v\nwant %#v", got, want)
	}
}

func TestBuildModifyActionCloidOid(t *testing.T) {
	got := BuildModifyAction(ModifyInput{
		Cloid: "0x00000000000000000000000000000002",
		Order: OrderInput{Asset: 1, IsBuy: false, Px: "3000", Sz: "0.5", ReduceOnly: true, Tif: "Ioc"},
	})
	if got[1].K != "oid" {
		t.Fatalf("expected second field oid, got %#v", got[1])
	}
	if s, ok := got[1].V.(string); !ok || s != "0x00000000000000000000000000000002" {
		t.Fatalf("expected cloid string oid, got %#v", got[1].V)
	}
}

func TestBuildUpdateLeverageAction(t *testing.T) {
	got := BuildUpdateLeverageAction(0, true, 5)
	want := Map{
		{"type", "updateLeverage"},
		{"asset", int64(0)},
		{"isCross", true},
		{"leverage", int64(5)},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("updateLeverage action mismatch:\n got %#v\nwant %#v", got, want)
	}
}

func TestBuildBatchModifyAction(t *testing.T) {
	got := BuildBatchModifyAction([]ModifyInput{
		{Oid: 123, Order: OrderInput{Asset: 0, IsBuy: true, Px: "50000", Sz: "0.01", ReduceOnly: false, Tif: "Gtc"}},
		{Cloid: "0x00000000000000000000000000000002", Order: OrderInput{Asset: 1, IsBuy: false, Px: "3000", Sz: "0.5", ReduceOnly: true, Tif: "Ioc", Cloid: "0x00000000000000000000000000000009"}},
	})
	want := Map{
		{"type", "batchModify"},
		{"modifies", []any{
			Map{{"oid", int64(123)}, {"order", Map{
				{"a", int64(0)}, {"b", true}, {"p", "50000"}, {"s", "0.01"}, {"r", false},
				{"t", Map{{"limit", Map{{"tif", "Gtc"}}}}},
			}}},
			Map{{"oid", "0x00000000000000000000000000000002"}, {"order", Map{
				{"a", int64(1)}, {"b", false}, {"p", "3000"}, {"s", "0.5"}, {"r", true},
				{"t", Map{{"limit", Map{{"tif", "Ioc"}}}}},
				{"c", "0x00000000000000000000000000000009"},
			}}},
		}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("batchModify action mismatch:\n got %#v\nwant %#v", got, want)
	}
}

func TestBuildUpdateIsolatedMarginActionAdd(t *testing.T) {
	got := BuildUpdateIsolatedMarginAction(0, true, 1000000)
	want := Map{{"type", "updateIsolatedMargin"}, {"asset", int64(0)}, {"isBuy", true}, {"ntli", int64(1000000)}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("updateIsolatedMargin(add) mismatch:\n got %#v\nwant %#v", got, want)
	}
}

func TestBuildUpdateIsolatedMarginActionRemoveNegative(t *testing.T) {
	got := BuildUpdateIsolatedMarginAction(1, false, -500000)
	want := Map{{"type", "updateIsolatedMargin"}, {"asset", int64(1)}, {"isBuy", false}, {"ntli", int64(-500000)}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("updateIsolatedMargin(remove) mismatch:\n got %#v\nwant %#v", got, want)
	}
}

func TestBuildScheduleCancelActionSet(t *testing.T) {
	ts := int64(1700000000000)
	got := BuildScheduleCancelAction(&ts)
	want := Map{{"type", "scheduleCancel"}, {"time", int64(1700000000000)}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("scheduleCancel(set) mismatch:\n got %#v\nwant %#v", got, want)
	}
}

func TestBuildScheduleCancelActionClear(t *testing.T) {
	got := BuildScheduleCancelAction(nil)
	want := Map{{"type", "scheduleCancel"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("scheduleCancel(clear) mismatch:\n got %#v\nwant %#v", got, want)
	}
}
