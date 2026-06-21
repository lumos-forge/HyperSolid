import React from "react";
import { render, screen } from "@testing-library/react-native";
import { AccountScreen } from "./AccountScreen";
import { useWalletStore } from "../state/walletStore";
import { useEnvStore } from "../state/envStore";

describe("AccountScreen", () => {
  beforeEach(() => {
    useEnvStore.setState({ network: "mainnet" });
    useWalletStore.setState({ mode: "none", wallet: null, address: null });
  });

  it("renders the onboarding state with create / restore / view-only actions", () => {
    render(<AccountScreen />);
    expect(screen.getByText("HYPERSOLID")).toBeTruthy();
    expect(screen.getByText("◷ MAINNET")).toBeTruthy();
    expect(screen.getByText("欢迎使用 HyperSolid")).toBeTruthy();
    expect(screen.getByText("创建本地钱包（推荐）")).toBeTruthy();
    expect(screen.getByText("恢复钱包")).toBeTruthy();
    expect(screen.getByText("以只读模式进入")).toBeTruthy();
    expect(screen.getByPlaceholderText("输入 12 词助记词")).toBeTruthy();
  });

  it("renders the connected state with wallet card and sign-out", () => {
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: "0x7f3aabcdef0123456789abcdefabcdef0123c2e9" });
    render(<AccountScreen />);
    expect(screen.getByText("钱包 Account")).toBeTruthy();
    expect(screen.getByText("本地钱包（非托管）")).toBeTruthy();
    expect(screen.getByText("退出 / 切换钱包")).toBeTruthy();
    expect(screen.getByText("网络")).toBeTruthy();
  });

  it("labels the view-only connected state correctly", () => {
    useWalletStore.setState({ mode: "viewOnly", wallet: null, address: "0xabc" });
    render(<AccountScreen />);
    expect(screen.getByText("仅查看")).toBeTruthy();
  });
});
