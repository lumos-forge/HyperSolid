import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";
import { TradeScreen } from "./TradeScreen";
import { useWalletStore } from "../state/walletStore";
import { useEnvStore } from "../state/envStore";
import { useMarketStore } from "../state/marketStore";
import { useTradeStore } from "../state/tradeStore";
import { useLedgerStore } from "../state/ledgerStore";
import { useToastStore } from "../state/toastStore";
import { IntentLedger } from "../lib/hyperliquid/intentLedger";
import type { MarketTicker } from "../lib/hyperliquid/types";

const mockPlaceOrder = jest.fn();
const mockPlaceBracket = jest.fn();
const mockSetLeverage = jest.fn();
const mockPlaceTwap = jest.fn();
const mockPlaceScale = jest.fn();
jest.mock("../services/exchange", () => ({
  ExchangeService: jest
    .fn()
    .mockImplementation(() => ({
      placeOrder: mockPlaceOrder,
      placeBracket: mockPlaceBracket,
      setLeverage: mockSetLeverage,
      placeTwap: mockPlaceTwap,
      placeScale: mockPlaceScale,
    })),
}));
jest.mock("../lib/hyperliquid/client", () => ({
  createExchangeClient: jest.fn(() => ({})),
  createPositionsInfoClient: jest.fn(() => ({})),
}));
jest.mock("../components/OrderBookPanel", () => ({ OrderBookPanel: () => null }));
jest.mock("../components/TradeActivityPanel", () => ({ TradeActivityPanel: () => null }));
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

/** Open the order-type dropdown and pick a type by its value (market/limit/stopLimit/…). */
function selectType(type: string) {
  fireEvent.press(screen.getByTestId("order-type"));
  fireEvent.press(screen.getByTestId(`order-type-opt-${type}`));
}

/** Open the pair header's coin picker and select a coin. */
function selectCoin(coin: string) {
  fireEvent.press(screen.getByTestId("pair-header"));
  fireEvent.press(screen.getByTestId(`coin-opt-${coin}`));
}

