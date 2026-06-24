import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import { LockScreen } from "./LockScreen";
import { useLocaleStore } from "../state/localeStore";

describe("LockScreen", () => {
  beforeEach(() => act(() => useLocaleStore.getState().setLocale("en")));

  it("renders the unlock prompt and triggers onUnlock", async () => {
    const onUnlock = jest.fn().mockResolvedValue("success");
    render(<LockScreen onUnlock={onUnlock} />);
    expect(screen.getByText("HyperSolid locked")).toBeTruthy();
    fireEvent.press(screen.getByText("Unlock"));
    await waitFor(() => expect(onUnlock).toHaveBeenCalled());
  });

  it("auto-triggers the biometric prompt once on mount (no tap needed)", async () => {
    const onUnlock = jest.fn().mockResolvedValue("success");
    render(<LockScreen onUnlock={onUnlock} />);
    await waitFor(() => expect(onUnlock).toHaveBeenCalledTimes(1));
  });

  it("shows an error message when unlock fails", async () => {
    const onUnlock = jest.fn().mockResolvedValue("failed");
    render(<LockScreen onUnlock={onUnlock} />);
    fireEvent.press(screen.getByText("Unlock"));
    await waitFor(() => expect(screen.getByText(/Authentication failed/)).toBeTruthy());
  });

  it("guides the user when biometrics are unavailable", async () => {
    const onUnlock = jest.fn().mockResolvedValue("unavailable");
    render(<LockScreen onUnlock={onUnlock} />);
    fireEvent.press(screen.getByText("Unlock"));
    await waitFor(() => expect(screen.getByText(/enable Face ID/)).toBeTruthy());
  });

  it("shows a security warning when the device is compromised", async () => {
    const onUnlock = jest.fn().mockResolvedValue("compromised");
    render(<LockScreen onUnlock={onUnlock} />);
    fireEvent.press(screen.getByText("Unlock"));
    await waitFor(() => expect(screen.getByText(/security check failed/)).toBeTruthy());
  });

  it("renders the Chinese copy when the locale is zh", () => {
    act(() => useLocaleStore.getState().setLocale("zh"));
    const onUnlock = jest.fn().mockResolvedValue("success");
    render(<LockScreen onUnlock={onUnlock} />);
    expect(screen.getByText("HyperSolid 已锁定")).toBeTruthy();
    expect(screen.getByText("解锁")).toBeTruthy();
  });

  it("re-enables and shows an error if onUnlock throws, and retries on tap", async () => {
    const onUnlock = jest.fn().mockRejectedValue(new Error("boom"));
    render(<LockScreen onUnlock={onUnlock} />);
    // Auto-trigger on mount fails → error shown, button re-enabled for a manual retry.
    await waitFor(() => expect(screen.getByText(/Authentication failed/)).toBeTruthy());
    fireEvent.press(screen.getByText("Unlock"));
    await waitFor(() => expect(onUnlock).toHaveBeenCalledTimes(2));
  });
});
