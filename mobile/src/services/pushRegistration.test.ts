import { registerDeviceForPush, unregisterDeviceForPush, type PushEnv, type PermStatus } from "./pushRegistration";

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

function apiFake(opts: { registerThrows?: boolean; unregisterThrows?: boolean } = {}) {
  const calls: { register: [string, string][]; unregister: string[] } = { register: [], unregister: [] };
  return {
    calls,
    async registerPush(token: string, platform: string) {
      calls.register.push([token, platform]);
      if (opts.registerThrows) throw new Error("net");
    },
    async unregisterPush(token: string) {
      calls.unregister.push(token);
      if (opts.unregisterThrows) throw new Error("net");
    },
  };
}

describe("registerDeviceForPush", () => {
  it("skips non-devices without calling the api", async () => {
    const api = apiFake();
    const r = await registerDeviceForPush(api, envFake({ isDevice: false }));
    expect(r).toEqual({ ok: false, reason: "not_device" });
    expect(api.calls.register).toHaveLength(0);
  });

  it("registers when permission is already granted", async () => {
    const api = apiFake();
    const r = await registerDeviceForPush(api, envFake({ permSeq: ["granted"], platform: "ios" }));
    expect(r).toEqual({ ok: true, token: "ExponentPushToken[tok]" });
    expect(api.calls.register).toEqual([["ExponentPushToken[tok]", "ios"]]);
  });

  it("requests permission when undetermined then registers", async () => {
    const api = apiFake();
    const r = await registerDeviceForPush(api, envFake({ permSeq: ["undetermined", "granted"] }));
    expect(r.ok).toBe(true);
    expect(api.calls.register).toHaveLength(1);
  });

  it("returns permission_denied and does not call the api", async () => {
    const api = apiFake();
    const r = await registerDeviceForPush(api, envFake({ permSeq: ["undetermined", "denied"] }));
    expect(r).toEqual({ ok: false, reason: "permission_denied" });
    expect(api.calls.register).toHaveLength(0);
  });

  it("returns error when getExpoPushToken throws (never throws)", async () => {
    const api = apiFake();
    const env = envFake({ getExpoPushToken: async () => { throw new Error("no token"); } });
    const r = await registerDeviceForPush(api, env);
    expect(r).toEqual({ ok: false, reason: "error" });
  });

  it("returns error when registerPush throws (never throws)", async () => {
    const api = apiFake({ registerThrows: true });
    const r = await registerDeviceForPush(api, envFake());
    expect(r).toEqual({ ok: false, reason: "error" });
  });
});

describe("unregisterDeviceForPush", () => {
  it("calls the api unregister", async () => {
    const api = apiFake();
    await unregisterDeviceForPush(api, "ExponentPushToken[tok]");
    expect(api.calls.unregister).toEqual(["ExponentPushToken[tok]"]);
  });

  it("swallows errors from the api", async () => {
    const api = apiFake({ unregisterThrows: true });
    await expect(unregisterDeviceForPush(api, "ExponentPushToken[tok]")).resolves.toBeUndefined();
  });
});
