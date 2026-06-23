import React from "react";
import { render, screen } from "@testing-library/react-native";
import { NavigationContainer } from "@react-navigation/native";
import { RootNavigator } from "./RootNavigator";
import { useMarketStore } from "../state/marketStore";

describe("RootNavigator", () => {
  beforeEach(() => useMarketStore.setState({ tickers: [], loading: true, error: null }));

  it("renders all 5 board tab labels", () => {
    render(
      <NavigationContainer>
        <RootNavigator />
      </NavigationContainer>,
    );
    for (const label of ["行情", "交易", "持仓", "策略", "钱包"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it("shows the Markets board (default tab) content", () => {
    render(
      <NavigationContainer>
        <RootNavigator />
      </NavigationContainer>,
    );
    expect(screen.getByPlaceholderText("Search markets")).toBeTruthy();
  });
});
