import { createHmac, timingSafeEqual } from "crypto";

interface Payload {
  sub: string;
  exp: number;
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

/**
 * Issue a compact HMAC-signed session token (`header.payload.sig`, base64url). Carries the verified
 * owner (`sub`, lowercased) and an absolute expiry. No third-party JWT dependency — this is a stable,
 * self-contained bearer token. `owner` is lowercased so address casing never matters downstream.
 */
export function issueToken(owner: string, secret: string, now: number, ttlMs: number): string {
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const payload = b64url({ sub: owner.toLowerCase(), exp: now + ttlMs } satisfies Payload);
  const sig = sign(`${header}.${payload}`, secret);
  return `${header}.${payload}.${sig}`;
}

/** Verify a token's signature + expiry; returns the owner (`sub`) or null if invalid/expired. */
export function verifyToken(token: string, secret: string, now: number): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expected = sign(`${header}.${payload}`, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString()) as Payload;
    if (typeof decoded.exp !== "number" || decoded.exp <= now) return null;
    return decoded.sub;
  } catch {
    return null;
  }
}
