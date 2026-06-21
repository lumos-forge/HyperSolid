import React from "react";
import { render, screen } from "@testing-library/react-native";
import { Trace } from "./Trace";
import { themes } from "../theme/tokens";

const t = themes.electrum;

describe("Trace", () => {
  it("renders the phosphor waveform container", () => {
    render(<Trace theme={t} />);
    expect(screen.getByTestId("trace")).toBeTruthy();
  });

  it("applies the given height", () => {
    render(<Trace theme={t} height={40} />);
    expect(screen.getByTestId("trace")).toHaveStyle({ height: 40 });
  });
});
