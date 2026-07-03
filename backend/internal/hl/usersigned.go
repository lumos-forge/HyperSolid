package hl

import (
	"encoding/hex"
	"fmt"
	"math/big"
	"strconv"
	"strings"
)

// Field is one EIP-712 typed field. Type ∈ "string" | "address" | "uint64".
type Field struct {
	Name string
	Type string
}

// encodeField encodes a single EIP-712 field value to its 32-byte word.
func encodeField(f Field, val any) ([]byte, error) {
	switch f.Type {
	case "string":
		s, ok := val.(string)
		if !ok {
			return nil, fmt.Errorf("field %q: expected string, got %T", f.Name, val)
		}
		h := keccak([]byte(s))
		return h[:], nil
	case "address":
		s, ok := val.(string)
		if !ok {
			return nil, fmt.Errorf("field %q: expected address string, got %T", f.Name, val)
		}
		b, err := hex.DecodeString(strings.TrimPrefix(strings.ToLower(s), "0x"))
		if err != nil {
			return nil, fmt.Errorf("field %q: bad address hex: %w", f.Name, err)
		}
		if len(b) != 20 {
			return nil, fmt.Errorf("field %q: address must be 20 bytes, got %d", f.Name, len(b))
		}
		out := make([]byte, 32)
		copy(out[12:], b)
		return out, nil
	case "uint64":
		n, ok := val.(uint64)
		if !ok {
			return nil, fmt.Errorf("field %q: expected uint64, got %T", f.Name, val)
		}
		return word(new(big.Int).SetUint64(n)), nil
	default:
		return nil, fmt.Errorf("field %q: unsupported type %q", f.Name, f.Type)
	}
}

// userSignedTypeString builds the EIP-712 encodeType string: `Primary(type1 name1,type2 name2,...)`.
func userSignedTypeString(primaryType string, fields []Field) string {
	var sb strings.Builder
	sb.WriteString(primaryType)
	sb.WriteByte('(')
	for i, f := range fields {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString(f.Type)
		sb.WriteByte(' ')
		sb.WriteString(f.Name)
	}
	sb.WriteByte(')')
	return sb.String()
}

// UserSignedDigest builds the EIP-712 digest for a HyperliquidSignTransaction-domain action.
// `message` maps each field name to its value (string, a 0x-address string, or uint64).
func UserSignedDigest(primaryType string, fields []Field, chainID uint64, message map[string]any) ([32]byte, error) {
	typeHash := keccak([]byte(userSignedTypeString(primaryType, fields)))
	parts := make([][]byte, 0, len(fields)+1)
	parts = append(parts, typeHash[:])
	for _, f := range fields {
		val, ok := message[f.Name]
		if !ok {
			return [32]byte{}, fmt.Errorf("missing message field %q", f.Name)
		}
		w, err := encodeField(f, val)
		if err != nil {
			return [32]byte{}, err
		}
		parts = append(parts, w)
	}
	structHash := keccak(parts...)

	domainTypeHash := keccak([]byte("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"))
	nameHash := keccak([]byte("HyperliquidSignTransaction"))
	versionHash := keccak([]byte("1"))
	chainWord := word(new(big.Int).SetUint64(chainID))
	verifyingContract := make([]byte, 32) // address(0)
	domainSeparator := keccak(domainTypeHash[:], nameHash[:], versionHash[:], chainWord, verifyingContract)

	return keccak([]byte{0x19, 0x01}, domainSeparator[:], structHash[:]), nil
}

// ApproveAgentInput is the semantic input for an approveAgent user-signed action.
type ApproveAgentInput struct {
	SignatureChainID string // hex, e.g. "0xa4b1" (drives the domain chainId)
	HyperliquidChain string // "Mainnet" | "Testnet" (signed replay-protection field)
	AgentAddress     string // 0x… 20-byte
	AgentName        string // "" when none
	Nonce            uint64
}

// approveAgentFields is the ordered EIP-712 type table for HyperliquidTransaction:ApproveAgent.
var approveAgentFields = []Field{
	{"hyperliquidChain", "string"},
	{"agentAddress", "address"},
	{"agentName", "string"},
	{"nonce", "uint64"},
}

// ApproveAgentDigest builds the EIP-712 digest for an approveAgent action.
func ApproveAgentDigest(in ApproveAgentInput) ([32]byte, error) {
	chainID, err := parseHexChainID(in.SignatureChainID)
	if err != nil {
		return [32]byte{}, err
	}
	message := map[string]any{
		"hyperliquidChain": in.HyperliquidChain,
		"agentAddress":     in.AgentAddress,
		"agentName":        in.AgentName,
		"nonce":            in.Nonce,
	}
	return UserSignedDigest("HyperliquidTransaction:ApproveAgent", approveAgentFields, chainID, message)
}

func parseHexChainID(s string) (uint64, error) {
	h := strings.TrimPrefix(strings.ToLower(s), "0x")
	if h == "" {
		return 0, fmt.Errorf("empty signatureChainId")
	}
	return strconv.ParseUint(h, 16, 64)
}

// --- withdraw3 / usdSend (identical field table, different primaryType) ---

// usdTransferFields is the shared EIP-712 field table for withdraw3 and usdSend.
var usdTransferFields = []Field{
	{"hyperliquidChain", "string"},
	{"destination", "string"},
	{"amount", "string"},
	{"time", "uint64"},
}

type Withdraw3Input struct {
	SignatureChainID string
	HyperliquidChain string
	Destination      string
	Amount           string
	Time             uint64
}

func Withdraw3Digest(in Withdraw3Input) ([32]byte, error) {
	chainID, err := parseHexChainID(in.SignatureChainID)
	if err != nil {
		return [32]byte{}, err
	}
	return UserSignedDigest("HyperliquidTransaction:Withdraw", usdTransferFields, chainID, map[string]any{
		"hyperliquidChain": in.HyperliquidChain, "destination": in.Destination, "amount": in.Amount, "time": in.Time,
	})
}

type UsdSendInput struct {
	SignatureChainID string
	HyperliquidChain string
	Destination      string
	Amount           string
	Time             uint64
}

func UsdSendDigest(in UsdSendInput) ([32]byte, error) {
	chainID, err := parseHexChainID(in.SignatureChainID)
	if err != nil {
		return [32]byte{}, err
	}
	return UserSignedDigest("HyperliquidTransaction:UsdSend", usdTransferFields, chainID, map[string]any{
		"hyperliquidChain": in.HyperliquidChain, "destination": in.Destination, "amount": in.Amount, "time": in.Time,
	})
}

// --- approveBuilderFee ---

var approveBuilderFeeFields = []Field{
	{"hyperliquidChain", "string"},
	{"maxFeeRate", "string"},
	{"builder", "address"},
	{"nonce", "uint64"},
}

type ApproveBuilderFeeInput struct {
	SignatureChainID string
	HyperliquidChain string
	MaxFeeRate       string
	Builder          string
	Nonce            uint64
}

func ApproveBuilderFeeDigest(in ApproveBuilderFeeInput) ([32]byte, error) {
	chainID, err := parseHexChainID(in.SignatureChainID)
	if err != nil {
		return [32]byte{}, err
	}
	return UserSignedDigest("HyperliquidTransaction:ApproveBuilderFee", approveBuilderFeeFields, chainID, map[string]any{
		"hyperliquidChain": in.HyperliquidChain, "maxFeeRate": in.MaxFeeRate, "builder": in.Builder, "nonce": in.Nonce,
	})
}
