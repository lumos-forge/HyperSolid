import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { Toggle } from "./Toggle";
import { themes } from "../theme/tokens";

const t = themes.electrum;

describe("Toggle", () => {
  it("reflects the on state via accessibility and brand track", () => {
    render(<Toggle theme={t} value onValueChange={() => {}} accessibilityLabel="strat" />);
    const node = screen.getByLabelText("strat");
    expect(node).toHaveStyle({ backgroundColor: t.brand });
    expect(node.props.accessibilityState.checked).toBe(true);
  });

  it("reflects the off state with the line track", () => {
    render(<Toggle theme={t} value={false} accessibilityLabel="strat" />);
    expect(screen.getByLabelText("strat")).toHaveStyle({ backgroundColor: t.line });
  });

  it("calls onValueChange with the toggled value", () => {
    const onChange = jest.fn();
    render(<Toggle theme={t} value={false} onValueChange={onChange} accessibilityLabel="strat" />);
    fireEvent.press(screen.getByLabelText("strat"));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
