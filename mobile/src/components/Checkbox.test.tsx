import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { Checkbox } from "./Checkbox";
import { themes } from "../theme/tokens";

const t = themes.electrum;

describe("Checkbox", () => {
  it("renders the label and reflects the checked state", () => {
    render(<Checkbox theme={t} value label="Reduce-only" accessibilityLabel="reduce-only" />);
    const node = screen.getByLabelText("reduce-only");
    expect(node.props.accessibilityState.checked).toBe(true);
    expect(screen.getByText("Reduce-only")).toBeTruthy();
  });

  it("toggles the value when pressed", () => {
    const onChange = jest.fn();
    render(<Checkbox theme={t} value={false} onValueChange={onChange} label="TP/SL" accessibilityLabel="tpsl" />);
    fireEvent.press(screen.getByLabelText("tpsl"));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
