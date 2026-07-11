import { SqlitePushReceiptStore } from "./pushReceiptStore";

describe("SqlitePushReceiptStore", () => {
  it("records and returns pending receipts oldest-first", () => {
    const s = SqlitePushReceiptStore.open(":memory:");
    s.record("r1", "TokA", 1000);
    s.record("r2", "TokB", 2000);
    expect(s.pending(10)).toEqual([
      { receiptId: "r1", token: "TokA" },
      { receiptId: "r2", token: "TokB" },
    ]);
  });

  it("respects the pending limit", () => {
    const s = SqlitePushReceiptStore.open(":memory:");
    s.record("r1", "TokA", 1000);
    s.record("r2", "TokB", 2000);
    expect(s.pending(1)).toEqual([{ receiptId: "r1", token: "TokA" }]);
  });

  it("record is idempotent by receipt id", () => {
    const s = SqlitePushReceiptStore.open(":memory:");
    s.record("r1", "TokA", 1000);
    s.record("r1", "TokZ", 5000);
    expect(s.pending(10)).toEqual([{ receiptId: "r1", token: "TokA" }]);
  });

  it("remove deletes only the listed ids and no-ops on empty", () => {
    const s = SqlitePushReceiptStore.open(":memory:");
    s.record("r1", "TokA", 1000);
    s.record("r2", "TokB", 2000);
    s.remove([]);
    expect(s.pending(10)).toHaveLength(2);
    s.remove(["r1"]);
    expect(s.pending(10)).toEqual([{ receiptId: "r2", token: "TokB" }]);
  });

  it("pruneOlderThan deletes rows below the cutoff and keeps newer ones", () => {
    const s = SqlitePushReceiptStore.open(":memory:");
    s.record("old", "TokA", 1000);
    s.record("new", "TokB", 5000);
    s.pruneOlderThan(3000);
    expect(s.pending(10)).toEqual([{ receiptId: "new", token: "TokB" }]);
  });
});
