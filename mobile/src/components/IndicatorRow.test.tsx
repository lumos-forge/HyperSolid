import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { IndicatorRow } from "./IndicatorRow";
import { themes } from "../theme/tokens";

const items = ["MA", "EMA", "BOLL", "SAR", "VOL", "MACD", "KDJ", "RSI"] as const;

describe("IndicatorRow", () => {
  it("renders all items as text and marks the active one with the brand color", () => {
    render(<IndicatorRow theme={themes.electrum} items={items} active="MA" onSelect={() => {}} separatorAfter={4} />);
    for (const it of items) expect(screen.getByText(it)).toBeTruthy();
    expect(screen.getByText("MA")).toHaveStyle({ color: themes.electrum.brand });
    expect(screen.getByText("VOL")).toHaveStyle({ color: themes.electrum.muted });
  });

  it("calls onSelect with the tapped item", () => {
    const onSelect = jest.fn();
    render(<IndicatorRow theme={themes.electrum} items={items} active="MA" onSelect={onSelect} separatorAfter={4} />);
    fireEvent.press(screen.getByText("MACD"));
    expect(onSelect).toHaveBeenCalledWith("MACD");
  });
});
