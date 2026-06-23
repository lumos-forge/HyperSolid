import React from "react";
import { render } from "@testing-library/react-native";
import { Icon, type IconName } from "./Icon";
import { themes } from "../theme/tokens";

const t = themes.electrum;

const NAMES: IconName[] = [
  "markets",
  "trade",
  "positions",
  "agent",
  "account",
  "star",
  "key",
  "alert",
  "swap",
  "chevron",
  "chevronRight",
  "arrowRight",
  "eye",
  "lock",
  "search",
  "grid",
  "repeat",
  "bolt",
  "shield",
  "plus",
];

describe("Icon", () => {
  it("renders every named glyph without crashing", () => {
    for (const name of NAMES) {
      const { toJSON, unmount } = render(<Icon name={name} color={t.brand} />);
      expect(toJSON()).toBeTruthy();
      unmount();
    }
  });

  it("renders the newly added search glyph", () => {
    const { toJSON } = render(<Icon name="search" color={t.muted} size={16} />);
    expect(toJSON()).toBeTruthy();
  });
});
