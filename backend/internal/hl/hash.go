package hl

import (
	"encoding/binary"

	"golang.org/x/crypto/sha3"
)

// L1ActionHash reproduces @nktkas/hyperliquid createL1ActionHash:
// keccak256( msgpack(action) || nonce(8B big-endian) || vaultMarker || vaultBytes || expiresMarker || expiresBytes ).
// vaultAddress is the 20-byte address or nil; expiresAfter is *uint64 or nil.
func L1ActionHash(action Map, nonce uint64, vaultAddress []byte, expiresAfter *uint64) ([32]byte, error) {
	actionBytes, err := Encode(action)
	if err != nil {
		return [32]byte{}, err
	}
	buf := make([]byte, 0, len(actionBytes)+40)
	buf = append(buf, actionBytes...)
	buf = binary.BigEndian.AppendUint64(buf, nonce)
	if vaultAddress != nil {
		buf = append(buf, 1)
		buf = append(buf, vaultAddress...)
	} else {
		buf = append(buf, 0)
	}
	if expiresAfter != nil {
		buf = append(buf, 0)
		buf = binary.BigEndian.AppendUint64(buf, *expiresAfter)
	}
	h := sha3.NewLegacyKeccak256()
	h.Write(buf)
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out, nil
}
