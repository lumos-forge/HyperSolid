import React from "react";
import { render, screen, act } from "@testing-library/react-native";
import { NavigationContainer } from "@react-navigation/native";
import { RootNavigator } from "./RootNavigator";
import { useMarketStore } from "../state/marketStore";
import { useLocaleStore } from "../state/localeStore";
import { useRuntimeConfigStore } from "../state/runtimeConfigStore";

describe("RootNavigator", () => {
  beforeEach(() => {
    useMarketStore.setState({ tickers: [], loading: true, error: null });
    useLocaleStore.setState({ locale: "en" });
    useRuntimeConfigStore.setState({ geo: null });
  });

  it("renders all 5 board tab labels", () => {
    render(
      <NavigationContainer>
        <RootNavigator />
      </NavigationContainer>,
    );
    for (const label of ["Markets", "Trade", "Positions", "Strategy", "Wallet"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it("translates the tab labels when the locale is Chinese", () => {
    useLocaleStore.setState({ locale: "zh" });
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

  it("hard-blocks a restricted country (renders the geo block, no tabs)", () => {
    useRuntimeConfigStore.setState({ geo: { country: "US" } });
    render(
      <NavigationContainer>
        <RootNavigator />
      </NavigationContainer>,
    );
    expect(screen.getByTestId("geo-block")).toBeTruthy();
    expect(screen.queryByTestId("tab-Markets")).toBeNull();
  });

  it("renders tabs when geo is a non-restricted country", () => {
    useRuntimeConfigStore.setState({ geo: { country: "JP" } });
    render(
      <NavigationContainer>
        <RootNavigator />
      </NavigationContainer>,
    );
    expect(screen.queryByTestId("geo-block")).toBeNull();
    expect(screen.getAllByText("Markets").length).toBeGreaterThan(0);
  });

  it("fails open (renders tabs) when geo is unknown", () => {
    useRuntimeConfigStore.setState({ geo: null });
    render(
      <NavigationContainer>
        <RootNavigator />
      </NavigationContainer>,
    );
    expect(screen.queryByTestId("geo-block")).toBeNull();
    expect(screen.getAllByText("Markets").length).toBeGreaterThan(0);
  });

  it("switches to the geo block when geo loads to a restricted country after mount (no hook-order crash)", () => {
    useRuntimeConfigStore.setState({ geo: null });
    render(
      <NavigationContainer>
        <RootNavigator />
      </NavigationContainer>,
    );
    expect(screen.getAllByText("Markets").length).toBeGreaterThan(0);
    // geo resolves asynchronously from /app-config; a null->restricted transition must not crash.
    act(() => {
      useRuntimeConfigStore.setState({ geo: { country: "US" } });
    });
    expect(screen.getByTestId("geo-block")).toBeTruthy();
  });
});
