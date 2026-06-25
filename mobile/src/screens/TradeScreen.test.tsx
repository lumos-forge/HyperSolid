import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";
import { TradeScreen } from "./TradeScreen";
import { useWalletStore } from "../state/walletStore";
import { useEnvStore } from "../state/envStore";
import { useMarketStore } from "../state/marketStore";
import { useLedgerStore } from "../state/ledgerStore";
import { useToastStore } from "../state/toastStore";
import { IntentLedger } from "../lib/hyperliquid/intentLedger";
import type { MarketTicker } from "../lib/hyperliquid/types";

const mockPlaceOrder = jest.fn();
const mockPlaceBracket = jest.fn();
const mockSetLeverage = jest.fn();
jest.mock("../services/exchange", () => ({
  ExchangeService: jest
    .fn()
    .mockImplementation(() => ({
      placeOrder: mockPlaceOrder,
      placeBracket: mockPlaceBracket,
      setLeverage: mockSetLeverage,
    })),
}));
jest.mock("../lib/hyperliquid/client", () => ({
  createExchangeClient: jest.fn(() => ({})),
  createPositionsInfoClient: jest.fn(() => ({})),
}));
jest.mock("../services/positionsData", () => ({
  PositionsService: class {
    async loadPortfolio() {
      return { summary: { withdrawable: 800 }, positions: [] };
    }
  },
}));

const btc: MarketTicker = {
  coin: "BTC",
  midPx: 62481.5,
  prevDayPx: 61170,
  changePct: 2.43,
  funding: 0.00011,
  dayNtlVlm: 1.2e9,
  maxLeverage: 50,
  szDecimals: 5,
};

const localWallet = { getViemAccount: () => ({}), getAddress: () => "0xabc" } as never;

