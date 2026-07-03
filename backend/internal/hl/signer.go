package hl

import (
	"errors"

	secp "github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
)

// Sig is an Ethereum-style ECDSA signature. V is 27 or 28.
type Sig struct {
	R [32]byte
	S [32]byte
	V byte
}

// Signer holds a secp256k1 private key in-process (tier ①). Go GC cannot guarantee
// erasure; Close is a best-effort zeroization (see BACKEND-ARCHITECTURE §5 tier ①).
type Signer struct {
	key    *secp.PrivateKey
	keyBuf []byte
	closed bool
}

// NewSigner takes a 32-byte private key.
func NewSigner(priv []byte) (*Signer, error) {
	if len(priv) != 32 {
		return nil, errors.New("signer: private key must be 32 bytes")
	}
	buf := make([]byte, 32)
	copy(buf, priv)
	return &Signer{key: secp.PrivKeyFromBytes(buf), keyBuf: buf}, nil
}

// SignL1Action hashes the action + signs the EIP-712 Agent digest.
func (s *Signer) SignL1Action(action Map, nonce uint64, isTestnet bool) (Sig, error) {
	if s.closed {
		return Sig{}, errors.New("signer: closed")
	}
	conn, err := L1ActionHash(action, nonce, nil, nil)
	if err != nil {
		return Sig{}, err
	}
	digest := AgentDigest(conn, isTestnet)
	return signDigest(s.key, digest)
}

// Close best-effort zeroizes the key buffer.
func (s *Signer) Close() {
	for i := range s.keyBuf {
		s.keyBuf[i] = 0
	}
	s.key = nil
	s.closed = true
}

// signDigest produces an Ethereum-style {r,s,v} over a 32-byte digest, low-S, v in {27,28}.
func signDigest(key *secp.PrivateKey, digest [32]byte) (Sig, error) {
	// SignCompact returns 65 bytes: [recoveryCode+27 (+4 if compressed)] || R(32) || S(32), low-S enforced.
	compact := ecdsa.SignCompact(key, digest[:], false)
	var sig Sig
	recovery := compact[0] - 27
	sig.V = 27 + (recovery & 1)
	copy(sig.R[:], compact[1:33])
	copy(sig.S[:], compact[33:65])
	return sig, nil
}
