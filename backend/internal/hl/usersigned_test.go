package hl

import (
	"bytes"
	"encoding/hex"
	"testing"
)

func TestEncodeField(t *testing.T) {
	got, err := encodeField(Field{"agentName", "string"}, "")
	if err != nil {
		t.Fatalf("string: %v", err)
	}
	if hex.EncodeToString(got) != "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470" {
		t.Fatalf("keccak(\"\") = %x", got)
	}
	addr, err := encodeField(Field{"agentAddress", "address"}, "0x000000000000000000000000000000000000dEaD")
	if err != nil {
		t.Fatalf("address: %v", err)
	}
	want := make([]byte, 32)
	want[30], want[31] = 0xde, 0xad
	if !bytes.Equal(addr, want) {
		t.Fatalf("address word = %x, want %x", addr, want)
	}
	n, err := encodeField(Field{"nonce", "uint64"}, uint64(7))
	if err != nil {
		t.Fatalf("uint64: %v", err)
	}
	if len(n) != 32 || n[31] != 7 {
		t.Fatalf("uint64 word = %x", n)
	}
}

func TestEncodeFieldErrors(t *testing.T) {
	if _, err := encodeField(Field{"x", "address"}, "0xzz"); err == nil {
		t.Fatal("expected bad-address error")
	}
	if _, err := encodeField(Field{"x", "address"}, "0x1234"); err == nil {
		t.Fatal("expected wrong-length address error")
	}
	if _, err := encodeField(Field{"x", "bytes32"}, "0x00"); err == nil {
		t.Fatal("expected unknown-type error")
	}
	if _, err := encodeField(Field{"x", "string"}, uint64(1)); err == nil {
		t.Fatal("expected wrong-Go-type error")
	}
}

func TestUserSignedTypeString(t *testing.T) {
	got := userSignedTypeString("HyperliquidTransaction:ApproveAgent", []Field{
		{"hyperliquidChain", "string"}, {"agentAddress", "address"}, {"agentName", "string"}, {"nonce", "uint64"},
	})
	want := "HyperliquidTransaction:ApproveAgent(string hyperliquidChain,address agentAddress,string agentName,uint64 nonce)"
	if got != want {
		t.Fatalf("type string = %q", got)
	}
}

func TestApproveAgentDigestFailsClosed(t *testing.T) {
	base := ApproveAgentInput{
		SignatureChainID: "0xa4b1",
		HyperliquidChain: "Mainnet",
		AgentAddress:     "0x000000000000000000000000000000000000dEaD",
		AgentName:        "x",
		Nonce:            1,
	}
	// Malformed signatureChainId must error without producing a digest.
	for _, bad := range []string{"", "0x", "0xzz", "nothex"} {
		in := base
		in.SignatureChainID = bad
		if _, err := ApproveAgentDigest(in); err == nil {
			t.Fatalf("expected error for signatureChainId %q", bad)
		}
	}
	// Malformed agentAddress must error without producing a digest.
	for _, bad := range []string{"0x1234", "0xZZ00000000000000000000000000000000000000", "not-an-address"} {
		in := base
		in.AgentAddress = bad
		if _, err := ApproveAgentDigest(in); err == nil {
			t.Fatalf("expected error for agentAddress %q", bad)
		}
	}
}

func TestMoreUserSignedFieldTables(t *testing.T) {
	if got := userSignedTypeString("HyperliquidTransaction:Withdraw", usdTransferFields); got != "HyperliquidTransaction:Withdraw(string hyperliquidChain,string destination,string amount,uint64 time)" {
		t.Fatalf("withdraw type string = %q", got)
	}
	if got := userSignedTypeString("HyperliquidTransaction:ApproveBuilderFee", approveBuilderFeeFields); got != "HyperliquidTransaction:ApproveBuilderFee(string hyperliquidChain,string maxFeeRate,address builder,uint64 nonce)" {
		t.Fatalf("builderFee type string = %q", got)
	}
}

func TestMoreDigestsFailClosed(t *testing.T) {
	if _, err := Withdraw3Digest(Withdraw3Input{SignatureChainID: "0xzz", HyperliquidChain: "Mainnet", Destination: "0xdead", Amount: "1", Time: 1}); err == nil {
		t.Fatal("withdraw3: expected chainId error")
	}
	if _, err := UsdSendDigest(UsdSendInput{SignatureChainID: "", HyperliquidChain: "Mainnet", Destination: "0xdead", Amount: "1", Time: 1}); err == nil {
		t.Fatal("usdSend: expected empty-chainId error")
	}
	if _, err := ApproveBuilderFeeDigest(ApproveBuilderFeeInput{SignatureChainID: "0xa4b1", HyperliquidChain: "Mainnet", MaxFeeRate: "0.1%", Builder: "0x1234", Nonce: 1}); err == nil {
		t.Fatal("approveBuilderFee: expected bad-builder-address error")
	}
}

func TestEncodeFieldBool(t *testing.T) {
	tr, err := encodeField(Field{"toPerp", "bool"}, true)
	if err != nil {
		t.Fatalf("bool true: %v", err)
	}
	wantTrue := make([]byte, 32)
	wantTrue[31] = 1
	if !bytes.Equal(tr, wantTrue) {
		t.Fatalf("bool(true) word = %x, want %x", tr, wantTrue)
	}
	fa, err := encodeField(Field{"toPerp", "bool"}, false)
	if err != nil {
		t.Fatalf("bool false: %v", err)
	}
	wantFalse := make([]byte, 32)
	if !bytes.Equal(fa, wantFalse) {
		t.Fatalf("bool(false) word = %x, want all-zero", fa)
	}
	if _, err := encodeField(Field{"toPerp", "bool"}, "nope"); err == nil {
		t.Fatal("expected type error for non-bool value")
	}
}

func TestUsdClassTransferDigestTogglesOnToPerp(t *testing.T) {
	base := UsdClassTransferInput{SignatureChainID: "0xa4b1", HyperliquidChain: "Mainnet", Amount: "100", ToPerp: true, Nonce: 1700000000000}
	toPerp, err := UsdClassTransferDigest(base)
	if err != nil {
		t.Fatalf("toPerp: %v", err)
	}
	off := base
	off.ToPerp = false
	toSpot, err := UsdClassTransferDigest(off)
	if err != nil {
		t.Fatalf("toSpot: %v", err)
	}
	if toPerp == toSpot {
		t.Fatal("digest must differ when toPerp flips")
	}
	if _, err := UsdClassTransferDigest(UsdClassTransferInput{SignatureChainID: "0x", HyperliquidChain: "Mainnet", Amount: "1", Nonce: 1}); err == nil {
		t.Fatal("expected error on empty signatureChainId")
	}
}

func TestSpotSendDigest(t *testing.T) {
	base := SpotSendInput{
		SignatureChainID: "0xa4b1", HyperliquidChain: "Mainnet",
		Destination: "0x000000000000000000000000000000000000dEaD",
		Token:       "USDC:0xeb62eee3685fc4c43992febcd9e75443",
		Amount:      "1", Time: 1700000000000,
	}
	d1, err := SpotSendDigest(base)
	if err != nil {
		t.Fatalf("spotSend: %v", err)
	}
	other := base
	other.Token = "PURR:0x0000000000000000000000000000000000000000"
	d2, err := SpotSendDigest(other)
	if err != nil {
		t.Fatalf("spotSend other token: %v", err)
	}
	if d1 == d2 {
		t.Fatal("digest must differ when token differs")
	}
	if _, err := SpotSendDigest(SpotSendInput{SignatureChainID: "0x"}); err == nil {
		t.Fatal("expected error on empty signatureChainId")
	}
}
