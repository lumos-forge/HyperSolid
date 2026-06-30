import "react-native-get-random-values";

/**
 * Client order id (cloid) — 16-byte hex, generated and persisted BEFORE signing
 * so retries reuse the same id (idempotent ordering, spec §6.2 / gap analysis B5).
 */
export function generateCloid(): `0x${string}` {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `0x${hex}`;
}

export function isValidCloid(cloid: string): boolean {
  return /^0x[0-9a-fA-F]{32}$/.test(cloid);
}

/**
 * Deterministically derive a secondary-leg cloid from a primary cloid + leg index, so a multi-leg
 * order action (bracket TP/SL, scale ladder) reproduces the EXACT same per-leg cloids on every retry.
 * Without this, an uncertain-receipt retry would re-issue secondary legs under fresh random cloids and
 * HL would accept them as brand-new orders (duplicate real exposure). Index 0 returns the primary
 * unchanged; index > 0 mixes the index into the low 2 bytes, keeping a valid 16-byte hex id.
 */
export function deriveCloid(primary: `0x${string}`, index: number): `0x${string}` {
  if (index === 0) return primary;
  const bytes = new Uint8Array(16);
  const hex = primary.slice(2);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  bytes[15] = bytes[15] ^ (index & 0xff);
  bytes[14] = bytes[14] ^ ((index >> 8) & 0xff);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return `0x${out}`;
}
