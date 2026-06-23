import React from "react";
import { render, screen } from "@testing-library/react-native";
import { BookImbalanceBar } from "./BookImbalanceBar";
import { themes } from "../theme/tokens";

const t = themes.electrum;

describe("BookImbalanceBar", () => {
  it("labels both sides with percentages and an honest caption", () => {
    render(<BookImbalanceBar theme={t} bidPct={66.7} askPct={33.3} />);
    expect(screen.getByText(/Book imbalance/)).toBeTruthy();
    expect(screen.getByText(/66\.7%/)).toHaveStyle({ color: t.up });
    expect(screen.getByText(/33\.3%/)).toHaveStyle({ color: t.down });
  });
});
