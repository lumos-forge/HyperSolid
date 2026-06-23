import React from "react";
import { render, screen } from "@testing-library/react-native";
import { RsiPanel } from "./RsiPanel";
import { themes } from "../theme/tokens";

const t = themes.electrum;

describe("RsiPanel", () => {
  it("renders an empty placeholder until there is data", () => {
    render(<RsiPanel values={[null, null]} theme={t} />);
    expect(screen.getByTestId("rsi-panel-empty")).toBeTruthy();
  });

  it("renders the panel and the latest RSI readout", () => {
    render(<RsiPanel values={[null, 30, 55, 72.4]} theme={t} />);
    expect(screen.getByTestId("rsi-panel")).toBeTruthy();
    expect(screen.getByText(/RSI 72\.4/)).toBeTruthy();
  });
});
