import type { ExpoPushReceipt } from "expo-server-sdk";
import type { PushReceiptStore } from "./pushReceiptStore";
import type { PushTokenStore } from "./pushTokenStore";

/** Receipt-side seam over expo-server-sdk (separate from ExpoLike so Notifier fakes
 *  are unaffected). A real Expo instance satisfies this structurally. */
export interface ExpoReceiptLike {
  chunkPushNotificationReceiptIds(ids: string[]): string[][];
  getPushNotificationReceiptsAsync(ids: string[]): Promise<Record<string, ExpoPushReceipt>>;
}

export interface PollDeps {
  expo: ExpoReceiptLike;
  receipts: Pick<PushReceiptStore, "pending" | "remove" | "pruneOlderThan">;
  tokens: Pick<PushTokenStore, "deleteToken">;
  now: () => number;
  logger?: (msg: string, err?: unknown) => void;
  /** Max receipts to check per poll (default 1000). */
  batchLimit?: number;
  /** Rows older than this are pruned as never-resolved (default 24h). */
  maxAgeMs?: number;
}

export interface PollResult {
  checked: number;
  ok: number;
  pruned: number;
  errors: number;
}

/** Fetch pending push receipts, prune DeviceNotRegistered tokens, and reap stale rows.
 *  Fail-safe: never throws. */
export async function pollPushReceipts(deps: PollDeps): Promise<PollResult> {
  const result: PollResult = { checked: 0, ok: 0, pruned: 0, errors: 0 };
  const log = deps.logger ?? ((msg: string, err?: unknown) => console.error(msg, err));
  const batchLimit = deps.batchLimit ?? 1000;
  const maxAgeMs = deps.maxAgeMs ?? 24 * 60 * 60 * 1000;
  try {
    const rows = deps.receipts.pending(batchLimit);
    if (rows.length > 0) {
      const tokenByReceipt = new Map(rows.map((r) => [r.receiptId, r.token]));
      const processed: string[] = [];
      for (const chunk of deps.expo.chunkPushNotificationReceiptIds(rows.map((r) => r.receiptId))) {
        let map: Record<string, ExpoPushReceipt>;
        try {
          map = await deps.expo.getPushNotificationReceiptsAsync(chunk);
        } catch (err) {
          log("push receipt fetch failed", err);
          continue;
        }
        for (const receiptId of chunk) {
          const receipt = map[receiptId];
          if (!receipt) continue; // not ready yet → leave pending
          result.checked++;
          processed.push(receiptId);
          if (receipt.status === "ok") {
            result.ok++;
            continue;
          }
          result.errors++;
          log(`push receipt error: ${receipt.message ?? "unknown"}`);
          if (receipt.details?.error === "DeviceNotRegistered") {
            const token = tokenByReceipt.get(receiptId);
            if (token) {
              try {
                deps.tokens.deleteToken(token);
                result.pruned++;
              } catch (err) {
                log("push receipt prune failed", err);
              }
            }
          }
        }
      }
      deps.receipts.remove(processed);
    }
    deps.receipts.pruneOlderThan(deps.now() - maxAgeMs);
  } catch (err) {
    log("push receipt poll failed", err);
  }
  return result;
}
