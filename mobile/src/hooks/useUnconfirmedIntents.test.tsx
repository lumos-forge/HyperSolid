import { renderHook, act } from "@testing-library/react-native";
import { useUnconfirmedIntents } from "./useUnconfirmedIntents";
import { useLedgerStore } from "../state/ledgerStore";
import { IntentLedger } from "../lib/hyperliquid/intentLedger";

describe("useUnconfirmedIntents", () => {
  beforeEach(() => useLedgerStore.setState({ ledger: null, scope: null, revision: 0 }));

  it("is empty when there is no ledger", () => {
    const { result } = renderHook(() => useUnconfirmedIntents());
    expect(result.current.count).toBe(0);
    expect(result.current.intents).toEqual([]);
  });

  it("counts pending/submitted intents and ignores terminal ones", () => {
    const ledger = new IntentLedger();
    const a = ledger.open({ coin: "BTC", side: "buy", size: 0.01, price: 60000 });
    ledger.markSubmitted(a.cloid);
    const b = ledger.open({ coin: "ETH", side: "buy", size: 1, price: 3000 });
    ledger.reconcile(b.cloid, { kind: "filled", message: "已成交" }); // terminal -> not counted
    act(() => useLedgerStore.setState({ ledger, scope: "x", revision: 1 }));

    const { result } = renderHook(() => useUnconfirmedIntents());
    expect(result.current.count).toBe(1);
    expect(result.current.intents[0].cloid).toBe(a.cloid);
  });

  it("recomputes after bump() when the ledger contents change", () => {
    const ledger = new IntentLedger();
    ledger.open({ coin: "BTC", side: "buy", size: 0.01, price: 60000 });
    act(() => useLedgerStore.setState({ ledger, scope: "x", revision: 1 }));

    const { result } = renderHook(() => useUnconfirmedIntents());
    expect(result.current.count).toBe(1);

    act(() => {
      ledger.open({ coin: "ETH", side: "buy", size: 1, price: 3000 });
      useLedgerStore.getState().bump();
    });
    expect(result.current.count).toBe(2);
  });
});
