// Package hlinfo is a read-only Hyperliquid /info client. It exposes only the
// queries the reconciler needs — a user's resting orders and fills, indexed by
// client order id (cloid) — and holds no keys and signs nothing.
package hlinfo

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// Client posts to a Hyperliquid /info endpoint.
type Client struct {
	baseURL string
	http    *http.Client
}

// New returns a Client that POSTs to baseURL+"/info" (baseURL has no trailing
// /info, e.g. https://api.hyperliquid.xyz). A nil hc uses a client with a 10s
// timeout so a hung connection can't stall a polling caller indefinitely.
func New(baseURL string, hc *http.Client) *Client {
	if hc == nil {
		hc = &http.Client{Timeout: 10 * time.Second}
	}
	return &Client{baseURL: baseURL, http: hc}
}

// OpenOrder is a resting order (the fields the reconciler and consumers need).
type OpenOrder struct {
	Oid  int64
	Coin string
	Side string // "buy" | "sell"
	Px   float64
}

// Fill aggregates a cloid's fills: total size, size-weighted average price, total closed pnl.
type Fill struct {
	Sz        float64
	Px        float64
	ClosedPnl float64
}

// post issues an /info query with the given typed body and decodes the JSON array
// response into out. Non-2xx and any decode failure (bad JSON / non-array error
// body) surface as errors so the caller can log and retry next cycle.
func (c *Client) post(ctx context.Context, body any, out any) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/info", bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("hlinfo: status %d", res.StatusCode)
	}
	if err := json.NewDecoder(res.Body).Decode(out); err != nil {
		return fmt.Errorf("hlinfo: decode: %w", err)
	}
	return nil
}

type rawOpenOrder struct {
	Cloid   *string `json:"cloid"`
	Oid     int64   `json:"oid"`
	Coin    string  `json:"coin"`
	Side    string  `json:"side"` // "B" | "A"
	LimitPx string  `json:"limitPx"`
}

// OpenCloids returns the user's currently-resting orders indexed by cloid.
// Orders with a null/absent cloid (not placed by us) are dropped.
func (c *Client) OpenCloids(ctx context.Context, user string) (map[string]OpenOrder, error) {
	var raw []rawOpenOrder
	if err := c.post(ctx, map[string]string{"type": "frontendOpenOrders", "user": user}, &raw); err != nil {
		return nil, err
	}
	out := make(map[string]OpenOrder)
	for _, o := range raw {
		if o.Cloid == nil {
			continue
		}
		side := "buy"
		if o.Side == "A" {
			side = "sell"
		}
		px, _ := strconv.ParseFloat(o.LimitPx, 64)
		out[*o.Cloid] = OpenOrder{Oid: o.Oid, Coin: o.Coin, Side: side, Px: px}
	}
	return out, nil
}

type rawFill struct {
	Cloid     *string `json:"cloid"`
	Px        string  `json:"px"`
	Sz        string  `json:"sz"`
	ClosedPnl string  `json:"closedPnl"`
	Time      int64   `json:"time"`
	Tid       int64   `json:"tid"`
}

// FillsByCloid returns the user's fills aggregated by cloid (partial fills summed;
// price size-weighted). Fills with a null/absent cloid are dropped.
func (c *Client) FillsByCloid(ctx context.Context, user string) (map[string]Fill, error) {
	var raw []rawFill
	if err := c.post(ctx, map[string]string{"type": "userFills", "user": user}, &raw); err != nil {
		return nil, err
	}
	type acc struct{ sz, closedPnl, pxSz float64 }
	m := make(map[string]acc)
	for _, f := range raw {
		if f.Cloid == nil {
			continue
		}
		sz, _ := strconv.ParseFloat(f.Sz, 64)
		px, _ := strconv.ParseFloat(f.Px, 64)
		pnl, _ := strconv.ParseFloat(f.ClosedPnl, 64)
		a := m[*f.Cloid]
		a.sz += sz
		a.closedPnl += pnl
		a.pxSz += px * sz
		m[*f.Cloid] = a
	}
	out := make(map[string]Fill)
	for cloid, a := range m {
		px := 0.0
		if a.sz > 0 {
			px = a.pxSz / a.sz
		}
		out[cloid] = Fill{Sz: a.sz, Px: px, ClosedPnl: a.closedPnl}
	}
	return out, nil
}

// fillsMaxPages caps userFillsByTime pagination so a hot account can't spin the
// loop unbounded; on hitting it FillsByCloidSince returns what it has (best-effort;
// the ledger orphan detection backstops any gap).
const fillsMaxPages = 50

// FillsByCloidSince pages userFillsByTime forward from startMs (unix ms),
// aggregating fills by cloid (dedup by trade id across page boundaries) until an
// empty page, a page holding only already-seen fills, or fillsMaxPages. Null-cloid
// fills are dropped. The cursor advances to the page's max fill time (inclusive
// re-query next page) so fills sharing the boundary millisecond across a page split
// are not skipped; tid-dedup absorbs the resulting overlap.
func (c *Client) FillsByCloidSince(ctx context.Context, user string, startMs int64) (map[string]Fill, error) {
	type acc struct{ sz, closedPnl, pxSz float64 }
	m := make(map[string]acc)
	seen := make(map[int64]struct{}) // dedup by tid across pages
	cursor := startMs
	for page := 0; page < fillsMaxPages; page++ {
		var raw []rawFill
		if err := c.post(ctx, map[string]any{"type": "userFillsByTime", "user": user, "startTime": cursor}, &raw); err != nil {
			return nil, err
		}
		if len(raw) == 0 {
			break
		}
		var maxTime int64
		newInPage := 0
		for _, f := range raw {
			if f.Time > maxTime {
				maxTime = f.Time
			}
			if _, dup := seen[f.Tid]; dup {
				continue
			}
			seen[f.Tid] = struct{}{}
			newInPage++
			if f.Cloid == nil {
				continue
			}
			sz, _ := strconv.ParseFloat(f.Sz, 64)
			px, _ := strconv.ParseFloat(f.Px, 64)
			pnl, _ := strconv.ParseFloat(f.ClosedPnl, 64)
			a := m[*f.Cloid]
			a.sz += sz
			a.closedPnl += pnl
			a.pxSz += px * sz
			m[*f.Cloid] = a
		}
		if newInPage == 0 {
			break // page held only already-seen fills → caught up
		}
		cursor = maxTime // inclusive re-query; tid-dedup handles the boundary overlap
	}
	out := make(map[string]Fill)
	for cloid, a := range m {
		px := 0.0
		if a.sz > 0 {
			px = a.pxSz / a.sz
		}
		out[cloid] = Fill{Sz: a.sz, Px: px, ClosedPnl: a.closedPnl}
	}
	return out, nil
}
