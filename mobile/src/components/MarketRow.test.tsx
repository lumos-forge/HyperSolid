import React from "react";
import { render, screen } from "@testing-library/react-native";
import { MarketRow } from "./MarketRow";
import { themes } from "../theme/tokens";
import type { MarketTicker } from "../lib/hyperliquid/types";

const t = themes.electrum;
const up: MarketTicker = {
  coin: "BTC", midPx: 62481.5, prevDayPx: 61000, changePct: 2.43,
  funding: 0.0001, dayNtlVlm: 2.75e9, maxLeverage: 50, szDecimals: 5,
};
const down: MarketTicker = { ...up, coin: "ETH", changePct: -0.86 };

describe("MarketRow", () => {
  it("shows coin, a PERP tag and the formatted price", () => {
    render(<MarketRow ticker={up} theme={t} />);
    expect(screen.getByText("BTC")).toBeTruthy();
    expect(screen.getByText("PERP")).toBeTruthy();
    expect(screen.getByText("62,481.5")).toBeTruthy();
  });

  it("summarizes funding and volume in the sub-line", () => {
    render(<MarketRow ticker={up} theme={t} />);
    expect(screen.getByText(/Fund/)).toHaveTextContent(/Vol\s+2\.75B/);
  });

  it("colors positive change with the up token and a ▲ marker", () => {
    render(<MarketRow ticker={up} theme={t} />);
    const chg = screen.getByText(/\+2\.43%/);
    expect(chg).toHaveTextContent(/▲/);
    expect(chg).toHaveStyle({ color: t.up });
  });

  it("colors negative change with the down token and a ▼ marker", () => {
    render(<MarketRow ticker={down} theme={t} />);
    const chg = screen.getByText(/-0\.86%/);
    expect(chg).toHaveTextContent(/▼/);
    expect(chg).toHaveStyle({ color: t.down });
  });
});
