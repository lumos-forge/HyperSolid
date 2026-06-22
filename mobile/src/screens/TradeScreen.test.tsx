import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";
import { TradeScreen } from "./TradeScreen";
import { useWalletStore } from "../state/walletStore";
import { useEnvStore } from "../state/envStore";
import { useMarketStore } from "../state/marketStore";
import type { MarketTicker } from "../lib/hyperliquid/types";

const mockPlaceOrder = jest.fn();
jest.mock("../services/exchange", () => ({
  ExchangeService: jest.fn().mockImplementation(() => ({ placeOrder: mockPlaceOrder })),
}));
jest.mock("../lib/hyperliquid/client", () => ({
  createExchangeClient: jest.fn(() => ({})),
}));

const btc: MarketTicker = {
  coin: "BTC",
  midPx: 62481.5,
  prevDayPx: 61170,
  changePct: 2.43,
  funding: 0.00011,
  dayNtlVlm: 1.2e9,
  maxLeverage: 50,
};

const localWallet = { getViemAccount: () => ({}), getAddress: () => "0xabc" } as never;

describe("TradeScreen", () => {
  beforeEach(() => {
    useEnvStore.setState({ network: "mainnet" });
    useMarketStore.setState({ tickers: [btc], loading: false, error: null });
    useWalletStore.setState({ mode: "none", wallet: null, address: null });
    mockPlaceOrder.mockReset();
    jest.spyOn(Alert, "alert").mockImplementation(() => {});
  });

  it("prompts to connect a wallet when none is set", () => {
    render(<TradeScreen />);
    expect(screen.getByText("交易 Trade")).toBeTruthy();
    expect(screen.getByText(/请先在「钱包」连接钱包后交易/)).toBeTruthy();
  });

  it("blocks trading in view-only mode", () => {
    useWalletStore.setState({ mode: "viewOnly", address: "0xabc" });
    render(<TradeScreen />);
    expect(screen.getByText(/只读模式不能交易/)).toBeTruthy();
  });

  it("renders the order form chrome when a local wallet is connected", () => {
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: "0xabc" });
    render(<TradeScreen />);
    expect(screen.getByText("HYPERSOLID")).toBeTruthy();
    expect(screen.getByText("◷ MAINNET")).toBeTruthy();
    expect(screen.getByText("买入 / 做多")).toBeTruthy();
    expect(screen.getByText("卖出 / 做空")).toBeTruthy();
    expect(screen.getByText("提交订单")).toBeTruthy();
  });

  it("shows the current price hint for the selected coin", () => {
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: "0xabc" });
    render(<TradeScreen />);
    expect(screen.getByText(/当前价 62481.5/)).toBeTruthy();
  });

  it("does not submit while the session is locked (no wallet)", () => {
    // mode is local but wallet is absent (session not unlocked) -> submit must be blocked
    useWalletStore.setState({ mode: "local", wallet: null, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.press(screen.getByTestId("submit-order"));
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it("surfaces a precision rejection as a normalized Chinese message", () => {
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    // size rounds to 0 at szDecimals=2 but notional passes the $10 gate -> validateOrder rejects
    fireEvent.changeText(screen.getByTestId("field-size"), "0.001");
    fireEvent.changeText(screen.getByTestId("field-price"), "20000");
    fireEvent.press(screen.getByTestId("submit-order"));
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith("订单无效", expect.stringContaining("数量"));
  });

  it("shows a Chinese success alert with the cloid", async () => {
    mockPlaceOrder.mockResolvedValue({
      ok: true,
      cloid: ("0x" + "a".repeat(32)) as `0x${string}`,
      status: { kind: "resting", message: "订单已挂单" },
    });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.press(screen.getByTestId("submit-order"));
    await waitFor(() => {
      expect(mockPlaceOrder).toHaveBeenCalled();
      expect(Alert.alert).toHaveBeenCalledWith("下单成功", expect.stringContaining("cloid"));
    });
  });

  it("shows the service's normalized Chinese error on failure", async () => {
    mockPlaceOrder.mockResolvedValue({ ok: false, error: "保证金不足" });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.press(screen.getByTestId("submit-order"));
    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalledWith("下单失败", "保证金不足");
    });
  });
});
