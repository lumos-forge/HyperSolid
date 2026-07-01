import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { LoadError } from "./LoadError";
import { defaultTheme, themes } from "../theme/tokens";

const theme = themes[defaultTheme];

describe("LoadError", () => {
  it("shows a network title + working Retry (full variant)", () => {
    const onRetry = jest.fn();
    render(<LoadError theme={theme} code="network" onRetry={onRetry} testID="err" />);
    expect(screen.getByText("Can't reach the venue")).toBeTruthy();
    fireEvent.press(screen.getByTestId("err-retry"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("renders a compact one-line variant with retry", () => {
    const onRetry = jest.fn();
    render(<LoadError theme={theme} code="network" onRetry={onRetry} compact testID="c" />);
    fireEvent.press(screen.getByTestId("c-retry"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("hides Retry for invalidAddress (not retryable)", () => {
    render(<LoadError theme={theme} code="invalidAddress" onRetry={jest.fn()} testID="err" />);
    expect(screen.getByText("Invalid address")).toBeTruthy();
    expect(screen.queryByTestId("err-retry")).toBeNull();
  });
});
