import React from "react";
import { render, screen } from "@testing-library/react-native";
import { MarketRow } from "./MarketRow";
import { themes } from "../theme/tokens";
import type { MarketTicker } from "../lib/hyperliquid/types";

const t = themes.electrum;
const up: MarketTicker = {
  coin: "BTC", midPx: 62481.5, prevDayPx: 61000, changePct: 2.43,
  funding: 0.0001, dayNtlVlm: 1.2e9, maxLeverage: 50,
};
const down: MarketTicker = { ...up, coin: "ETH", changePct: -0.86 };

describe("MarketRow", () => {
  it("shows coin and formatted price", () => {
    render(<MarketRow ticker={up} theme={t} />);
    expect(screen.getByText("BTC")).toBeTruthy();
    expect(screen.getByText("62,481.5")).toBeTruthy();
  });

  it("colors positive change with the up token", () => {
    render(<MarketRow ticker={up} theme={t} />);
    expect(screen.getByText("+2.43%")).toHaveStyle({ color: t.up });
  });

  it("colors negative change with the down token", () => {
    render(<MarketRow ticker={down} theme={t} />);
    expect(screen.getByText("-0.86%")).toHaveStyle({ color: t.down });
  });
});
