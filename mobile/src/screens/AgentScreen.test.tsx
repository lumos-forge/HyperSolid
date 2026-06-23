import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { AgentScreen } from "./AgentScreen";

describe("AgentScreen", () => {
  it("renders the strategy hero with 30D return and running count", () => {
    render(<AgentScreen />);
    expect(screen.getByText("Strategy")).toBeTruthy();
    expect(screen.getByText("30D strategy return")).toBeTruthy();
    expect(screen.getByText(/\+7\.06%/)).toBeTruthy();
    expect(screen.getByText(/2 running · risk-bounded/)).toBeTruthy();
  });

  it("lists templates and my-strategies", () => {
    render(<AgentScreen />);
    expect(screen.getByText("Templates")).toBeTruthy();
    expect(screen.getByText("My strategies")).toBeTruthy();
    expect(screen.getByText("TWAP")).toBeTruthy();
    expect(screen.getByText("GRID")).toBeTruthy();
    expect(screen.getAllByText("DCA").length).toBeGreaterThan(0);
  });

  it("renders the new-strategy action", () => {
    render(<AgentScreen />);
    expect(screen.getByText("New strategy")).toBeTruthy();
  });

  it("toggles a strategy switch locally and updates the running count", () => {
    render(<AgentScreen />);
    const dca = screen.getByLabelText("strategy-DCA");
    expect(dca.props.accessibilityState.checked).toBe(true);
    fireEvent.press(dca);
    expect(screen.getByLabelText("strategy-DCA").props.accessibilityState.checked).toBe(false);
    expect(screen.getByText(/1 running · risk-bounded/)).toBeTruthy();
  });
});
