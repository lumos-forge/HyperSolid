package hlinfo

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

func TestOpenCloids(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["type"] != "frontendOpenOrders" || body["user"] != "0xacc" {
			t.Fatalf("bad body: %+v", body)
		}
		_, _ = w.Write([]byte(`[
			{"cloid":"c1","oid":10,"coin":"BTC","side":"B","limitPx":"50000"},
			{"cloid":"c2","oid":11,"coin":"ETH","side":"A","limitPx":"3000"},
			{"cloid":null,"oid":12,"coin":"BTC","side":"B","limitPx":"1"}
		]`))
	}))
	defer srv.Close()
	c := New(srv.URL, nil)
	got, err := c.OpenCloids(context.Background(), "0xacc")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2 (null-cloid dropped)", len(got))
	}
	if got["c1"].Side != "buy" || got["c1"].Px != 50000 || got["c1"].Oid != 10 {
		t.Fatalf("c1 = %+v", got["c1"])
	}
	if got["c2"].Side != "sell" || got["c2"].Coin != "ETH" {
		t.Fatalf("c2 = %+v", got["c2"])
	}
}

func TestFillsByCloidAggregates(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["type"] != "userFills" {
			t.Fatalf("bad type: %s", body["type"])
		}
		_, _ = w.Write([]byte(`[
			{"cloid":"c1","px":"100","sz":"2","closedPnl":"5"},
			{"cloid":"c1","px":"110","sz":"1","closedPnl":"3"},
			{"cloid":null,"px":"1","sz":"1","closedPnl":"0"}
		]`))
	}))
	defer srv.Close()
	c := New(srv.URL, nil)
	got, err := c.FillsByCloid(context.Background(), "0xacc")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
	f := got["c1"]
	if f.Sz != 3 || f.ClosedPnl != 8 {
		t.Fatalf("c1 sz/pnl = %+v", f)
	}
	if f.Px < 103.33 || f.Px > 103.34 {
		t.Fatalf("c1 px = %v, want ~103.333", f.Px)
	}
}

func TestErrorsOnNon2xxAndBadJSON(t *testing.T) {
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(500)
	}))
	defer bad.Close()
	if _, err := New(bad.URL, nil).OpenCloids(context.Background(), "0xacc"); err == nil {
		t.Fatal("want error on 500")
	}
	garbage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{not-an-array`))
	}))
	defer garbage.Close()
	if _, err := New(garbage.URL, nil).FillsByCloid(context.Background(), "0xacc"); err == nil {
		t.Fatal("want error on bad json")
	}
}

func TestFillsByCloidSincePaginates(t *testing.T) {
	var starts []int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["type"] != "userFillsByTime" {
			t.Fatalf("bad type: %v", body["type"])
		}
		st := int64(body["startTime"].(float64))
		starts = append(starts, st)
		switch {
		case st <= 100:
			_, _ = w.Write([]byte(`[
				{"cloid":"c1","px":"100","sz":"2","closedPnl":"1","time":150,"tid":1},
				{"cloid":"c1","px":"110","sz":"1","closedPnl":"1","time":200,"tid":2}
			]`))
		case st <= 201:
			_, _ = w.Write([]byte(`[
				{"cloid":"c1","px":"120","sz":"1","closedPnl":"1","time":250,"tid":2},
				{"cloid":"c1","px":"130","sz":"1","closedPnl":"1","time":300,"tid":3}
			]`))
		default:
			_, _ = w.Write([]byte(`[]`))
		}
	}))
	defer srv.Close()
	got, err := New(srv.URL, nil).FillsByCloidSince(context.Background(), "0xacc", 100)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	f := got["c1"]
	if f.Sz != 4 {
		t.Fatalf("c1 sz = %v, want 4 (tid-dedup across pages)", f.Sz)
	}
	if len(starts) != 3 || starts[0] != 100 || starts[1] != 200 || starts[2] != 300 {
		t.Fatalf("startTimes = %v, want [100 200 300] (cursor = maxTime, inclusive)", starts)
	}
}

func TestFillsByCloidSinceEmptyFirstPage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	got, err := New(srv.URL, nil).FillsByCloidSince(context.Background(), "0xacc", 0)
	if err != nil || len(got) != 0 {
		t.Fatalf("got %v, err %v; want empty", got, err)
	}
}

func TestFillsByCloidSinceCapsPages(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		st := int64(body["startTime"].(float64))
		calls++
		_, _ = w.Write([]byte(`[{"cloid":"c1","px":"1","sz":"1","closedPnl":"0","time":` +
			strconv.FormatInt(st+1, 10) + `,"tid":` + strconv.FormatInt(st+1, 10) + `}]`))
	}))
	defer srv.Close()
	if _, err := New(srv.URL, nil).FillsByCloidSince(context.Background(), "0xacc", 0); err != nil {
		t.Fatalf("err = %v", err)
	}
	if calls != fillsMaxPages {
		t.Fatalf("calls = %d, want fillsMaxPages=%d", calls, fillsMaxPages)
	}
}