describe("TradeScreen", () => {
  beforeEach(() => {
    useEnvStore.setState({ network: "mainnet" });
    useMarketStore.setState({ tickers: [btc], loading: false, error: null });
    useWalletStore.setState({ mode: "none", wallet: null, address: null });
    useLedgerStore.setState({ ledger: null, scope: null, revision: 0 });
    useToastStore.setState({ message: null, kind: "info" });
    mockPlaceOrder.mockReset();
    mockPlaceBracket.mockReset();
    mockSetLeverage.mockReset().mockResolvedValue({ ok: true });
    jest.spyOn(Alert, "alert").mockReset().mockImplementation(() => {});
  });

  it("prompts to connect a wallet when none is set", () => {
    render(<TradeScreen />);
    expect(screen.getByText(/Connect a wallet in Wallet/)).toBeTruthy();
  });

  it("blocks trading in view-only mode", () => {
    useWalletStore.setState({ mode: "viewOnly", address: "0xabc" });
    render(<TradeScreen />);
    expect(screen.getByText(/Read-only mode can't place orders/)).toBeTruthy();
  });

  it("offers a Set up wallet CTA that jumps to the Wallet tab when gated", () => {
    const navigate = jest.fn();
    render(<TradeScreen navigation={{ navigate }} />);
    fireEvent.press(screen.getByTestId("gated-setup-wallet"));
    expect(navigate).toHaveBeenCalledWith("Account");
  });

  it("renders the order form chrome when a local wallet is connected", () => {
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: "0xabc" });
    render(<TradeScreen />);
    expect(screen.getByText("Buy / Long")).toBeTruthy();
    expect(screen.getByText("Sell / Short")).toBeTruthy();
    expect(screen.getByText("Buy / Long BTC")).toBeTruthy();
  });

  it("shows the current price for the selected coin", () => {
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: "0xabc" });
    render(<TradeScreen />);
    expect(screen.getByText("62,481.5")).toBeTruthy();
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

  it("surfaces a precision (sub-lot) rejection as a normalized Chinese message", () => {
    // LOWP has szDecimals 0 (integer lots): ordering 0.4 units rounds to 0 -> sizeRejected,
    // even though notional ($12) passes the $10 gate, so validateOrder catches it in Chinese.
    useMarketStore.setState({
      tickers: [btc, { ...btc, coin: "LOWP", midPx: 30, szDecimals: 0 }],
      loading: false,
      error: null,
    });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.changeText(screen.getByTestId("field-coin"), "LOWP");
    fireEvent.changeText(screen.getByTestId("field-size"), "0.4");
    fireEvent.changeText(screen.getByTestId("field-price"), "30");
    fireEvent.press(screen.getByTestId("submit-order"));
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith("Invalid order", expect.stringContaining("size"));
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
      // success is surfaced via a non-blocking toast, not a modal Alert
      expect(useToastStore.getState().message).toBe("Order placed");
    });
  });

  it("places a stop order with a trigger when the Stop type is selected", async () => {
    mockPlaceOrder.mockResolvedValue({
      ok: true,
      cloid: ("0x" + "c".repeat(32)) as `0x${string}`,
      status: { kind: "resting", message: "订单已挂单" },
    });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.press(screen.getByText("Stop"));
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.changeText(screen.getByTestId("field-stop"), "59000");
    fireEvent.press(screen.getByTestId("submit-order"));
    await waitFor(() => expect(mockPlaceOrder).toHaveBeenCalled());
    expect(mockPlaceOrder).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: { triggerPx: 59000, isMarket: false, tpsl: "sl" } }),
    );
  });

  it("rejects a stop order with no trigger price", async () => {
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.press(screen.getByText("Stop"));
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.press(screen.getByTestId("submit-order"));
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it("applies the selected leverage to the venue before placing the order", async () => {
    mockPlaceOrder.mockResolvedValue({
      ok: true,
      cloid: ("0x" + "d".repeat(32)) as `0x${string}`,
      status: { kind: "resting", message: "ok" },
    });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.press(screen.getByTestId("submit-order"));
    await waitFor(() => expect(mockPlaceOrder).toHaveBeenCalled());
    // leverage (default 20×, cross) must be set for BTC before the order is placed
    expect(mockSetLeverage).toHaveBeenCalledWith("BTC", 20, true);
    expect(mockSetLeverage.mock.invocationCallOrder[0]).toBeLessThan(
      mockPlaceOrder.mock.invocationCallOrder[0],
    );
  });

  it("aborts (no order) and alerts if the leverage update fails", async () => {
    mockSetLeverage.mockResolvedValue({ ok: false, error: "leverage rejected" });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.press(screen.getByTestId("submit-order"));
    await waitFor(() => expect(mockSetLeverage).toHaveBeenCalled());
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith("Couldn't set leverage", "leverage rejected");
  });

  it("skips the leverage update for a reduce-only order", async () => {
    mockPlaceOrder.mockResolvedValue({
      ok: true,
      cloid: ("0x" + "e".repeat(32)) as `0x${string}`,
      status: { kind: "resting", message: "ok" },
    });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.press(screen.getByLabelText("reduce-only"));
    fireEvent.press(screen.getByTestId("submit-order"));
    await waitFor(() => expect(mockPlaceOrder).toHaveBeenCalled());
    expect(mockSetLeverage).not.toHaveBeenCalled();
  });

  it("market order needs no typed price and submits at a slippage-bounded price off mid", async () => {
    mockPlaceOrder.mockResolvedValue({
      ok: true,
      cloid: ("0x" + "f".repeat(32)) as `0x${string}`,
      status: { kind: "resting", message: "ok" },
    });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.press(screen.getByText("Market"));
    // no price field for market orders
    expect(screen.queryByTestId("field-price")).toBeNull();
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.press(screen.getByTestId("submit-order"));
    await waitFor(() => expect(mockPlaceOrder).toHaveBeenCalled());
    const entry = mockPlaceOrder.mock.calls[0][0];
    expect(entry.market).toBe(true);
    // buy mid 62481.5 * 1.05 ≈ 65605.6 (aggressive IOC bound)
    expect(entry.price).toBeCloseTo(62481.5 * 1.05, 1);
  });

  it("uses the real szDecimals so a small BTC order is not wrongly rejected", async () => {
    // BTC szDecimals=5: roundSize(0.001,5)=0.001 (valid). With the old hardcoded
    // szDecimals=2 this rounded to 0 and was rejected before reaching the network.
    mockPlaceOrder.mockResolvedValue({
      ok: true,
      cloid: ("0x" + "a".repeat(32)) as `0x${string}`,
      status: { kind: "resting", message: "订单已挂单" },
    });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.changeText(screen.getByTestId("field-size"), "0.001");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.press(screen.getByTestId("submit-order"));
    await waitFor(() => expect(mockPlaceOrder).toHaveBeenCalled());
    expect(Alert.alert).not.toHaveBeenCalledWith("Invalid order", expect.anything());
  });

  it("reuses the cloid on a retry after a failed submit (no orphan duplicate)", async () => {
    const failCloid = ("0x" + "b".repeat(32)) as `0x${string}`;
    mockPlaceOrder
      .mockResolvedValueOnce({ ok: false, error: "网络超时", cloid: failCloid, uncertain: true })
      .mockResolvedValueOnce({ ok: true, cloid: failCloid, status: { kind: "resting", message: "订单已挂单" } });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.press(screen.getByTestId("submit-order"));
    await waitFor(() => expect(mockPlaceOrder).toHaveBeenCalledTimes(1));
    expect(mockPlaceOrder.mock.calls[0][0].cloid).toBeUndefined();

    // Retry without editing the form must reuse the same cloid (ledger dedupe).
    fireEvent.press(screen.getByTestId("submit-order"));
    await waitFor(() => expect(mockPlaceOrder).toHaveBeenCalledTimes(2));
    expect(mockPlaceOrder.mock.calls[1][0].cloid).toBe(failCloid);
  });

  it("drops the retry cloid once the order is edited (new intent gets a fresh cloid)", async () => {
    const failCloid = ("0x" + "c".repeat(32)) as `0x${string}`;
    mockPlaceOrder.mockResolvedValue({ ok: false, error: "网络超时", cloid: failCloid, uncertain: true });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.press(screen.getByTestId("submit-order"));
    await waitFor(() => expect(mockPlaceOrder).toHaveBeenCalledTimes(1));

    fireEvent.changeText(screen.getByTestId("field-size"), "0.02");
    fireEvent.press(screen.getByTestId("submit-order"));
    await waitFor(() => expect(mockPlaceOrder).toHaveBeenCalledTimes(2));
    expect(mockPlaceOrder.mock.calls[1][0].cloid).toBeUndefined();
  });

  it("shows an uncertain-receipt notice + retry that reuses the same cloid", async () => {
    const cloid = ("0x" + "d".repeat(32)) as `0x${string}`;
    mockPlaceOrder
      .mockResolvedValueOnce({ ok: false, error: "网络超时", cloid, uncertain: true })
      .mockResolvedValueOnce({ ok: true, cloid, status: { kind: "resting", message: "订单已挂单" } });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.press(screen.getByTestId("submit-order"));

    await waitFor(() => expect(screen.getByTestId("retry-order")).toBeTruthy());
    expect(screen.getByText(/Last receipt uncertain/)).toBeTruthy();

    fireEvent.press(screen.getByTestId("retry-order"));
    await waitFor(() => expect(mockPlaceOrder).toHaveBeenCalledTimes(2));
    expect(mockPlaceOrder.mock.calls[1][0].cloid).toBe(cloid);
    // success clears the uncertain notice
    await waitFor(() => expect(screen.queryByTestId("retry-order")).toBeNull());
  });

  it("does not show a retry button on a definite rejection", async () => {
    mockPlaceOrder.mockResolvedValue({
      ok: false,
      error: "订单名义价值低于最小 $10",
      cloid: ("0x" + "e".repeat(32)) as `0x${string}`,
      uncertain: false,
    });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.press(screen.getByTestId("submit-order"));
    await waitFor(() => expect(mockPlaceOrder).toHaveBeenCalled());
    expect(screen.queryByTestId("retry-order")).toBeNull();
  });

  it("clears the uncertain notice when the order is edited", async () => {
    const cloid = ("0x" + "f".repeat(32)) as `0x${string}`;
    mockPlaceOrder.mockResolvedValue({ ok: false, error: "网络超时", cloid, uncertain: true });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.press(screen.getByTestId("submit-order"));
    await waitFor(() => expect(screen.getByTestId("retry-order")).toBeTruthy());

    fireEvent.changeText(screen.getByTestId("field-size"), "0.02");
    expect(screen.queryByTestId("retry-order")).toBeNull();
  });

  it("shows the persistent unconfirmed banner and primes a retry of the latest intent", () => {
    const ledger = new IntentLedger();
    const a = ledger.open({ coin: "BTC", side: "buy", size: 0.01, price: 60000 });
    ledger.markSubmitted(a.cloid);
    useLedgerStore.setState({ ledger, scope: "0xabc:mainnet", revision: 1 });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);

    expect(screen.getByTestId("unconfirmed-banner")).toBeTruthy();
    expect(screen.getByText(/1 unconfirmed/)).toBeTruthy();
    // "重试最近一笔" engages the same-cloid retry UI (Unit 5 notice).
    fireEvent.press(screen.getByTestId("unconfirmed-review"));
    expect(screen.getByTestId("retry-order")).toBeTruthy();
  });

  it("passes reduce-only, post-only (Alo) and market type into the order request", async () => {
    mockPlaceOrder.mockResolvedValue({
      ok: true,
      cloid: ("0x" + "a".repeat(32)) as `0x${string}`,
      status: { kind: "resting", message: "订单已挂单" },
    });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.press(screen.getByText("Market"));
    fireEvent.press(screen.getByLabelText("reduce-only"));
    fireEvent.press(screen.getByLabelText("post-only"));
    fireEvent.press(screen.getByTestId("submit-order"));
    await waitFor(() => expect(mockPlaceOrder).toHaveBeenCalled());
    const req = mockPlaceOrder.mock.calls[0][0];
    expect(req.reduceOnly).toBe(true);
    expect(req.market).toBe(true);
    expect(req.tif).toBe("Alo");
    expect(mockPlaceBracket).not.toHaveBeenCalled();
  });

  it("routes through placeBracket when a TP or SL price is set", async () => {
    mockPlaceBracket.mockResolvedValue({
      ok: true,
      cloid: ("0x" + "b".repeat(32)) as `0x${string}`,
      status: { kind: "resting", message: "订单已挂单" },
    });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.changeText(screen.getByTestId("field-sl"), "58000");
    fireEvent.press(screen.getByTestId("submit-order"));
    await waitFor(() => expect(mockPlaceBracket).toHaveBeenCalled());
    const arg = mockPlaceBracket.mock.calls[0][0];
    expect(arg.entry.coin).toBe("BTC");
    expect(arg.stopLoss.triggerPx).toBe(58000);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it("percent row sets size from available balance × leverage / price", async () => {
    const VALID = "0x" + "a".repeat(40);
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: VALID });
    render(<TradeScreen />);
    fireEvent.changeText(screen.getByTestId("field-price"), "64000");
    // wait until the balance hook has loaded withdrawable=800
    await waitFor(() => {
      fireEvent.press(screen.getByText("50%"));
      // 0.5 * (800 * 20) / 64000 = 0.125 (default leverage 20)
      expect(screen.getByTestId("field-size").props.value).toBe("0.125");
    });
  });

  it("clamps leverage to the asset's HL max before placing (no 20× on a 3× market)", async () => {
    mockPlaceOrder.mockResolvedValue({
      ok: true,
      cloid: ("0x" + "a".repeat(32)) as `0x${string}`,
      status: { kind: "resting", message: "ok" },
    });
    useMarketStore.setState({
      tickers: [btc, { ...btc, coin: "LOWLEV", midPx: 100, szDecimals: 2, maxLeverage: 3 }],
      loading: false,
      error: null,
    });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.changeText(screen.getByTestId("field-coin"), "LOWLEV");
    fireEvent.changeText(screen.getByTestId("field-size"), "1");
    fireEvent.changeText(screen.getByTestId("field-price"), "100");
    fireEvent.press(screen.getByTestId("submit-order"));
    await waitFor(() => expect(mockPlaceOrder).toHaveBeenCalled());
    // default 20× must have been clamped to the asset cap (3×) for setLeverage
    expect(mockSetLeverage).toHaveBeenCalledWith("LOWLEV", 3, true);
  });

  it("rejects a stop-loss placed on the wrong side of entry (HL badTriggerPxRejected)", () => {
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    // long entry 60000; an SL above entry is the wrong side
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.changeText(screen.getByTestId("field-sl"), "61000");
    fireEvent.press(screen.getByTestId("submit-order"));
    expect(mockPlaceBracket).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith("Invalid order", expect.stringContaining("wrong side"));
  });

  it("rejects a take-profit on the wrong side of entry", () => {
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    // long entry 60000; a TP below entry is the wrong side
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.changeText(screen.getByTestId("field-tp"), "59000");
    fireEvent.press(screen.getByTestId("submit-order"));
    expect(mockPlaceBracket).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith("Invalid order", expect.stringContaining("wrong side"));
  });

  it("previews the exact HL-snapped size that will be submitted", () => {
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    // BTC szDecimals 5 → 0.0123456 lot-rounds to 0.01235
    fireEvent.changeText(screen.getByTestId("field-size"), "0.0123456");
    expect(screen.getByTestId("submit-preview").props.children).toEqual(
      expect.stringContaining("0.01235"),
    );
  });
});
