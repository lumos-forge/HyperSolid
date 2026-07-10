import { SqlitePushTokenStore } from "./pushTokenStore";

const T1 = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const T2 = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

function store() {
  return SqlitePushTokenStore.open(":memory:");
}

describe("SqlitePushTokenStore", () => {
  it("registers a token and lists it for the owner", () => {
    const s = store();
    s.register(A, T1, "ios", 1000);
    const rows = s.tokensForOwner(A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ token: T1, owner: A, platform: "ios", createdAt: 1000, updatedAt: 1000 });
  });

  it("re-registering the same token rebinds owner and keeps createdAt", () => {
    const s = store();
    s.register(A, T1, "ios", 1000);
    s.register(B, T1, "android", 2000); // same token, new owner
    expect(s.tokensForOwner(A)).toHaveLength(0);
    const rows = s.tokensForOwner(B);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ token: T1, owner: B, platform: "android", createdAt: 1000, updatedAt: 2000 });
  });

  it("keeps multiple tokens for one owner", () => {
    const s = store();
    s.register(A, T1, "ios", 1000);
    s.register(A, T2, "ios", 1000);
    expect(s.tokensForOwner(A).map((r) => r.token).sort()).toEqual([T1, T2].sort());
  });

  it("unregister removes only the owner's token", () => {
    const s = store();
    s.register(A, T1, "ios", 1000);
    expect(s.unregister(B, T1)).toBe(false); // not B's token
    expect(s.tokensForOwner(A)).toHaveLength(1);
    expect(s.unregister(A, T1)).toBe(true);
    expect(s.tokensForOwner(A)).toHaveLength(0);
  });

  it("deleteToken removes unconditionally", () => {
    const s = store();
    s.register(A, T1, "ios", 1000);
    s.deleteToken(T1);
    expect(s.tokensForOwner(A)).toHaveLength(0);
  });

  it("matches owner case-insensitively", () => {
    const s = store();
    s.register("0xABCabc0000000000000000000000000000000001", T1, "ios", 1000);
    expect(s.tokensForOwner("0xabcabc0000000000000000000000000000000001")).toHaveLength(1);
    expect(s.unregister("0xABCABC0000000000000000000000000000000001", T1)).toBe(true);
  });

  it("stores null platform when omitted", () => {
    const s = store();
    s.register(A, T1, null, 1000);
    expect(s.tokensForOwner(A)[0].platform).toBeNull();
  });
});
