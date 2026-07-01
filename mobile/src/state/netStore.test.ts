import { isOffline, useNetStore } from "./netStore";

describe("netStore", () => {
  beforeEach(() => useNetStore.setState({ online: null }));

  it("stays optimistic until the first reading (null is not offline)", () => {
    expect(isOffline(null)).toBe(false);
  });

  it("flags offline only on a definite false reading", () => {
    expect(isOffline(true)).toBe(false);
    expect(isOffline(false)).toBe(true);
  });

  it("setOnline updates the flag", () => {
    useNetStore.getState().setOnline(false);
    expect(useNetStore.getState().online).toBe(false);
    useNetStore.getState().setOnline(true);
    expect(useNetStore.getState().online).toBe(true);
  });
});
