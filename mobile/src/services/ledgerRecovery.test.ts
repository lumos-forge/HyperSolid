import { reconcilePendingIntents } from "./ledgerRecovery";
import { IntentLedger } from "../lib/hyperliquid/intentLedger";
import type { OrderStatusInfoLike, RawOrderStatus } from "../lib/hyperliquid/types";

const USER = "0xabc" as const;
const cloidA = ("0x" + "a".repeat(32)) as `0x${string}`;
const cloidB = ("0x" + "b".repeat(32)) as `0x${string}`;
const cloidC = ("0x" + "c".repeat(32)) as `0x${string}`;

/** info.orderStatus fake keyed by cloid → programmed response. */
function fakeInfo(byCloid: Record<string, RawOrderStatus>, onErr?: Set<string>): {
  info: OrderStatusInfoLike;
  calls: { user: string; oid: number | `0x${string}` }[];
} {
  const calls: { user: string; oid: number | `0x${string}` }[] = [];
  const info: OrderStatusInfoLike = {
    orderStatus: async (user, oid) => {
      calls.push({ user, oid });
      if (onErr?.has(String(oid))) throw new Error("network down");
      return byCloid[String(oid)] ?? { status: "unknownOid" };
    },
  };
  return { info, calls };
}

function order(status: string, oid?: number): RawOrderStatus {
  return { status: "order", order: { status, statusTimestamp: 1, order: oid === undefined ? {} : { oid } } };
}

describe("reconcilePendingIntents (startup recovery)", () => {
  it("only queries non-terminal (pending/submitted) intents", async () => {
    const ledger = new IntentLedger();
    ledger.open({ coin: "BTC", side: "buy", size: 0.01, price: 60000, cloid: cloidA });
    ledger.markSubmitted(cloidA);
    ledger.open({ coin: "ETH", side: "buy", size: 1, price: 3000, cloid: cloidB });
    ledger.reconcile(cloidB, { kind: "filled", message: "已成交" }); // terminal → skipped
    const { info, calls } = fakeInfo({ [cloidA]: order("open", 111) });

    await reconcilePendingIntents(ledger, info, USER);

    expect(calls.map((c) => c.oid)).toEqual([cloidA]);
    expect(calls[0].user).toBe(USER);
  });

  it("reconciles open/filled/rejected/canceled by the HL order status code", async () => {
    const ledger = new IntentLedger();
    for (const [c, coin] of [[cloidA, "BTC"], [cloidB, "ETH"], [cloidC, "SOL"]] as const) {
      ledger.open({ coin, side: "buy", size: 1, price: 100, cloid: c });
      ledger.markSubmitted(c);
    }
    const dCloid = ("0x" + "d".repeat(32)) as `0x${string}`;
    ledger.open({ coin: "OP", side: "buy", size: 1, price: 1, cloid: dCloid });
    ledger.markSubmitted(dCloid);

    const { info } = fakeInfo({
      [cloidA]: order("open", 111),
      [cloidB]: order("filled", 222),
      [cloidC]: order("tickRejected"),
      [dCloid]: order("marginCanceled"),
    });

    const summary = await reconcilePendingIntents(ledger, info, USER);

    expect(ledger.get(cloidA)?.status).toBe("open");
    expect(ledger.get(cloidA)?.oid).toBe(111);
    expect(ledger.get(cloidB)?.status).toBe("filled");
    expect(ledger.get(cloidC)?.status).toBe("rejected");
    expect(ledger.get(dCloid)?.status).toBe("canceled");
    expect(summary.reconciled).toBe(4);
    expect(summary.orphans).toBe(0);
  });

  it("leaves an orphan (unknownOid) as submitted/未确认 — never assumes fill or fail", async () => {
    const ledger = new IntentLedger();
    ledger.open({ coin: "BTC", side: "buy", size: 0.01, price: 60000, cloid: cloidA });
    ledger.markSubmitted(cloidA);
    const { info } = fakeInfo({}); // every lookup → unknownOid

    const summary = await reconcilePendingIntents(ledger, info, USER);

    expect(ledger.get(cloidA)?.status).toBe("submitted"); // still surfaced to the user
    expect(summary.orphans).toBe(1);
    expect(summary.reconciled).toBe(0);
  });

  it("counts query errors without crashing or mutating the intent", async () => {
    const ledger = new IntentLedger();
    ledger.open({ coin: "BTC", side: "buy", size: 0.01, price: 60000, cloid: cloidA });
    ledger.markSubmitted(cloidA);
    const { info } = fakeInfo({}, new Set([cloidA]));

    const summary = await reconcilePendingIntents(ledger, info, USER);

    expect(ledger.get(cloidA)?.status).toBe("submitted");
    expect(summary.errors).toBe(1);
  });

  it("emits breadcrumbs for reconcile / orphan / summary", async () => {
    const ledger = new IntentLedger();
    ledger.open({ coin: "BTC", side: "buy", size: 0.01, price: 60000, cloid: cloidA });
    ledger.markSubmitted(cloidA);
    ledger.open({ coin: "ETH", side: "buy", size: 1, price: 3000, cloid: cloidB });
    ledger.markSubmitted(cloidB);
    const { info } = fakeInfo({ [cloidA]: order("filled", 222) }); // B → orphan

    const events: string[] = [];
    await reconcilePendingIntents(ledger, info, USER, (e) => events.push(e));

    expect(events).toContain("intent.reconciled");
    expect(events).toContain("intent.orphan");
    expect(events).toContain("intent.recoverySummary");
  });
});
