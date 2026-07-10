import type { ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";
import type { PushTokenStore } from "./pushTokenStore";

// Expo push token format (matches Expo.isExpoPushToken). Used as the default
// validator so this module needs only expo-server-sdk's (erased) types — no
// runtime import of the ESM package, keeping it trivially unit-testable.
const EXPO_PUSH_TOKEN = /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/;

export interface Notification {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

// Injectable seam over the subset of expo-server-sdk we use; a real `Expo`
// instance satisfies this structurally, tests pass a fake (no network).
export interface ExpoLike {
  chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][];
  sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
}

export interface NotifierDeps {
  expo: ExpoLike;
  store: Pick<PushTokenStore, "tokensForOwner" | "deleteToken">;
  /** Failure log sink; defaults to console.error. */
  logger?: (msg: string, err?: unknown) => void;
  /** Token validator; defaults to the Expo push-token format regex. */
  isValidToken?: (token: string) => boolean;
}

export interface NotifyResult {
  tokens: number;
  sent: number;
  errors: number;
  pruned: number;
}

/** Fail-safe push sender over Expo Push Service. notify() never throws. */
export class Notifier {
  private readonly expo: ExpoLike;
  private readonly store: Pick<PushTokenStore, "tokensForOwner" | "deleteToken">;
  private readonly log: (msg: string, err?: unknown) => void;
  private readonly isValid: (token: string) => boolean;

  constructor(deps: NotifierDeps) {
    this.expo = deps.expo;
    this.store = deps.store;
    this.log = deps.logger ?? ((msg, err) => console.error(msg, err));
    this.isValid = deps.isValidToken ?? ((t) => EXPO_PUSH_TOKEN.test(t));
  }

  async notify(owner: string, n: Notification): Promise<NotifyResult> {
    const result: NotifyResult = { tokens: 0, sent: 0, errors: 0, pruned: 0 };
    let tokens: string[];
    try {
      tokens = this.store.tokensForOwner(owner).map((r) => r.token).filter((t) => this.isValid(t));
    } catch (err) {
      this.log("push tokensForOwner failed", err);
      return result;
    }
    result.tokens = tokens.length;
    if (tokens.length === 0) return result;

    const messages: ExpoPushMessage[] = tokens.map((to) => ({
      to,
      sound: "default",
      title: n.title,
      body: n.body,
      data: n.data,
    }));

    let chunks: ExpoPushMessage[][];
    try {
      chunks = this.expo.chunkPushNotifications(messages);
    } catch (err) {
      this.log("push chunk failed", err);
      result.errors += tokens.length;
      return result;
    }

    let cursor = 0; // index into `tokens`, advanced per chunk to keep ticket↔token alignment
    for (const chunk of chunks) {
      const chunkTokens = tokens.slice(cursor, cursor + chunk.length);
      cursor += chunk.length;
      let tickets: ExpoPushTicket[];
      try {
        tickets = await this.expo.sendPushNotificationsAsync(chunk);
      } catch (err) {
        this.log("push send chunk failed", err);
        result.errors += chunk.length;
        continue;
      }
      for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        const token = chunkTokens[i];
        if (ticket.status === "ok") {
          result.sent++;
          continue;
        }
        result.errors++;
        if (ticket.details?.error === "DeviceNotRegistered" && token) {
          try {
            this.store.deleteToken(token);
            result.pruned++;
          } catch (err) {
            this.log("push prune failed", err);
          }
        }
      }
    }
    return result;
  }
}
