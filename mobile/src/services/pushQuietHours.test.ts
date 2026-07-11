import { fetchQuietHours, saveQuietHours, deviceTimeZone, type QuietHours } from "./pushQuietHours";

const QH: QuietHours = { enabled: true, start: 1320, end: 480, tz: "UTC" };

function apiFake(opts: { qh?: QuietHours; getThrows?: boolean; setThrows?: boolean } = {}) {
  const calls: { set: QuietHours[] } = { set: [] };
  return {
    calls,
    async getQuietHours() {
      if (opts.getThrows) throw new Error("net");
      return opts.qh ?? QH;
    },
    async setQuietHours(qh: QuietHours) {
      calls.set.push(qh);
      if (opts.setThrows) throw new Error("net");
    },
  };
}

describe("fetchQuietHours", () => {
  it("returns config on success", async () => {
    const api = apiFake({ qh: QH });
    expect(await fetchQuietHours(async () => api)).toEqual(QH);
  });

  it("returns null when there is no session", async () => {
    expect(await fetchQuietHours(async () => null)).toBeNull();
  });

  it("returns null when getQuietHours throws", async () => {
    const api = apiFake({ getThrows: true });
    expect(await fetchQuietHours(async () => api)).toBeNull();
  });
});

describe("saveQuietHours", () => {
  it("returns true and forwards the config on success", async () => {
    const api = apiFake();
    const ok = await saveQuietHours(async () => api, QH);
    expect(ok).toBe(true);
    expect(api.calls.set).toEqual([QH]);
  });

  it("returns false when there is no session", async () => {
    expect(await saveQuietHours(async () => null, QH)).toBe(false);
  });

  it("returns false when setQuietHours throws", async () => {
    const api = apiFake({ setThrows: true });
    expect(await saveQuietHours(async () => api, QH)).toBe(false);
  });
});

describe("deviceTimeZone", () => {
  it("returns a non-empty string and never throws", () => {
    const tz = deviceTimeZone();
    expect(typeof tz).toBe("string");
    expect(tz.length).toBeGreaterThan(0);
  });
});
