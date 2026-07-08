package ledger_test

import (
	"testing"

	"github.com/lumos-forge/hypersolid/backend/internal/ledger"
	"github.com/lumos-forge/hypersolid/backend/internal/ledger/conformance"
)

func TestMemConformance(t *testing.T) {
	conformance.Run(t, func() ledger.Authorizer { return ledger.NewMem() })
}

func TestMemReconcileConformance(t *testing.T) {
	conformance.RunReconcile(t, func() ledger.Ledger { return ledger.NewMem() })
}
