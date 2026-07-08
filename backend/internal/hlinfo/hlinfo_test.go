package hlinfo

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
