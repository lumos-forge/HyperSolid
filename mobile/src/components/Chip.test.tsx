import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { Chip } from "./Chip";
import { themes } from "../theme/tokens";

const t = themes.electrum;

describe("Chip", () => {
  it("renders an active chip with brand fill and bg-colored label", () => {
    render(<Chip theme={t} label="1H" active />);
    expect(screen.getByText("1H")).toHaveStyle({ color: t.bg });
  });

  it("renders an inactive chip muted", () => {
    render(<Chip theme={t} label="4H" />);
    expect(screen.getByText("4H")).toHaveStyle({ color: t.muted });
  });

  it("calls onPress when tapped", () => {
    const onPress = jest.fn();
    render(<Chip theme={t} label="1D" onPress={onPress} />);
    fireEvent.press(screen.getByText("1D"));
    expect(onPress).toHaveBeenCalled();
  });
});
