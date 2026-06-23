import React from "react";
import { render, screen } from "@testing-library/react-native";
import { MultiPeriodReturns } from "./MultiPeriodReturns";
import { themes } from "../theme/tokens";

const t = themes.electrum;

describe("MultiPeriodReturns", () => {
  it("renders each period with a ▲/▼ marker colored up/down, and — for null", () => {
    render(
      <MultiPeriodReturns
        theme={t}
        data={[{ label: "24H", pct: 0.85 }, { label: "7D", pct: -2.36 }, { label: "1Y", pct: null }]}
      />,
    );
    expect(screen.getByText("24H")).toBeTruthy();
    expect(screen.getByText(/▲/)).toBeTruthy();
    expect(screen.getByText(/2\.36%/)).toHaveStyle({ color: t.down });
    expect(screen.getByText("—")).toBeTruthy();
  });
});