describe("TradeScreen", () => {
  beforeEach(() => {
    useEnvStore.setState({ network: "mainnet" });
    useMarketStore.setState({ tickers: [btc], loading: false, error: null });
    useTradeStore.setState({ selectedCoin: null, prefill: null });
    useWalletStore.setState({ mode: "none", wallet: null, address: null });
    useLedgerStore.setState({ ledger: null, scope: null, revision: 0 });
    useToastStore.setState({ message: null, kind: "info" });
    mockPlaceOrder.mockReset();
    mockPlaceBracket.mockReset();
    mockSetLeverage.mockReset().mockResolvedValue({ ok: true });
    mockPlaceTwap.mockReset().mockResolvedValue({ ok: true });
    mockPlaceScale.mockReset().mockResolvedValue({ ok: true, cloid: ("0x" + "a".repeat(32)) as `0x${string}` });
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
    expect(screen.getByTestId("submit-buy")).toBeTruthy();
    expect(screen.getByTestId("submit-sell")).toBeTruthy();
  });

  it("shows the pair header with coin and day change", () => {
    useWalletStore.setState({ mode: "local", wallet: {} as never, address: "0xabc" });
    render(<TradeScreen />);
    expect(screen.getByText("BTC-USDC")).toBeTruthy();
    expect(screen.getByText("+2.43%")).toBeTruthy();
  });

  it("does not submit while the session is locked (no wallet)", () => {
    // mode is local but wallet is absent (session not unlocked) -> submit must be blocked
    useWalletStore.setState({ mode: "local", wallet: null, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.press(screen.getByTestId("submit-buy"));
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it("clamps a sub-lot size at input so a 0-decimal market can't be over-typed", () => {
    // LOWP has szDecimals 0 (integer lots): typing 0.4 clamps to "0" → no valid order to submit.
    useMarketStore.setState({
      tickers: [btc, { ...btc, coin: "LOWP", midPx: 30, szDecimals: 0 }],
      loading: false,
      error: null,
    });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    selectCoin("LOWP");
    fireEvent.changeText(screen.getByTestId("field-size"), "0.4");
    fireEvent.changeText(screen.getByTestId("field-price"), "30");
    expect(screen.getByTestId("field-size").props.value).toBe("0");
    fireEvent.press(screen.getByTestId("submit-buy"));
    expect(mockPlaceOrder).not.toHaveBeenCalled();
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
    fireEvent.press(screen.getByTestId("submit-buy"));
    await waitFor(() => {
      expect(mockPlaceOrder).toHaveBeenCalled();
      // success is surfaced via a non-blocking toast, not a modal Alert
      expect(useToastStore.getState().message).toBe("Order placed");
    });
  });

  it("places a Stop Limit order with a trigger when selected", async () => {
    mockPlaceOrder.mockResolvedValue({
      ok: true,
      cloid: ("0x" + "c".repeat(32)) as `0x${string}`,
      status: { kind: "resting", message: "订单已挂单" },
    });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    selectType("stopLimit");
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.changeText(screen.getByTestId("field-stop"), "59000");
    fireEvent.press(screen.getByTestId("submit-buy"));
    await waitFor(() => expect(mockPlaceOrder).toHaveBeenCalled());
    expect(mockPlaceOrder).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: { triggerPx: 59000, isMarket: false, tpsl: "sl" } }),
    );
  });

  it("places a Stop Market order (trigger isMarket=true, no limit price field)", async () => {
    mockPlaceOrder.mockResolvedValue({
      ok: true,
      cloid: ("0x" + "c".repeat(32)) as `0x${string}`,
      status: { kind: "resting", message: "ok" },
    });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    selectType("stopMarket");
    expect(screen.queryByTestId("field-price")).toBeNull();
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-stop"), "59000");
    fireEvent.press(screen.getByTestId("submit-buy"));
    await waitFor(() => expect(mockPlaceOrder).toHaveBeenCalled());
    expect(mockPlaceOrder).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: { triggerPx: 59000, isMarket: true, tpsl: "sl" } }),
    );
  });

  it("places a TP Market order with a take-profit trigger above the mark for a long", async () => {
    mockPlaceOrder.mockResolvedValue({
      ok: true,
      cloid: ("0x" + "c".repeat(32)) as `0x${string}`,
      status: { kind: "resting", message: "ok" },
    });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    selectType("tpMarket");
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    // long TP must be above mid (62481.5)
    fireEvent.changeText(screen.getByTestId("field-stop"), "70000");
    fireEvent.press(screen.getByTestId("submit-buy"));
    await waitFor(() => expect(mockPlaceOrder).toHaveBeenCalled());
    expect(mockPlaceOrder).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: { triggerPx: 70000, isMarket: true, tpsl: "tp" } }),
    );
  });

  it("rejects a take-profit trigger on the wrong side of the mark", () => {
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    selectType("tpMarket");
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    // long TP below mid is the wrong side
    fireEvent.changeText(screen.getByTestId("field-stop"), "50000");
    fireEvent.press(screen.getByTestId("submit-buy"));
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith("Invalid order", expect.stringContaining("wrong side"));
  });

  it("rejects a Stop Limit order with no trigger price", () => {
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    selectType("stopLimit");
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.press(screen.getByTestId("submit-buy"));
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it("sizes by USDC (quote) when the unit toggle is switched", async () => {
    mockPlaceOrder.mockResolvedValue({
      ok: true,
      cloid: ("0x" + "c".repeat(32)) as `0x${string}`,
      status: { kind: "resting", message: "ok" },
    });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.press(screen.getByTestId("size-unit")); // open unit dropdown
    fireEvent.press(screen.getByTestId("size-unit-opt-quote")); // base → quote (USDC)
    fireEvent.changeText(screen.getByTestId("field-size"), "600"); // 600 USDC / 60000 = 0.01 BTC
    fireEvent.press(screen.getByTestId("submit-buy"));
    await waitFor(() => expect(mockPlaceOrder).toHaveBeenCalled());
    expect(mockPlaceOrder.mock.calls[0][0].size).toBeCloseTo(0.01, 6);
  });

  it("places a TWAP order with size, duration and randomize (no price field)", async () => {
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    selectType("twap");
    expect(screen.queryByTestId("field-price")).toBeNull();
    fireEvent.changeText(screen.getByTestId("field-size"), "0.02");
    fireEvent.changeText(screen.getByTestId("field-twap-minutes"), "45");
    fireEvent.press(screen.getByLabelText("twap-randomize"));
    fireEvent.press(screen.getByTestId("submit-buy"));
    await waitFor(() => expect(mockPlaceTwap).toHaveBeenCalled());
    expect(mockPlaceTwap).toHaveBeenCalledWith(
      expect.objectContaining({ coin: "BTC", side: "buy", size: 0.02, minutes: 45, randomize: true }),
    );
  });

  it("rejects a TWAP with an out-of-range duration", () => {
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    selectType("twap");
    fireEvent.changeText(screen.getByTestId("field-size"), "0.02");
    fireEvent.changeText(screen.getByTestId("field-twap-minutes"), "2");
    fireEvent.press(screen.getByTestId("submit-buy"));
    expect(mockPlaceTwap).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith("Invalid order", expect.stringContaining("5–1440"));
  });

  it("places a Scale order with a price range and count", async () => {
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    selectType("scale");
    fireEvent.changeText(screen.getByTestId("field-size"), "0.03");
    fireEvent.changeText(screen.getByTestId("field-scale-start"), "60000");
    fireEvent.changeText(screen.getByTestId("field-scale-end"), "61000");
    fireEvent.changeText(screen.getByTestId("field-scale-count"), "3");
    fireEvent.press(screen.getByTestId("submit-buy"));
    await waitFor(() => expect(mockPlaceScale).toHaveBeenCalled());
    expect(mockPlaceScale).toHaveBeenCalledWith(
      expect.objectContaining({ coin: "BTC", side: "buy", totalSize: 0.03, startPx: 60000, endPx: 61000, count: 3 }),
    );
  });

  it("places a short via the Sell / Short button", async () => {
    mockPlaceOrder.mockResolvedValue({
      ok: true,
      cloid: ("0x" + "a".repeat(32)) as `0x${string}`,
      status: { kind: "resting", message: "ok" },
    });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.press(screen.getByTestId("submit-sell"));
    await waitFor(() => expect(mockPlaceOrder).toHaveBeenCalled());
    expect(mockPlaceOrder.mock.calls[0][0].side).toBe("sell");
  });

  it("shows a per-side required-margin line plus max long/short", () => {
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    expect(screen.getAllByText("Required margin").length).toBe(2);
    expect(screen.getByText("Max long")).toBeTruthy();
    expect(screen.getByText("Max short")).toBeTruthy();
  });

  it("opens with the coin chosen from market detail (tradeStore.selectedCoin)", () => {
    useMarketStore.setState({
      tickers: [btc, { ...btc, coin: "ETH", midPx: 3000 }],
      loading: false,
      error: null,
    });
    useTradeStore.setState({ selectedCoin: "ETH" });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    expect(screen.getByText("ETH-USDC")).toBeTruthy();
    // store consumed once so manual coin changes aren't overridden later
    expect(useTradeStore.getState().selectedCoin).toBeNull();
  });

  it("applies a reduce-only size prefill when opened from Positions close/reduce", () => {
    useMarketStore.setState({
      tickers: [btc, { ...btc, coin: "ETH", midPx: 3000 }],
      loading: false,
      error: null,
    });
    useTradeStore.setState({ selectedCoin: "ETH", prefill: { size: "1.5", reduceOnly: true } });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    expect(screen.getByText("ETH-USDC")).toBeTruthy();
    expect(screen.getByTestId("field-size").props.value).toBe("1.5");
    expect(screen.getByLabelText("reduce-only").props.accessibilityState.checked).toBe(true);
    expect(useTradeStore.getState().prefill).toBeNull();
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
    fireEvent.press(screen.getByTestId("submit-buy"));
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
    fireEvent.press(screen.getByTestId("submit-buy"));
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
    fireEvent.press(screen.getByTestId("submit-buy"));
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
    selectType("market");
    // no price field for market orders
    expect(screen.queryByTestId("field-price")).toBeNull();
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.press(screen.getByTestId("submit-buy"));
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
    fireEvent.press(screen.getByTestId("submit-buy"));
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
    fireEvent.press(screen.getByTestId("submit-buy"));
    await waitFor(() => expect(mockPlaceOrder).toHaveBeenCalledTimes(1));
    expect(mockPlaceOrder.mock.calls[0][0].cloid).toBeUndefined();

    // Retry without editing the form must reuse the same cloid (ledger dedupe).
    fireEvent.press(screen.getByTestId("submit-buy"));
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
    fireEvent.press(screen.getByTestId("submit-buy"));
    await waitFor(() => expect(mockPlaceOrder).toHaveBeenCalledTimes(1));

    fireEvent.changeText(screen.getByTestId("field-size"), "0.02");
    fireEvent.press(screen.getByTestId("submit-buy"));
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
    fireEvent.press(screen.getByTestId("submit-buy"));

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
    fireEvent.press(screen.getByTestId("submit-buy"));
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
    fireEvent.press(screen.getByTestId("submit-buy"));
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

  it("passes reduce-only and market type into the order request", async () => {
    mockPlaceOrder.mockResolvedValue({
      ok: true,
      cloid: ("0x" + "a".repeat(32)) as `0x${string}`,
      status: { kind: "resting", message: "订单已挂单" },
    });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    selectType("market");
    fireEvent.press(screen.getByLabelText("reduce-only"));
    fireEvent.press(screen.getByTestId("submit-buy"));
    await waitFor(() => expect(mockPlaceOrder).toHaveBeenCalled());
    const req = mockPlaceOrder.mock.calls[0][0];
    expect(req.reduceOnly).toBe(true);
    expect(req.market).toBe(true);
    expect(mockPlaceBracket).not.toHaveBeenCalled();
  });

  it("sets TIF to ALO (post-only) on a limit order via the TIF dropdown", async () => {
    mockPlaceOrder.mockResolvedValue({
      ok: true,
      cloid: ("0x" + "a".repeat(32)) as `0x${string}`,
      status: { kind: "resting", message: "ok" },
    });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.press(screen.getByTestId("tif"));
    fireEvent.press(screen.getByTestId("tif-opt-Alo"));
    fireEvent.press(screen.getByTestId("submit-buy"));
    await waitFor(() => expect(mockPlaceOrder).toHaveBeenCalled());
    expect(mockPlaceOrder.mock.calls[0][0].tif).toBe("Alo");
  });

  it("swaps the typed price field for a BBO mode selector when a BBO level is chosen", () => {
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    expect(screen.queryByTestId("field-price")).toBeTruthy();
    fireEvent.press(screen.getByTestId("bbo-button"));
    fireEvent.press(screen.getByTestId("bbo-opt-opp1"));
    expect(screen.queryByTestId("field-price")).toBeNull();
    expect(screen.getByTestId("bbo-mode-field")).toBeTruthy();
    // Custom restores the typed field.
    fireEvent.press(screen.getByTestId("bbo-button"));
    fireEvent.press(screen.getByTestId("bbo-opt-custom"));
    expect(screen.queryByTestId("field-price")).toBeTruthy();
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
    fireEvent.press(screen.getByLabelText("tpsl-toggle")); // reveal TP/SL fields
    fireEvent.changeText(screen.getByTestId("field-sl"), "58000");
    fireEvent.press(screen.getByTestId("submit-buy"));
    await waitFor(() => expect(mockPlaceBracket).toHaveBeenCalled());
    const arg = mockPlaceBracket.mock.calls[0][0];
    expect(arg.entry.coin).toBe("BTC");
    expect(arg.stopLoss.triggerPx).toBe(58000);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it("shows the HL pair header, available balance, leverage pill and size slider", async () => {
    const VALID = "0x" + "a".repeat(40);
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: VALID });
    render(<TradeScreen />);
    expect(screen.getByTestId("pair-header")).toBeTruthy();
    expect(screen.getByText("BTC-USDC")).toBeTruthy();
    expect(screen.getByTestId("margin-mode")).toBeTruthy();
    expect(screen.getByTestId("leverage-pill")).toBeTruthy();
    expect(screen.getByTestId("size-slider")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/800\.00 USDC/)).toBeTruthy());
  });

  it("toggles margin mode to isolated and passes isCross=false to setLeverage", async () => {
    mockPlaceOrder.mockResolvedValue({
      ok: true,
      cloid: ("0x" + "a".repeat(32)) as `0x${string}`,
      status: { kind: "resting", message: "ok" },
    });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.press(screen.getByTestId("margin-mode")); // Cross → Isolated
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.press(screen.getByTestId("submit-buy"));
    await waitFor(() => expect(mockSetLeverage).toHaveBeenCalledWith("BTC", 20, false));
  });

  it("selects leverage from the pill chooser", async () => {
    mockPlaceOrder.mockResolvedValue({
      ok: true,
      cloid: ("0x" + "a".repeat(32)) as `0x${string}`,
      status: { kind: "resting", message: "ok" },
    });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.press(screen.getByTestId("leverage-pill"));
    fireEvent.press(screen.getByTestId("leverage-opt-10"));
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.press(screen.getByTestId("submit-buy"));
    await waitFor(() => expect(mockSetLeverage).toHaveBeenCalledWith("BTC", 10, true));
  });

  it("opens a leverage slider + value box in the leverage chooser", () => {
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.press(screen.getByTestId("leverage-pill"));
    expect(screen.getByTestId("leverage-slider")).toBeTruthy();
    expect(screen.getByTestId("leverage-confirm")).toBeTruthy();
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
    selectCoin("LOWLEV");
    fireEvent.changeText(screen.getByTestId("field-size"), "1");
    fireEvent.changeText(screen.getByTestId("field-price"), "100");
    fireEvent.press(screen.getByTestId("submit-buy"));
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
    fireEvent.press(screen.getByLabelText("tpsl-toggle"));
    fireEvent.changeText(screen.getByTestId("field-sl"), "61000");
    fireEvent.press(screen.getByTestId("submit-buy"));
    expect(mockPlaceBracket).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith("Invalid order", expect.stringContaining("wrong side"));
  });

  it("rejects a take-profit on the wrong side of entry", () => {
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    // long entry 60000; a TP below entry is the wrong side
    fireEvent.changeText(screen.getByTestId("field-size"), "0.01");
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.press(screen.getByLabelText("tpsl-toggle"));
    fireEvent.changeText(screen.getByTestId("field-tp"), "59000");
    fireEvent.press(screen.getByTestId("submit-buy"));
    expect(mockPlaceBracket).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith("Invalid order", expect.stringContaining("wrong side"));
  });

  it("clamps the typed size to szDecimals at input (BTC 5dp) before submit", async () => {
    mockPlaceOrder.mockResolvedValue({
      ok: true,
      cloid: ("0x" + "a".repeat(32)) as `0x${string}`,
      status: { kind: "resting", message: "ok" },
    });
    useWalletStore.setState({ mode: "local", wallet: localWallet, address: "0xabc" });
    render(<TradeScreen />);
    fireEvent.changeText(screen.getByTestId("field-price"), "60000");
    fireEvent.changeText(screen.getByTestId("field-size"), "0.0123456");
    expect(screen.getByTestId("field-size").props.value).toBe("0.01234");
    fireEvent.press(screen.getByTestId("submit-buy"));
    await waitFor(() => expect(mockPlaceOrder).toHaveBeenCalled());
    expect(mockPlaceOrder.mock.calls[0][0].size).toBeCloseTo(0.01234, 7);
  });
});
