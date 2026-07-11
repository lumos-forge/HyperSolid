import { SqliteQuietHoursStore } from "./pushQuietHoursStore";

const OWNER = "0xABCDEF0000000000000000000000000000000009";

describe("SqliteQuietHoursStore", () => {
  it("returns a disabled default on a fresh db", () => {
    const s = SqliteQuietHoursStore.open(":memory:");
    expect(s.get(OWNER)).toEqual({ enabled: false, start: 0, end: 0, tz: "UTC" });
  });

  it("round-trips a set config", () => {
    const s = SqliteQuietHoursStore.open(":memory:");
    s.set(OWNER, { enabled: true, start: 1380, end: 420, tz: "Asia/Shanghai" }, 1000);
    expect(s.get(OWNER)).toEqual({ enabled: true, start: 1380, end: 420, tz: "Asia/Shanghai" });
  });

  it("isQuietNow reflects an enabled window and false when disabled", () => {
    const s = SqliteQuietHoursStore.open(":memory:");
    const noon = Date.UTC(2026, 0, 1, 12, 0, 0); // UTC minute-of-day 720
    s.set(OWNER, { enabled: true, start: 0, end: 1439, tz: "UTC" }, 1000);
    expect(s.isQuietNow(OWNER, noon)).toBe(true);
    s.set(OWNER, { enabled: false, start: 0, end: 1439, tz: "UTC" }, 2000);
    expect(s.isQuietNow(OWNER, noon)).toBe(false);
  });

  it("matches owner case-insensitively", () => {
    const s = SqliteQuietHoursStore.open(":memory:");
    s.set(OWNER, { enabled: true, start: 0, end: 100, tz: "UTC" }, 1000);
    expect(s.get(OWNER.toLowerCase()).enabled).toBe(true);
  });
});
