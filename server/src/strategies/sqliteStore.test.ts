import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SqliteStrategyStore } from "./sqliteStore";

describe("SqliteStrategyStore", () => {
  it("satisfies the store contract: create/list/get/setStatus/recordFill/remove", () => {
    const store = SqliteStrategyStore.open(":memory:", () => 1000);
    const s = store.create("0xOwner", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 });

    expect(s.status).toBe("running");
    expect(s.nextRunAt).toBe(1000);
    expect(s.filledTotalUsdc).toBe(0);
    expect(store.list("0xowner")).toHaveLength(1); // owner match is case-insensitive
    expect(store.listAll()).toHaveLength(1);

    store.setStatus(s.id, "paused");
    expect(store.get(s.id)!.status).toBe("paused");

    store.recordFill(s.id, 50, 99000);
    expect(store.get(s.id)!.filledTotalUsdc).toBe(50);
    expect(store.get(s.id)!.nextRunAt).toBe(99000);

    store.remove(s.id);
    expect(store.get(s.id)).toBeUndefined();
    expect(store.listAll()).toHaveLength(0);
  });

  it("persists strategies + fills across a reopen (durable recovery)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-sqlite-"));
    const file = join(dir, "strategies.db");
    try {
      const first = SqliteStrategyStore.open(file, () => 1000);
      const s = first.create("0xo", { coin: "ETH", side: "buy", quoteAmountUsdc: 25, intervalHours: 12 });
      first.recordFill(s.id, 25, 50000);
      first.close();

      const reopened = SqliteStrategyStore.open(file, () => 2000);
      const recovered = reopened.get(s.id)!;
      expect(recovered.owner).toBe("0xo");
      expect(recovered.params).toEqual({ coin: "ETH", side: "buy", quoteAmountUsdc: 25, intervalHours: 12 });
      expect(recovered.filledTotalUsdc).toBe(25);
      expect(recovered.nextRunAt).toBe(50000);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
