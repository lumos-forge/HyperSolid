import { fetchPushCategoryPrefs, setPushCategoryPrefs } from "./pushCategoryPrefs";

function apiFake(opts: { prefs?: { fills: boolean; alerts: boolean }; getThrows?: boolean; setThrows?: boolean } = {}) {
  const calls: { set: Array<Partial<{ fills: boolean; alerts: boolean }>> } = { set: [] };
  return {
    calls,
    async getPushPrefs() {
      if (opts.getThrows) throw new Error("net");
      return opts.prefs ?? { fills: true, alerts: true };
    },
    async setPushPrefs(prefs: Partial<{ fills: boolean; alerts: boolean }>) {
      calls.set.push(prefs);
      if (opts.setThrows) throw new Error("net");
    },
  };
}

describe("fetchPushCategoryPrefs", () => {
  it("returns prefs on success", async () => {
    const api = apiFake({ prefs: { fills: true, alerts: false } });
    const r = await fetchPushCategoryPrefs(async () => api);
    expect(r).toEqual({ fills: true, alerts: false });
  });

  it("returns null when there is no session", async () => {
    const r = await fetchPushCategoryPrefs(async () => null);
    expect(r).toBeNull();
  });

  it("returns null when getPushPrefs throws", async () => {
    const api = apiFake({ getThrows: true });
    const r = await fetchPushCategoryPrefs(async () => api);
    expect(r).toBeNull();
  });
});

describe("setPushCategoryPrefs", () => {
  it("returns true and forwards the partial on success", async () => {
    const api = apiFake();
    const ok = await setPushCategoryPrefs(async () => api, { fills: false });
    expect(ok).toBe(true);
    expect(api.calls.set).toEqual([{ fills: false }]);
  });

  it("returns false when there is no session", async () => {
    const ok = await setPushCategoryPrefs(async () => null, { alerts: false });
    expect(ok).toBe(false);
  });

  it("returns false when setPushPrefs throws", async () => {
    const api = apiFake({ setThrows: true });
    const ok = await setPushCategoryPrefs(async () => api, { fills: true });
    expect(ok).toBe(false);
  });
});
