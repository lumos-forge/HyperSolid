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

  it("locks immediately on foreground when timeout is 0 minutes", () => {
    const { useAutoLock } = require("./useAutoLock");
    const { useAuthStore } = require("../state/authStore");
    const { useLockPrefsStore } = require("../state/lockPrefsStore");
    let handler: (s: string) => void = () => {};
    const spy = jest.spyOn(AppState, "addEventListener").mockImplementation((_e, h) => {
      handler = h as (s: string) => void;
      return { remove: jest.fn() } as never;
    });
    useAuthStore.setState({ status: "unlocked", lastActiveAt: Date.now() - 1000 });
    useLockPrefsStore.setState({ autoLockMinutes: 0 });
    function Probe() {
      useAutoLock();
      return null;
    }
    render(<Probe />);
    handler("active");
    expect(useAuthStore.getState().status).toBe("locked");
    spy.mockRestore();
  });
});
