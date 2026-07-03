import React from "react";
import { Text } from "react-native";
import { render, screen } from "@testing-library/react-native";
import { ErrorBoundary } from "./ErrorBoundary";

function Boom(): React.ReactElement {
  throw new Error("boom");
}

describe("ErrorBoundary", () => {
  it("renders children when there is no error", () => {
    render(
      <ErrorBoundary onError={jest.fn()}>
        <Text>ok</Text>
      </ErrorBoundary>,
    );
    expect(screen.getByText("ok")).toBeTruthy();
  });
  it("renders a fallback and reports when a child throws", () => {
    const onError = jest.fn();
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary onError={onError}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("error-fallback")).toBeTruthy();
    expect(onError).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
