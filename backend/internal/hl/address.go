package hl

import (
	"encoding/hex"
	"errors"

	secp "github.com/decred/dcrd/dcrec/secp256k1/v4"
)

// AddressFromPriv derives the lowercase 0x Ethereum address of a secp256k1 private key:
// keccak256 of the uncompressed public key X||Y (drop the 0x04 prefix), last 20 bytes.
func AddressFromPriv(priv []byte) (string, error) {
	if len(priv) != 32 {
		return "", errors.New("hl: private key must be 32 bytes")
	}
	pub := secp.PrivKeyFromBytes(priv).PubKey().SerializeUncompressed() // 65 bytes: 0x04||X||Y
	h := keccak(pub[1:])
	return "0x" + hex.EncodeToString(h[12:]), nil
}
