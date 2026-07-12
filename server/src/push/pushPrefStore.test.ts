import { SqlitePushPrefStore } from "./pushPrefStore";

const OWNER = "0xABCDEF0000000000000000000000000000000001";

describe("SqlitePushPrefStore", () => {
  it("defaults every category to enabled on a fresh db", () => {
    const s = SqlitePushPrefStore.open(":memory:");
    expect(s.isEnabled(OWNER, "fills")).toBe(true);
    expect(s.isEnabled(OWNER, "alerts")).toBe(true);
    expect(s.get(OWNER)).toEqual({ fills: true, alerts: true, lifecycle: true });
  });

  it("persists a disabled category and leaves others on", () => {
    const s = SqlitePushPrefStore.open(":memory:");
    s.set(OWNER, { fills: false }, 1000);
    expect(s.isEnabled(OWNER, "fills")).toBe(false);
    expect(s.isEnabled(OWNER, "alerts")).toBe(true);
    expect(s.get(OWNER)).toEqual({ fills: false, alerts: true, lifecycle: true });
  });

  it("persists a disabled lifecycle category", () => {
    const s = SqlitePushPrefStore.open(":memory:");
    s.set(OWNER, { lifecycle: false }, 1000);
    expect(s.isEnabled(OWNER, "lifecycle")).toBe(false);
    expect(s.get(OWNER)).toEqual({ fills: true, alerts: true, lifecycle: false });
  });

  it("upserts: a later set overwrites the earlier value", () => {
    const s = SqlitePushPrefStore.open(":memory:");
    s.set(OWNER, { fills: false }, 1000);
    s.set(OWNER, { fills: true }, 2000);
    expect(s.isEnabled(OWNER, "fills")).toBe(true);
  });

  it("set with an empty object is a no-op", () => {
    const s = SqlitePushPrefStore.open(":memory:");
    s.set(OWNER, {}, 1000);
    expect(s.get(OWNER)).toEqual({ fills: true, alerts: true, lifecycle: true });
  });

  it("matches owner case-insensitively", () => {
    const s = SqlitePushPrefStore.open(":memory:");
    s.set(OWNER, { alerts: false }, 1000);
    expect(s.isEnabled(OWNER.toLowerCase(), "alerts")).toBe(false);
  });
});
