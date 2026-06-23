import { privateKeyToAccount } from "viem/accounts";
import { Auth } from "./auth";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const account = privateKeyToAccount(PK);
const OWNER = account.address;

function makeAuth() {
  let n = 0;
  return new Auth({ secret: "s", genNonce: () => `nonce-${n++}`, nonceTtlMs: 60_000, sessionTtlMs: 3_600_000 });
}

describe("Auth", () => {
  it("issues a token for a valid signature over the issued nonce, verifiable back to the owner", async () => {
    const auth = makeAuth();
    const { nonce } = auth.challenge(OWNER, 0);
    const signature = await account.signMessage({ message: nonce });

    const { token } = await auth.session(OWNER, nonce, signature, 1000);
    expect(auth.verify(token, 1000)).toBe(OWNER.toLowerCase());
  });

  it("rejects a signature from a different signer", async () => {
    const auth = makeAuth();
    const { nonce } = auth.challenge(OWNER, 0);
    const other = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
    const signature = await other.signMessage({ message: nonce });
    await expect(auth.session(OWNER, nonce, signature, 1000)).rejects.toThrow(/signature/i);
  });

  it("rejects a nonce that was never issued", async () => {
    const auth = makeAuth();
    const signature = await account.signMessage({ message: "nonce-0" });
    await expect(auth.session(OWNER, "nonce-0", signature, 1000)).rejects.toThrow(/nonce/i);
  });

  it("rejects a reused nonce (single-use)", async () => {
    const auth = makeAuth();
    const { nonce } = auth.challenge(OWNER, 0);
    const signature = await account.signMessage({ message: nonce });
    await auth.session(OWNER, nonce, signature, 1000);
    await expect(auth.session(OWNER, nonce, signature, 1000)).rejects.toThrow(/nonce/i);
  });

  it("rejects an expired nonce", async () => {
    const auth = makeAuth();
    const { nonce } = auth.challenge(OWNER, 0);
    const signature = await account.signMessage({ message: nonce });
    await expect(auth.session(OWNER, nonce, signature, 60_001)).rejects.toThrow(/nonce/i);
  });
});
