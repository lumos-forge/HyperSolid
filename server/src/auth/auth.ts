import { randomBytes } from "crypto";
import { verifyMessage } from "viem";
import { issueToken, verifyToken } from "./token";

type VerifyMessageFn = (args: { address: `0x${string}`; message: string; signature: `0x${string}` }) => Promise<boolean>;

export interface AuthOptions {
  secret: string;
  nonceTtlMs?: number;
  sessionTtlMs?: number;
  genNonce?: () => string;
  verifyMessageImpl?: VerifyMessageFn;
}

interface Challenge {
  owner: string;
  nonce: string;
  expiresAt: number;
}

/**
 * Wallet-signature session auth. `challenge` issues a single-use nonce bound to an owner; `session`
 * verifies the owner signed exactly that nonce (viem `verifyMessage`, ECDSA recovery) and mints a
 * short-lived bearer token. The owner identity on authed routes always comes from `verify`, never the
 * request body. Nonces are single-use and TTL-bounded to stop replay.
 */
export class Auth {
  private readonly secret: string;
  private readonly nonceTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly genNonce: () => string;
  private readonly verifyMessageImpl: VerifyMessageFn;
  private readonly pending = new Map<string, Challenge>();

  constructor(opts: AuthOptions) {
    this.secret = opts.secret;
    this.nonceTtlMs = opts.nonceTtlMs ?? 5 * 60_000;
    this.sessionTtlMs = opts.sessionTtlMs ?? 24 * 3_600_000;
    this.genNonce = opts.genNonce ?? (() => randomBytes(24).toString("hex"));
    this.verifyMessageImpl = opts.verifyMessageImpl ?? ((args) => verifyMessage(args));
  }

  challenge(owner: string, now: number): { nonce: string } {
    const nonce = `HyperSolid strategy login: ${this.genNonce()}`;
    this.pending.set(this.key(owner, nonce), { owner: owner.toLowerCase(), nonce, expiresAt: now + this.nonceTtlMs });
    return { nonce };
  }

  async session(owner: string, nonce: string, signature: string, now: number): Promise<{ token: string }> {
    const key = this.key(owner, nonce);
    const challenge = this.pending.get(key);
    if (!challenge || challenge.expiresAt <= now) {
      this.pending.delete(key);
      throw new Error("unknown or expired nonce");
    }
    this.pending.delete(key);
    const ok = await this.verifyMessageImpl({
      address: owner as `0x${string}`,
      message: nonce,
      signature: signature as `0x${string}`,
    });
    if (!ok) throw new Error("invalid signature");
    return { token: issueToken(owner, this.secret, now, this.sessionTtlMs) };
  }

  verify(token: string, now: number): string | null {
    return verifyToken(token, this.secret, now);
  }

  private key(owner: string, nonce: string): string {
    return `${owner.toLowerCase()}|${nonce}`;
  }
}
