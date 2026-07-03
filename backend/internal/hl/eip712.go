package hl

import (
	"math/big"

	"golang.org/x/crypto/sha3"
)

func keccak(parts ...[]byte) [32]byte {
	h := sha3.NewLegacyKeccak256()
	for _, p := range parts {
		h.Write(p)
	}
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

// word left-pads a big.Int to a 32-byte ABI word.
func word(n *big.Int) []byte {
	b := n.Bytes()
	out := make([]byte, 32)
	copy(out[32-len(b):], b)
	return out
}

// AgentDigest reproduces the EIP-712 digest signL1Action signs:
// domain Exchange/1/chainId 1337/verifyingContract 0x0; Agent(string source,bytes32 connectionId);
// message { source: isTestnet?"b":"a", connectionId }.
func AgentDigest(connectionID [32]byte, isTestnet bool) [32]byte {
	domainTypeHash := keccak([]byte("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"))
	nameHash := keccak([]byte("Exchange"))
	versionHash := keccak([]byte("1"))
	chainID := word(big.NewInt(1337))
	verifyingContract := make([]byte, 32) // address(0) left-padded
	domainSeparator := keccak(domainTypeHash[:], nameHash[:], versionHash[:], chainID, verifyingContract)

	agentTypeHash := keccak([]byte("Agent(string source,bytes32 connectionId)"))
	source := "a"
	if isTestnet {
		source = "b"
	}
	sourceHash := keccak([]byte(source))
	structHash := keccak(agentTypeHash[:], sourceHash[:], connectionID[:])

	return keccak([]byte{0x19, 0x01}, domainSeparator[:], structHash[:])
}
