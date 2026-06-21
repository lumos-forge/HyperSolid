import React from "react";
import { render, screen } from "@testing-library/react-native";
import { SectionLabel } from "./SectionLabel";
import { themes } from "../theme/tokens";

const t = themes.electrum;

describe("SectionLabel", () => {
  it("renders its text muted with wide letter spacing", () => {
    render(<SectionLabel theme={t}>STRATEGIES</SectionLabel>);
    const node = screen.getByText("STRATEGIES");
    expect(node).toHaveStyle({ color: t.muted, letterSpacing: 1.5 });
  });
});
