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
