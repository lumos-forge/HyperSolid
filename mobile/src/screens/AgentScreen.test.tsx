import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { AgentScreen } from "./AgentScreen";

describe("AgentScreen", () => {
  it("renders the armed status header and active trace card", () => {
    render(<AgentScreen />);
    expect(screen.getByText("YOUR AGENT")).toBeTruthy();
    expect(screen.getByText("◉ ARMED")).toBeTruthy();
    expect(screen.getByText("PHOSPHOR TRACE · ACTIVE")).toBeTruthy();
  });

  it("lists the mock strategies under a STRATEGIES section", () => {
    render(<AgentScreen />);
    expect(screen.getByText("STRATEGIES")).toBeTruthy();
    expect(screen.getByText("TP/SL")).toBeTruthy();
    expect(screen.getByText("GRID")).toBeTruthy();
    expect(screen.getByText("DCA")).toBeTruthy();
  });

  it("renders guardrails and the kill-switch / new actions", () => {
    render(<AgentScreen />);
    expect(screen.getByText("GUARDRAILS")).toBeTruthy();
    expect(screen.getByText("▮ KILL SWITCH")).toBeTruthy();
    expect(screen.getByText("+ 新建")).toBeTruthy();
  });

  it("toggles a strategy switch locally", () => {
    render(<AgentScreen />);
    const dca = screen.getByLabelText("strategy-DCA");
    expect(dca.props.accessibilityState.checked).toBe(false);
    fireEvent.press(dca);
    expect(screen.getByLabelText("strategy-DCA").props.accessibilityState.checked).toBe(true);
  });
});
