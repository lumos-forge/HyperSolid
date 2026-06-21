import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { PositionsScreen } from "./PositionsScreen";
import { useEnvStore } from "../state/envStore";

describe("PositionsScreen", () => {
  beforeEach(() => useEnvStore.setState({ network: "mainnet" }));

  it("renders the phosphor chrome, view-only banner and query control", () => {
    render(<PositionsScreen />);
    expect(screen.getByText("HYPERSOLID")).toBeTruthy();
    expect(screen.getByText("◷ MAINNET")).toBeTruthy();
    expect(screen.getByText("持仓 Positions")).toBeTruthy();
    expect(screen.getByText(/view-only 预览/)).toBeTruthy();
    expect(screen.getByText("查询")).toBeTruthy();
  });

  it("shows a format error for an invalid address without hitting the network", () => {
    render(<PositionsScreen />);
    fireEvent.changeText(screen.getByPlaceholderText("0x… 钱包地址"), "not-an-address");
    fireEvent.press(screen.getByText("查询"));
    expect(screen.getByText(/地址格式无效/)).toBeTruthy();
  });
});
