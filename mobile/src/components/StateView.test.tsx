import React from "react";
import { render, screen } from "@testing-library/react-native";
import { StateView } from "./StateView";
import { themes } from "../theme/tokens";

const t = themes.electrum;

describe("StateView", () => {
  it("renders a loading message", () => {
    render(<StateView kind="loading" message="加载中…" theme={t} />);
    expect(screen.getByText("加载中…")).toBeTruthy();
  });

  it("colors error messages with the down token", () => {
    render(<StateView kind="error" message="出错了" theme={t} />);
    expect(screen.getByText("出错了")).toHaveStyle({ color: t.down });
  });

  it("renders an empty message muted", () => {
    render(<StateView kind="empty" message="暂无数据" theme={t} />);
    expect(screen.getByText("暂无数据")).toHaveStyle({ color: t.muted });
  });
});
