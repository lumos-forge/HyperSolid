import React from "react";
import { render, screen } from "@testing-library/react-native";
import { ReturnCurve } from "./ReturnCurve";
import { themes } from "../theme/tokens";

const t = themes.electrum;

describe("ReturnCurve", () => {
  it("renders an empty placeholder for fewer than two points", () => {
    render(<ReturnCurve points={[0.5]} theme={t} color={t.up} />);
    expect(screen.getByTestId("return-curve-empty")).toBeTruthy();
    expect(screen.queryByTestId("return-curve")).toBeNull();
  });

  it("draws the curve when given a series", () => {
    render(<ReturnCurve points={[0.2, 0.4, 0.35, 0.6, 0.9]} theme={t} color={t.up} />);
    expect(screen.getByTestId("return-curve")).toBeTruthy();
  });
});
