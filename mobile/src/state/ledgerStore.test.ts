import { useLedgerStore } from "./ledgerStore";
import type { SqlDb, SqlParam, SqlRow } from "../lib/storage/sqlDb";

class FakeSqlDb implements SqlDb {
  allResult: SqlRow[] = [];
  exec() {}
  run() {}
  all<T extends SqlRow = SqlRow>(sql: string): T[] {
    if (sql.includes("PRAGMA user_version")) return [{ user_version: 1 }] as unknown as T[];
    return this.allResult as T[];
  }
}

describe("ledgerStore", () => {
  beforeEach(() => useLedgerStore.getState().reset());

  it("starts empty", () => {
    expect(useLedgerStore.getState().ledger).toBeNull();
    expect(useLedgerStore.getState().scope).toBeNull();
  });

  it("init builds a persistent ledger + scope for the wallet/network", () => {
    useLedgerStore.getState().init(new FakeSqlDb(), "0xAbc", "mainnet");
    const s = useLedgerStore.getState();
    expect(s.scope).toBe("0xabc:mainnet");
    expect(s.ledger).not.toBeNull();
    const intent = s.ledger!.open({ coin: "BTC", side: "buy", size: 0.01, price: 60000 });
    expect(s.ledger!.get(intent.cloid)).toBeDefined();
  });

  it("re-init for a different wallet swaps the scope/ledger", () => {
    useLedgerStore.getState().init(new FakeSqlDb(), "0xAbc", "mainnet");
    useLedgerStore.getState().init(new FakeSqlDb(), "0xDef", "testnet");
    expect(useLedgerStore.getState().scope).toBe("0xdef:testnet");
  });

  it("reset clears the ledger", () => {
    useLedgerStore.getState().init(new FakeSqlDb(), "0xAbc", "mainnet");
    useLedgerStore.getState().reset();
    expect(useLedgerStore.getState().ledger).toBeNull();
  });

  it("bumps revision on init / bump / reset so derived UI re-renders", () => {
    const before = useLedgerStore.getState().revision;
    useLedgerStore.getState().init(new FakeSqlDb(), "0xAbc", "mainnet");
    const afterInit = useLedgerStore.getState().revision;
    expect(afterInit).toBeGreaterThan(before);
    useLedgerStore.getState().bump();
    const afterBump = useLedgerStore.getState().revision;
    expect(afterBump).toBeGreaterThan(afterInit);
    useLedgerStore.getState().reset();
    expect(useLedgerStore.getState().revision).toBeGreaterThan(afterBump);
  });
});
