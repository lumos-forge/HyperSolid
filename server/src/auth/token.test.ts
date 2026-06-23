import { issueToken, verifyToken } from "./token";

describe("auth token (HMAC session)", () => {
  const secret = "test-secret";

  it("round-trips the owner for a valid, unexpired token", () => {
    const token = issueToken("0xOwner", secret, 1000, 60_000);
    expect(verifyToken(token, secret, 1000)).toBe("0xowner");
    expect(verifyToken(token, secret, 60_999)).toBe("0xowner");
  });

  it("rejects an expired token", () => {
    const token = issueToken("0xowner", secret, 1000, 60_000);
    expect(verifyToken(token, secret, 61_001)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = issueToken("0xowner", secret, 1000, 60_000);
    expect(verifyToken(token, "other-secret", 1000)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = issueToken("0xowner", secret, 1000, 60_000);
    const [h, , s] = token.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: "0xattacker", exp: 9e15 })).toString("base64url")}.${s}`;
    expect(verifyToken(forged, secret, 1000)).toBeNull();
  });
});
