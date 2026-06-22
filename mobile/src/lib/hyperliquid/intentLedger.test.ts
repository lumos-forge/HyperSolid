import {
  IntentLedger,
  MemoryIntentStore,
} from "./intentLedger";
import { isValidCloid } from "./cloid";
import type { NormalizedStatus } from "./order";

const status = (over: Partial<NormalizedStatus>): NormalizedStatus => ({
  kind: "unknown",
  message: "",
  ...over,
});

// Deterministic factory: incrementing cloids so tests are reproducible.
function makeLedger() {
  let n = 0;
  let t = 1000;
  const factory = () =>
    `0x${(++n).toString(16).padStart(32, "0")}` as `0x${string}`;
  const clock = () => (t += 1);
  const store = new MemoryIntentStore();
  return { ledger: new IntentLedger(store, clock, factory), store };
}

describe("IntentLedger — persist cloid before signing (§6.2)", () => {
  it("opens a pending intent and generates a valid cloid", () => {
    const ledger = new IntentLedger();
    const intent = ledger.open({ coin: "BTC", side: "buy", size: 0.1, price: 60000 });
    expect(intent.status).toBe("pending");
    expect(isValidCloid(intent.cloid)).toBe(true);
    expect(intent.attempts).toBe(1);
  });

  it("reuses an explicitly provided cloid (retry idempotency)", () => {
    const { ledger, store } = makeLedger();
    const first = ledger.open({ coin: "BTC", side: "buy", size: 0.1, price: 60000 });
    const retry = ledger.open({
      coin: "BTC",
      side: "buy",
      size: 0.1,
      price: 60000,
      cloid: first.cloid,
    });
    expect(retry.cloid).toBe(first.cloid);
    expect(retry.attempts).toBe(2); // bumped, not a new record
    expect(store.values()).toHaveLength(1); // no duplicate intent
  });

  it("get returns the persisted intent, undefined when absent", () => {
    const { ledger } = makeLedger();
    const intent = ledger.open({ coin: "ETH", side: "sell", size: 1, price: 3000 });
    expect(ledger.get(intent.cloid)?.coin).toBe("ETH");
    expect(ledger.get("0xdeadbeef")).toBeUndefined();
  });
});

describe("IntentLedger — reconcile by cloid (open/filled/rejected)", () => {
  it("marks submitted before reconciling", () => {
    const { ledger } = makeLedger();
    const i = ledger.open({ coin: "BTC", side: "buy", size: 0.1, price: 60000 });
    expect(ledger.markSubmitted(i.cloid)?.status).toBe("submitted");
  });

  it("reconciles resting -> open and records oid", () => {
    const { ledger } = makeLedger();
    const i = ledger.open({ coin: "BTC", side: "buy", size: 0.1, price: 60000 });
    const r = ledger.reconcile(i.cloid, status({ kind: "resting", oid: 999, message: "挂单" }));
    expect(r?.status).toBe("open");
    expect(r?.oid).toBe(999);
  });

  it("reconciles filled -> filled (terminal)", () => {
    const { ledger } = makeLedger();
    const i = ledger.open({ coin: "BTC", side: "buy", size: 0.1, price: 60000 });
    const r = ledger.reconcile(i.cloid, status({ kind: "filled", oid: 1, message: "成交" }));
    expect(r?.status).toBe("filled");
    expect(ledger.isSettled(i.cloid)).toBe(true);
  });

  it("reconciles rejected -> rejected and stores the reason", () => {
    const { ledger } = makeLedger();
    const i = ledger.open({ coin: "BTC", side: "buy", size: 0.1, price: 60000 });
    const r = ledger.reconcile(
      i.cloid,
      status({ kind: "rejected", code: "tickRejected", message: "价格不符合 tick" }),
    );
    expect(r?.status).toBe("rejected");
    expect(r?.reason).toMatch(/tick/);
  });

  it("does NOT regress out of a terminal state (out-of-order WS)", () => {
    const { ledger } = makeLedger();
    const i = ledger.open({ coin: "BTC", side: "buy", size: 0.1, price: 60000 });
    ledger.reconcile(i.cloid, status({ kind: "filled", message: "成交" }));
    const late = ledger.reconcile(i.cloid, status({ kind: "resting", message: "挂单" }));
    expect(late?.status).toBe("filled"); // stays filled
  });

  it("reconcile of an unknown cloid returns undefined", () => {
    const { ledger } = makeLedger();
    expect(ledger.reconcile("0xabsent", status({ kind: "filled" }))).toBeUndefined();
  });
});

describe("IntentLedger — dedup uncertain receipts", () => {
  it("shouldSubmit is true while pending/submitted, false once live/terminal", () => {
    const { ledger } = makeLedger();
    const i = ledger.open({ coin: "BTC", side: "buy", size: 0.1, price: 60000 });
    expect(ledger.shouldSubmit(i.cloid)).toBe(true);
    ledger.markSubmitted(i.cloid);
    expect(ledger.shouldSubmit(i.cloid)).toBe(true); // safe to retry same cloid
    ledger.reconcile(i.cloid, status({ kind: "resting", message: "挂单" }));
    expect(ledger.shouldSubmit(i.cloid)).toBe(false); // live order, never duplicate
  });

  it("shouldSubmit is true for a brand-new cloid", () => {
    const { ledger } = makeLedger();
    expect(ledger.shouldSubmit("0xnew")).toBe(true);
  });

  it("pending() lists only non-terminal intents", () => {
    const { ledger } = makeLedger();
    const a = ledger.open({ coin: "BTC", side: "buy", size: 0.1, price: 60000 });
    const b = ledger.open({ coin: "ETH", side: "sell", size: 1, price: 3000 });
    ledger.reconcile(b.cloid, status({ kind: "filled", message: "成交" }));
    const pending = ledger.pending().map((i) => i.cloid);
    expect(pending).toContain(a.cloid);
    expect(pending).not.toContain(b.cloid);
  });
});

describe("IntentLedger.markCanceled (cancel reconciliation)", () => {
  it("transitions an open order to canceled (settled)", () => {
    const { ledger } = makeLedger();
    const i = ledger.open({ coin: "BTC", side: "buy", size: 0.1, price: 60000 });
    ledger.reconcile(i.cloid, status({ kind: "resting", message: "挂单" }));
    expect(ledger.markCanceled(i.cloid)?.status).toBe("canceled");
    expect(ledger.isSettled(i.cloid)).toBe(true);
  });

  it("does NOT override an already-filled order (can't cancel a fill)", () => {
    const { ledger } = makeLedger();
    const i = ledger.open({ coin: "BTC", side: "buy", size: 0.1, price: 60000 });
    ledger.reconcile(i.cloid, status({ kind: "filled", message: "成交" }));
    expect(ledger.markCanceled(i.cloid)?.status).toBe("filled");
  });

  it("returns undefined for an unknown cloid", () => {
    const { ledger } = makeLedger();
    expect(ledger.markCanceled("0xabsent")).toBeUndefined();
  });
});

describe("MemoryIntentStore", () => {
  it("supports get/set/delete/values", () => {
    const store = new MemoryIntentStore();
    const now = Date.now();
    store.set("0x1", {
      cloid: "0x1" as `0x${string}`,
      coin: "BTC",
      side: "buy",
      size: 1,
      price: 1,
      status: "pending",
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    });
    expect(store.get("0x1")?.coin).toBe("BTC");
    expect(store.values()).toHaveLength(1);
    store.delete("0x1");
    expect(store.get("0x1")).toBeUndefined();
  });
});
