import React from "react";
import { render, screen } from "@testing-library/react-native";
import { NetworkWarning } from "./NetworkWarning";
import { useEnvStore } from "../state/envStore";
import { useThemeStore } from "../state/themeStore";
import { themes } from "../theme/tokens";

const t = themes.electrum;

beforeEach(() => {
  useThemeStore.setState({ name: "electrum" });
  useEnvStore.setState({ network: "mainnet" });
});

describe("NetworkWarning (asymmetric)", () => {
  it("renders nothing on mainnet — the safe network stays silent", () => {
    render(<NetworkWarning variant="chip" />);
    expect(screen.queryByTestId("network-warning-chip")).toBeNull();
    render(<NetworkWarning variant="strip" />);
    expect(screen.queryByTestId("network-warning-strip")).toBeNull();
  });

  it("shows a caution chip on testnet, tinted from the warn token", () => {
    useEnvStore.setState({ network: "testnet" });
    render(<NetworkWarning variant="chip" />);
    expect(screen.getByTestId("network-warning-chip")).toBeTruthy();
    expect(screen.getByText("Testnet")).toHaveStyle({ color: t.warn });
  });

  it("shows an honest caution strip on testnet with a warn left-edge", () => {
    useEnvStore.setState({ network: "testnet" });
    render(<NetworkWarning variant="strip" />);
    const strip = screen.getByTestId("network-warning-strip");
    expect(strip).toBeTruthy();
    expect(strip).toHaveStyle({ borderLeftColor: t.warn });
    expect(screen.getByText("Testnet")).toBeTruthy();
    expect(screen.getByText(/paper funds, not real money/)).toBeTruthy();
  });
});
