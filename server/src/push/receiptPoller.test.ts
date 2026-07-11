import { pollPushReceipts, type ExpoReceiptLike } from "./receiptPoller";
import type { ExpoPushReceipt } from "expo-server-sdk";

function fakeReceiptsStore(pendingRows: { receiptId: string; token: string }[]) {
  const removed: string[] = [];
  const pruned: number[] = [];
  let rows = [...pendingRows];
  return {
    removed,
    pruned,
    pending: (_limit: number) => rows,
    remove: (ids: string[]) => { removed.push(...ids); rows = rows.filter((r) => !ids.includes(r.receiptId)); },
    pruneOlderThan: (cutoff: number) => { pruned.push(cutoff); },
  };
}

function fakeTokens() {
  const deleted: string[] = [];
  return { deleted, deleteToken: (t: string) => { deleted.push(t); } };
}

function fakeExpo(map: Record<string, ExpoPushReceipt>, opts: { throwFetch?: boolean } = {}): ExpoReceiptLike {
  return {
    chunkPushNotificationReceiptIds: (ids: string[]) => [ids],
    getPushNotificationReceiptsAsync: async (_ids: string[]) => {
      if (opts.throwFetch) throw new Error("net");
      return map;
    },
  };
}

const OK: ExpoPushReceipt = { status: "ok" } as ExpoPushReceipt;
const DNR: ExpoPushReceipt = { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } as ExpoPushReceipt;
const RATE: ExpoPushReceipt = { status: "error", message: "slow", details: { error: "MessageRateExceeded" } } as ExpoPushReceipt;

describe("pollPushReceipts", () => {
  it("removes an ok receipt without pruning", async () => {
    const receipts = fakeReceiptsStore([{ receiptId: "r1", token: "TokA" }]);
    const tokens = fakeTokens();
    const res = await pollPushReceipts({ expo: fakeExpo({ r1: OK }), receipts, tokens, now: () => 100 });
    expect(res).toMatchObject({ checked: 1, ok: 1, pruned: 0, errors: 0 });
    expect(receipts.removed).toEqual(["r1"]);
    expect(tokens.deleted).toEqual([]);
  });

  it("prunes the token on DeviceNotRegistered and removes the row", async () => {
    const receipts = fakeReceiptsStore([{ receiptId: "r1", token: "TokA" }]);
    const tokens = fakeTokens();
    const res = await pollPushReceipts({ expo: fakeExpo({ r1: DNR }), receipts, tokens, now: () => 100 });
    expect(res).toMatchObject({ checked: 1, ok: 0, pruned: 1, errors: 1 });
    expect(tokens.deleted).toEqual(["TokA"]);
    expect(receipts.removed).toEqual(["r1"]);
  });

  it("logs other errors and removes the row without pruning", async () => {
    const receipts = fakeReceiptsStore([{ receiptId: "r1", token: "TokA" }]);
    const tokens = fakeTokens();
    const logs: string[] = [];
    const res = await pollPushReceipts({ expo: fakeExpo({ r1: RATE }), receipts, tokens, now: () => 100, logger: (m) => logs.push(m) });
    expect(res).toMatchObject({ checked: 1, ok: 0, pruned: 0, errors: 1 });
    expect(tokens.deleted).toEqual([]);
    expect(receipts.removed).toEqual(["r1"]);
    expect(logs.length).toBeGreaterThan(0);
  });

  it("leaves a not-yet-available receipt pending", async () => {
    const receipts = fakeReceiptsStore([{ receiptId: "r1", token: "TokA" }]);
    const tokens = fakeTokens();
    const res = await pollPushReceipts({ expo: fakeExpo({}), receipts, tokens, now: () => 100 });
    expect(res).toMatchObject({ checked: 0 });
    expect(receipts.removed).toEqual([]);
  });

  it("prunes stale rows and does not fetch when nothing is pending", async () => {
    const receipts = fakeReceiptsStore([]);
    const tokens = fakeTokens();
    const res = await pollPushReceipts({ expo: fakeExpo({}), receipts, tokens, now: () => 100000, maxAgeMs: 1000 });
    expect(res.checked).toBe(0);
    expect(receipts.pruned).toEqual([99000]); // now - maxAgeMs
  });

  it("never throws when the receipts fetch throws", async () => {
    const receipts = fakeReceiptsStore([{ receiptId: "r1", token: "TokA" }]);
    const tokens = fakeTokens();
    const res = await pollPushReceipts({ expo: fakeExpo({}, { throwFetch: true }), receipts, tokens, now: () => 100 });
    expect(res.checked).toBe(0);
    expect(receipts.removed).toEqual([]);
  });
});
