import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createL1ActionHash } from "@nktkas/hyperliquid/signing";
import { actionFromKindParams } from "./l1Action";

/**
 * Cross-module canonical-action parity: the Go signer's golden vectors carry the authoritative
 * `actionHash` (the msgpack hash of `{action, nonce}`) for each kind. This guards that the engine's
 * TS action builder (`l1Action.actionFromKindParams`) produces a byte-identical action — so the
 * pre-signed action the engine submits to HL /exchange hashes to exactly what the signer signed. A
 * drift here would make Hyperliquid reject every delegated signature; this catches it at CI time
 * (in addition to the runtime shadow verifier), covering `scheduleCancel`/`cancelByCloid` which the
 * shadow rarely exercises.
 *
 * Source of truth: backend/internal/hl/testdata/golden.json (generated from the @nktkas oracle and the
 * Go signer's DigestL1).
 */
interface GoldenVector {
  name: string;
  kind: string;
  params: unknown;
  nonce: number;
  isTestnet: boolean;
  actionHash: string;
}

const GOLDEN_PATH = join(__dirname, "../../../backend/internal/hl/testdata/golden.json");
const vectors = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenVector[];

/** The kinds the engine builds locally for the sign-then-submit path. */
const supported = vectors.filter((v) => actionFromKindParams(v.kind, v.params) !== undefined);

describe("l1Action golden parity (matches the Go signer's actionHash)", () => {
  it("covers order, cancelByCloid, and scheduleCancel from the golden set", () => {
    const kinds = new Set(supported.map((v) => v.kind));
    expect(kinds.has("order")).toBe(true);
    expect(kinds.has("cancelByCloid")).toBe(true);
    expect(kinds.has("scheduleCancel")).toBe(true);
    // Guard against a misread/empty file silently passing the per-vector assertions below.
    expect(supported.length).toBeGreaterThanOrEqual(6);
  });

  it.each(supported.map((v) => [v.name, v] as const))(
    "%s: built action hashes to the golden actionHash",
    (_name, v) => {
      const action = actionFromKindParams(v.kind, v.params) as Record<string, unknown>;
      const hash = createL1ActionHash({ action, nonce: v.nonce });
      expect(hash.toLowerCase()).toBe(v.actionHash.toLowerCase());
    },
  );
});
