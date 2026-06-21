import React from "react";
import { Text } from "react-native";
import { render, screen } from "@testing-library/react-native";
import { ScreenScaffold } from "./ScreenScaffold";
import { themes } from "../theme/tokens";

const t = themes.electrum;

describe("ScreenScaffold", () => {
  it("renders heading and children", () => {
    render(
      <ScreenScaffold theme={t} heading="交易 Trade">
        <Text>content</Text>
      </ScreenScaffold>,
    );
    expect(screen.getByText("交易 Trade")).toBeTruthy();
    expect(screen.getByText("content")).toBeTruthy();
  });

  it("renders the trace header when requested", () => {
    render(
      <ScreenScaffold theme={t} showTrace statusTitle="HYPERSOLID">
        <Text>x</Text>
      </ScreenScaffold>,
    );
    expect(screen.getByTestId("trace")).toBeTruthy();
    expect(screen.getByText("HYPERSOLID")).toBeTruthy();
  });

  it("omits the trace header by default", () => {
    render(
      <ScreenScaffold theme={t}>
        <Text>x</Text>
      </ScreenScaffold>,
    );
    expect(screen.queryByTestId("trace")).toBeNull();
  });
});
