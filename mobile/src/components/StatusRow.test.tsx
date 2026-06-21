import React from "react";
import { Text } from "react-native";
import { render, screen } from "@testing-library/react-native";
import { StatusRow } from "./StatusRow";
import { themes } from "../theme/tokens";

const t = themes.electrum;

describe("StatusRow", () => {
  it("renders the default clock, title and pill node", () => {
    render(<StatusRow theme={t} title="HYPERSOLID" pill={<Text>◷ TESTNET</Text>} />);
    expect(screen.getByText("9:41")).toBeTruthy();
    expect(screen.getByText("HYPERSOLID")).toBeTruthy();
    expect(screen.getByText("◷ TESTNET")).toBeTruthy();
  });

  it("renders a custom left node instead of the clock", () => {
    render(<StatusRow theme={t} left={<Text>BTC-PERP</Text>} />);
    expect(screen.getByText("BTC-PERP")).toBeTruthy();
    expect(screen.queryByText("9:41")).toBeNull();
  });

  it("colors the title with the text token", () => {
    render(<StatusRow theme={t} title="HYPERSOLID" />);
    expect(screen.getByText("HYPERSOLID")).toHaveStyle({ color: t.text });
  });
});
