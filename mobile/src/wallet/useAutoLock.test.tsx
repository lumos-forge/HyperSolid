import React from "react";
import { render } from "@testing-library/react-native";
import { AppState } from "react-native";
import { shouldLock } from "./useAutoLock";

describe("shouldLock", () => {
  it("locks when idle longer than timeout", () => {
    expect(shouldLock({ lastActiveAt: 0, now: 6 * 60_000, timeoutMs: 5 * 60_000 })).toBe(true);
  });
  it("does not lock within timeout", () => {
    expect(shouldLock({ lastActiveAt: 0, now: 60_000, timeoutMs: 5 * 60_000 })).toBe(false);
  });
});

describe("useAutoLock", () => {
  it("subscribes to AppState changes", () => {
    const spy = jest.spyOn(AppState, "addEventListener");
    const { useAutoLock } = require("./useAutoLock");
    function Probe() {
      useAutoLock();
      return null;
    }
    render(<Probe />);
    expect(spy).toHaveBeenCalledWith("change", expect.any(Function));
    spy.mockRestore();
  });
});
