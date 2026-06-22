import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { UnconfirmedBanner } from "./UnconfirmedBanner";
import { themes } from "../theme/tokens";

const theme = themes.electrum;

describe("UnconfirmedBanner", () => {
  it("renders nothing when there are no unconfirmed intents", () => {
    render(<UnconfirmedBanner theme={theme} count={0} />);
    expect(screen.queryByTestId("unconfirmed-banner")).toBeNull();
  });

  it("shows the count and an honest risk disclosure when count > 0", () => {
    render(<UnconfirmedBanner theme={theme} count={3} />);
    expect(screen.getByTestId("unconfirmed-banner")).toBeTruthy();
    expect(screen.getByText(/3 笔未确认/)).toBeTruthy();
    expect(screen.getByText(/敞口|复核/)).toBeTruthy();
  });

  it("renders an action button only when onReview is provided, and fires it", () => {
    const onReview = jest.fn();
    render(<UnconfirmedBanner theme={theme} count={1} onReview={onReview} reviewLabel="重试最近一笔" />);
    expect(screen.getByText("重试最近一笔")).toBeTruthy();
    fireEvent.press(screen.getByTestId("unconfirmed-review"));
    expect(onReview).toHaveBeenCalled();
  });

  it("hides the action button when onReview is absent", () => {
    render(<UnconfirmedBanner theme={theme} count={2} />);
    expect(screen.queryByTestId("unconfirmed-review")).toBeNull();
  });
});
