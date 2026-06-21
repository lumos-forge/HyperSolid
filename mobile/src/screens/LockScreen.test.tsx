import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { LockScreen } from "./LockScreen";

describe("LockScreen", () => {
  it("renders the unlock prompt and triggers onUnlock", async () => {
    const onUnlock = jest.fn().mockResolvedValue("success");
    render(<LockScreen onUnlock={onUnlock} />);
    expect(screen.getByText("HyperSolid 已锁定")).toBeTruthy();
    fireEvent.press(screen.getByText("解锁"));
    await waitFor(() => expect(onUnlock).toHaveBeenCalled());
  });

  it("shows an error message when unlock fails", async () => {
    const onUnlock = jest.fn().mockResolvedValue("failed");
    render(<LockScreen onUnlock={onUnlock} />);
    fireEvent.press(screen.getByText("解锁"));
    await waitFor(() => expect(screen.getByText(/验证失败/)).toBeTruthy());
  });

  it("guides the user when biometrics are unavailable", async () => {
    const onUnlock = jest.fn().mockResolvedValue("unavailable");
    render(<LockScreen onUnlock={onUnlock} />);
    fireEvent.press(screen.getByText("解锁"));
    await waitFor(() => expect(screen.getByText(/请在系统设置中启用/)).toBeTruthy());
  });

  it("shows a security warning when the device is compromised", async () => {
    const onUnlock = jest.fn().mockResolvedValue("compromised");
    render(<LockScreen onUnlock={onUnlock} />);
    fireEvent.press(screen.getByText("解锁"));
    await waitFor(() => expect(screen.getByText(/设备安全检查未通过/)).toBeTruthy());
  });

  it("re-enables and shows an error if onUnlock throws", async () => {
    const onUnlock = jest.fn().mockRejectedValue(new Error("boom"));
    render(<LockScreen onUnlock={onUnlock} />);
    fireEvent.press(screen.getByText("解锁"));
    await waitFor(() => expect(screen.getByText(/验证失败/)).toBeTruthy());
    fireEvent.press(screen.getByText("解锁"));
    await waitFor(() => expect(onUnlock).toHaveBeenCalledTimes(2));
  });
});
