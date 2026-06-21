import React from "react";
import { render, screen } from "@testing-library/react-native";
import { Pill } from "./Pill";
import { themes } from "../theme/tokens";

const t = themes.electrum;

describe("Pill", () => {
  it("renders its label", () => {
    render(<Pill theme={t} label="◷ TESTNET" />);
    expect(screen.getByText("◷ TESTNET")).toBeTruthy();
  });

  it("uses the brand token by default", () => {
    render(<Pill theme={t} label="TESTNET" />);
    expect(screen.getByText("TESTNET")).toHaveStyle({ color: t.brand });
  });

  it("uses the up token for the up variant", () => {
    render(<Pill theme={t} label="ARMED" variant="up" />);
    expect(screen.getByText("ARMED")).toHaveStyle({ color: t.up });
  });

  it("uses the down token for the down variant", () => {
    render(<Pill theme={t} label="▼ 1.2%" variant="down" />);
    expect(screen.getByText("▼ 1.2%")).toHaveStyle({ color: t.down });
  });
});
