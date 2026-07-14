package hl

import (
	"encoding/json"
	"fmt"
)

// ActionFromKind rebuilds the ordered msgpack action Map from a semantic kind + JSON params.
// It is the single source of truth shared by the golden tests and the signer service.
func ActionFromKind(kind string, params json.RawMessage) (Map, error) {
	switch kind {
	case "order":
		var p struct {
			Asset      int64  `json:"asset"`
			IsBuy      bool   `json:"isBuy"`
			Px         string `json:"px"`
			Sz         string `json:"sz"`
			ReduceOnly bool   `json:"reduceOnly"`
			Tif        string `json:"tif"`
			Grouping   string `json:"grouping"`
			Cloid      string `json:"cloid"`
			Builder    *struct {
				B string `json:"b"`
				F int64  `json:"f"`
			} `json:"builder"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		var builder *BuilderInput
		if p.Builder != nil {
			builder = &BuilderInput{Address: p.Builder.B, FeeTenthBps: p.Builder.F}
		}
		return BuildOrderAction([]OrderInput{{Asset: p.Asset, IsBuy: p.IsBuy, Px: p.Px, Sz: p.Sz, ReduceOnly: p.ReduceOnly, Tif: p.Tif, Cloid: p.Cloid}}, p.Grouping, builder), nil
	case "cancel":
		var p struct {
			Cancels []struct {
				Asset int64 `json:"asset"`
				Oid   int64 `json:"oid"`
			} `json:"cancels"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		ins := make([]CancelInput, len(p.Cancels))
		for i, c := range p.Cancels {
			ins[i] = CancelInput{Asset: c.Asset, Oid: c.Oid}
		}
		return BuildCancelAction(ins), nil
	case "twapOrder":
		var p struct {
			Asset      int64  `json:"asset"`
			IsBuy      bool   `json:"isBuy"`
			Sz         string `json:"sz"`
			ReduceOnly bool   `json:"reduceOnly"`
			Minutes    int64  `json:"minutes"`
			Randomize  bool   `json:"randomize"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return BuildTwapOrderAction(p.Asset, p.IsBuy, p.Sz, p.ReduceOnly, p.Minutes, p.Randomize), nil
	case "twapCancel":
		var p struct {
			Asset  int64 `json:"asset"`
			TwapID int64 `json:"twapId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return BuildTwapCancelAction(p.Asset, p.TwapID), nil
	case "cancelByCloid":
		var p struct {
			Cancels []struct {
				Asset int64  `json:"asset"`
				Cloid string `json:"cloid"`
			} `json:"cancels"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		ins := make([]CancelByCloidInput, len(p.Cancels))
		for i, c := range p.Cancels {
			ins[i] = CancelByCloidInput{Asset: c.Asset, Cloid: c.Cloid}
		}
		return BuildCancelByCloidAction(ins), nil
	case "modify":
		var p struct {
			OidNum   int64  `json:"oidNum"`
			OidCloid string `json:"oidCloid"`
			Order    struct {
				Asset      int64  `json:"asset"`
				IsBuy      bool   `json:"isBuy"`
				Px         string `json:"px"`
				Sz         string `json:"sz"`
				ReduceOnly bool   `json:"reduceOnly"`
				Tif        string `json:"tif"`
				Cloid      string `json:"cloid"`
			} `json:"order"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return BuildModifyAction(ModifyInput{
			Oid:   p.OidNum,
			Cloid: p.OidCloid,
			Order: OrderInput{Asset: p.Order.Asset, IsBuy: p.Order.IsBuy, Px: p.Order.Px, Sz: p.Order.Sz, ReduceOnly: p.Order.ReduceOnly, Tif: p.Order.Tif, Cloid: p.Order.Cloid},
		}), nil
	case "updateLeverage":
		var p struct {
			Asset    int64 `json:"asset"`
			IsCross  bool  `json:"isCross"`
			Leverage int64 `json:"leverage"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return BuildUpdateLeverageAction(p.Asset, p.IsCross, p.Leverage), nil
	case "batchModify":
		var p struct {
			Modifies []struct {
				OidNum   int64  `json:"oidNum"`
				OidCloid string `json:"oidCloid"`
				Order    struct {
					Asset      int64  `json:"asset"`
					IsBuy      bool   `json:"isBuy"`
					Px         string `json:"px"`
					Sz         string `json:"sz"`
					ReduceOnly bool   `json:"reduceOnly"`
					Tif        string `json:"tif"`
					Cloid      string `json:"cloid"`
				} `json:"order"`
			} `json:"modifies"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		mods := make([]ModifyInput, len(p.Modifies))
		for i, m := range p.Modifies {
			mods[i] = ModifyInput{
				Oid:   m.OidNum,
				Cloid: m.OidCloid,
				Order: OrderInput{Asset: m.Order.Asset, IsBuy: m.Order.IsBuy, Px: m.Order.Px, Sz: m.Order.Sz, ReduceOnly: m.Order.ReduceOnly, Tif: m.Order.Tif, Cloid: m.Order.Cloid},
			}
		}
		return BuildBatchModifyAction(mods), nil
	case "updateIsolatedMargin":
		var p struct {
			Asset int64 `json:"asset"`
			IsBuy bool  `json:"isBuy"`
			Ntli  int64 `json:"ntli"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return BuildUpdateIsolatedMarginAction(p.Asset, p.IsBuy, p.Ntli), nil
	case "scheduleCancel":
		var p struct {
			Time *int64 `json:"time"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return BuildScheduleCancelAction(p.Time), nil
	}
	return nil, fmt.Errorf("unknown kind %q", kind)
}

// DigestL1 rebuilds the action and returns the L1 action hash + phantom-agent EIP-712 digest.
func DigestL1(kind string, params json.RawMessage, nonce uint64, isTestnet bool) (actionHash, agentDigest [32]byte, err error) {
	action, err := ActionFromKind(kind, params)
	if err != nil {
		return [32]byte{}, [32]byte{}, err
	}
	ah, err := L1ActionHash(action, nonce, nil, nil)
	if err != nil {
		return [32]byte{}, [32]byte{}, err
	}
	return ah, AgentDigest(ah, isTestnet), nil
}
