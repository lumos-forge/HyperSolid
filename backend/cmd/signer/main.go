// Command signer is the M5 signing service (phase 1: keyless digest endpoints).
// It does NOT hold keys, sign, or persist anything; it only reproduces HL action
// hashes/digests for cross-language shadow verification.
package main

import (
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"os"

	"github.com/lumos-forge/hypersolid/backend/internal/hl"
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

// newMux builds the service router (no side effects; testable).
func newMux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/v1/digest/l1", handleDigestL1)
	return mux
}

func main() {
	addr := os.Getenv("SIGNER_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8087"
	}
	log.Printf("signer digest service listening on %s", addr)
	if err := http.ListenAndServe(addr, newMux()); err != nil {
		log.Fatal(err)
	}
}
