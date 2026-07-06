package hl

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

type moreVector struct {
	Name             string    `json:"name"`
	Action           string    `json:"action"`
	SignatureChainID string    `json:"signatureChainId"`
	HyperliquidChain string    `json:"hyperliquidChain"`
	Destination      string    `json:"destination"`
	Amount           string    `json:"amount"`
	Time             uint64    `json:"time"`
	MaxFeeRate       string    `json:"maxFeeRate"`
	Builder          string    `json:"builder"`
	Nonce            uint64    `json:"nonce"`
	ToPerp           bool      `json:"toPerp"`
	Token            string    `json:"token"`
	PrivKey          string    `json:"privKey"`
	Digest           string    `json:"digest"`
	Sig              goldenSig `json:"sig"`
}

func loadMoreGolden(t *testing.T) []moreVector {
	t.Helper()
	raw, err := os.ReadFile("testdata/golden_usersigned_more.json")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var vs []moreVector
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(vs) == 0 {
		t.Fatal("empty golden_usersigned_more.json")
	}
	return vs
}

func moreDigest(t *testing.T, v moreVector) [32]byte {
	t.Helper()
	var d [32]byte
	var err error
	switch v.Action {
	case "withdraw3":
		d, err = Withdraw3Digest(Withdraw3Input{v.SignatureChainID, v.HyperliquidChain, v.Destination, v.Amount, v.Time})
	case "usdSend":
		d, err = UsdSendDigest(UsdSendInput{v.SignatureChainID, v.HyperliquidChain, v.Destination, v.Amount, v.Time})
	case "approveBuilderFee":
		d, err = ApproveBuilderFeeDigest(ApproveBuilderFeeInput{v.SignatureChainID, v.HyperliquidChain, v.MaxFeeRate, v.Builder, v.Nonce})
	case "usdClassTransfer":
		d, err = UsdClassTransferDigest(UsdClassTransferInput{v.SignatureChainID, v.HyperliquidChain, v.Amount, v.ToPerp, v.Nonce})
	case "spotSend":
		d, err = SpotSendDigest(SpotSendInput{v.SignatureChainID, v.HyperliquidChain, v.Destination, v.Token, v.Amount, v.Time})
	default:
		t.Fatalf("unknown action %q", v.Action)
	}
	if err != nil {
		t.Fatalf("digest: %v", err)
	}
	return d
}

func TestMoreDigestGolden(t *testing.T) {
	for _, v := range loadMoreGolden(t) {
		t.Run(v.Name, func(t *testing.T) {
			got := moreDigest(t, v)
			if hex.EncodeToString(got[:]) != v.Digest[2:] {
				t.Fatalf("digest = 0x%s, want %s", hex.EncodeToString(got[:]), v.Digest)
			}
		})
	}
}

func moreSign(t *testing.T, s *Signer, v moreVector) (Sig, error) {
	t.Helper()
	switch v.Action {
	case "withdraw3":
		return s.SignWithdraw3(Withdraw3Input{v.SignatureChainID, v.HyperliquidChain, v.Destination, v.Amount, v.Time})
	case "usdSend":
		return s.SignUsdSend(UsdSendInput{v.SignatureChainID, v.HyperliquidChain, v.Destination, v.Amount, v.Time})
	case "approveBuilderFee":
		return s.SignApproveBuilderFee(ApproveBuilderFeeInput{v.SignatureChainID, v.HyperliquidChain, v.MaxFeeRate, v.Builder, v.Nonce})
	case "usdClassTransfer":
		return s.SignUsdClassTransfer(UsdClassTransferInput{v.SignatureChainID, v.HyperliquidChain, v.Amount, v.ToPerp, v.Nonce})
	case "spotSend":
		return s.SignSpotSend(SpotSendInput{v.SignatureChainID, v.HyperliquidChain, v.Destination, v.Token, v.Amount, v.Time})
	}
	t.Fatalf("unknown action %q", v.Action)
	return Sig{}, nil
}

func TestMoreSignGolden(t *testing.T) {
	for _, v := range loadMoreGolden(t) {
		t.Run(v.Name, func(t *testing.T) {
			key, err := hex.DecodeString(v.PrivKey[2:])
			if err != nil {
				t.Fatalf("decode key: %v", err)
			}
			s, err := NewSigner(key)
			if err != nil {
				t.Fatalf("NewSigner: %v", err)
			}
			defer s.Close()
			sig, err := moreSign(t, s, v)
			if err != nil {
				t.Fatalf("sign: %v", err)
			}
			gotR := "0x" + hex.EncodeToString(sig.R[:])
			gotS := "0x" + hex.EncodeToString(sig.S[:])
			if gotR != v.Sig.R || gotS != v.Sig.S || int(sig.V) != v.Sig.V {
				t.Fatalf("sig = {r:%s s:%s v:%d}, want {r:%s s:%s v:%d}", gotR, gotS, sig.V, v.Sig.R, v.Sig.S, v.Sig.V)
			}
		})
	}
}
