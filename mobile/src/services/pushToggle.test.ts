import { applyPushPreference } from "./pushToggle";
import type { PushEnv, PermStatus } from "./pushRegistration";

function envFake(over: Partial<PushEnv> & { permSeq?: PermStatus[] } = {}): PushEnv {
  const permSeq = over.permSeq ?? ["granted"];
  let i = 0;
  return {
    isDevice: over.isDevice ?? true,
    platform: over.platform ?? "ios",
    getPermissionStatus: over.getPermissionStatus ?? (async () => permSeq[Math.min(i, permSeq.length - 1)]),
    requestPermission: over.requestPermission ?? (async () => { i = 1; return permSeq[Math.min(i, permSeq.length - 1)]; }),
    getExpoPushToken: over.getExpoPushToken ?? (async () => "ExponentPushToken[tok]"),
  };
}

function apiFake() {
  const calls: { register: [string, string][]; unregister: string[] } = { register: [], unregister: [] };
  return {
    calls,
    async registerPush(token: string, platform: string) { calls.register.push([token, platform]); },
    async unregisterPush(token: string) { calls.unregister.push(token); },
  };
}

describe("applyPushPreference", () => {
  it("enables: mints session, registers, returns token", async () => {
    const api = apiFake();
    const r = await applyPushPreference(true, { env: envFake(), makeAuthedApi: async () => api, prevToken: null });
    expect(r).toEqual({ ok: true, token: "ExponentPushToken[tok]" });
    expect(api.calls.register).toEqual([["ExponentPushToken[tok]", "ios"]]);
  });

  it("enables without a session → no_session, no registration", async () => {
    const r = await applyPushPreference(true, { env: envFake(), makeAuthedApi: async () => null, prevToken: null });
    expect(r).toEqual({ ok: false, reason: "no_session" });
  });

  it("enables but permission denied → permission_denied", async () => {
    const api = apiFake();
    const r = await applyPushPreference(true, { env: envFake({ permSeq: ["undetermined", "denied"] }), makeAuthedApi: async () => api, prevToken: null });
    expect(r).toEqual({ ok: false, reason: "permission_denied" });
    expect(api.calls.register).toHaveLength(0);
  });

  it("disables: unregisters the previous token", async () => {
    const api = apiFake();
    const r = await applyPushPreference(false, { env: envFake(), makeAuthedApi: async () => api, prevToken: "ExponentPushToken[old]" });
    expect(r).toEqual({ ok: true });
    expect(api.calls.unregister).toEqual(["ExponentPushToken[old]"]);
  });

  it("disables with no session still returns ok (local off)", async () => {
    const r = await applyPushPreference(false, { env: envFake(), makeAuthedApi: async () => null, prevToken: "ExponentPushToken[old]" });
    expect(r).toEqual({ ok: true });
  });

  it("never throws when makeAuthedApi rejects", async () => {
    const r = await applyPushPreference(true, { env: envFake(), makeAuthedApi: async () => { throw new Error("mint"); }, prevToken: null });
    expect(r).toEqual({ ok: false, reason: "error" });
  });
});
