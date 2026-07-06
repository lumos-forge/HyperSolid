// Command signer is the M5 signing service. It exposes keyless digest endpoints
// (/healthz, /v1/digest/l1) plus a keystore-backed L1 signing endpoint (/v1/sign/l1).
// The shipped binary starts with an EMPTY keystore (fail-closed: nothing is signable)
// and has no key-injection path. It performs NO policy checks — a reject-first policy
// layer must wrap /v1/sign/l1 before any production use (docs/BACKEND-ARCHITECTURE.md §5.1a).
package main

import (
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"os"

	"github.com/lumos-forge/hypersolid/backend/internal/hl"
	"github.com/lumos-forge/hypersolid/backend/internal/keystore"
)

type digestL1Request struct {
	Kind      string          `json:"kind"`
	Params    json.RawMessage `json:"params"`
	Nonce     uint64          `json:"nonce"`
	IsTestnet bool            `json:"isTestnet"`
}

type digestL1Response struct {
	ActionHash  string `json:"actionHash"`
	AgentDigest string `json:"agentDigest"`
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func handleDigestL1(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req digestL1Request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	ah, ad, err := hl.DigestL1(req.Kind, req.Params, req.Nonce, req.IsTestnet)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(digestL1Response{
		ActionHash:  "0x" + hex.EncodeToString(ah[:]),
		AgentDigest: "0x" + hex.EncodeToString(ad[:]),
	})
}

type signL1Request struct {
	KeyID     string          `json:"keyId"`
	Kind      string          `json:"kind"`
	Params    json.RawMessage `json:"params"`
	Nonce     uint64          `json:"nonce"`
	IsTestnet bool            `json:"isTestnet"`
}

type signL1Response struct {
	R string `json:"r"`
	S string `json:"s"`
	V int    `json:"v"`
}

// handleSignL1 signs an L1 action with the keystore signer named by keyId.
// Fail-closed: an unknown keyId returns 404. Never logs key material.
func handleSignL1(ks *keystore.Keystore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req signL1Request
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json: "+err.Error())
			return
		}
		signer, ok := ks.Signer(req.KeyID)
		if !ok {
			writeErr(w, http.StatusNotFound, "unknown keyId")
			return
		}
		action, err := hl.ActionFromKind(req.Kind, req.Params)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		sig, err := signer.SignL1Action(action, req.Nonce, req.IsTestnet)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "sign failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(signL1Response{
			R: "0x" + hex.EncodeToString(sig.R[:]),
			S: "0x" + hex.EncodeToString(sig.S[:]),
			V: int(sig.V),
		})
	}
}

// newMux builds the service router (no side effects; testable).
// The digest endpoints are keyless; /v1/sign/l1 uses the injected keystore.
func newMux(ks *keystore.Keystore) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/v1/digest/l1", handleDigestL1)
	mux.HandleFunc("/v1/sign/l1", handleSignL1(ks))
	return mux
}

func main() {
	addr := os.Getenv("SIGNER_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8087"
	}
	ks := keystore.New()
	log.Printf("signer service listening on %s (keystore empty; fail-closed)", addr)
	if err := http.ListenAndServe(addr, newMux(ks)); err != nil {
		log.Fatal(err)
	}
}
