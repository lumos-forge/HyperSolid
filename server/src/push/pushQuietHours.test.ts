import { isWithinQuietHours, minuteOfDayInTz, type QuietHours } from "./pushQuietHours";

const AT = (tz: string, over: Partial<QuietHours> = {}): QuietHours => ({ enabled: true, start: 0, end: 0, tz, ...over });
// 2026-01-01T00:00:00Z: UTC minute-of-day 0; Asia/Shanghai (UTC+8) = 480.
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

describe("minuteOfDayInTz", () => {
  it("computes local minute-of-day for a timezone", () => {
    expect(minuteOfDayInTz(T0, "UTC")).toBe(0);
    expect(minuteOfDayInTz(T0, "Asia/Shanghai")).toBe(480);
  });
});

describe("isWithinQuietHours", () => {
  it("same-day window: inside vs outside", () => {
    expect(isWithinQuietHours(AT("Asia/Shanghai", { start: 470, end: 490 }), T0)).toBe(true);  // 480 in [470,490)
    expect(isWithinQuietHours(AT("Asia/Shanghai", { start: 481, end: 490 }), T0)).toBe(false); // 480 < 481
  });

  it("same window differs by timezone", () => {
    const qh = { enabled: true, start: 470, end: 490 } as const;
    expect(isWithinQuietHours({ ...qh, tz: "Asia/Shanghai" }, T0)).toBe(true); // 480 in window
    expect(isWithinQuietHours({ ...qh, tz: "UTC" }, T0)).toBe(false);          // 0 not in window
  });

  it("overnight window wraps midnight", () => {
    // 23:00–07:00 UTC. At UTC 00:00 (m=0) → inside; at UTC 10:00 → outside.
    const qh = AT("UTC", { start: 1380, end: 420 });
    expect(isWithinQuietHours(qh, T0)).toBe(true);
    expect(isWithinQuietHours(qh, Date.UTC(2026, 0, 1, 10, 0, 0))).toBe(false);
  });

  it("disabled → false", () => {
    expect(isWithinQuietHours(AT("UTC", { enabled: false, start: 0, end: 1000 }), T0)).toBe(false);
  });

  it("empty window (start === end) → false", () => {
    expect(isWithinQuietHours(AT("UTC", { start: 300, end: 300 }), T0)).toBe(false);
  });

  it("unparseable timezone → false (fail-open)", () => {
    expect(isWithinQuietHours(AT("Not/AZone", { start: 0, end: 1439 }), T0)).toBe(false);
  });
});
