import type { ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";
import type { PushTokenStore, PushTokenRow } from "./pushTokenStore";
import { toPushLocale, type PushLocale } from "./messages";
import type { PushCategory, PushPrefStore } from "./pushPrefStore";
import type { PushReceiptStore } from "./pushReceiptStore";

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
  /** Optional per-owner category gate; when absent, all categories send. */
  prefs?: Pick<PushPrefStore, "isEnabled">;
  /** Optional quiet-hours gate; only fills are suppressed. */
  quietHours?: { isQuietNow(owner: string, nowMs: number): boolean };
  /** Clock for quiet-hours evaluation; defaults to Date.now. */
  now?: () => number;
  /** Optional delayed-receipt registry; ok tickets are recorded for later polling. */
  receipts?: Pick<PushReceiptStore, "record">;
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
  private readonly prefs?: Pick<PushPrefStore, "isEnabled">;
  private readonly quietHours?: { isQuietNow(owner: string, nowMs: number): boolean };
  private readonly receipts?: Pick<PushReceiptStore, "record">;
  private readonly now: () => number;
  private readonly log: (msg: string, err?: unknown) => void;
  private readonly isValid: (token: string) => boolean;

  constructor(deps: NotifierDeps) {
    this.expo = deps.expo;
    this.store = deps.store;
    this.prefs = deps.prefs;
    this.quietHours = deps.quietHours;
    this.receipts = deps.receipts;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.logger ?? ((msg, err) => console.error(msg, err));
    this.isValid = deps.isValidToken ?? ((t) => EXPO_PUSH_TOKEN.test(t));
  }

  async notify(owner: string, category: PushCategory, render: (locale: PushLocale) => Notification): Promise<NotifyResult> {
    const result: NotifyResult = { tokens: 0, sent: 0, errors: 0, pruned: 0 };
    if (this.prefs) {
      let enabled = true;
      try {
        enabled = this.prefs.isEnabled(owner, category);
      } catch (err) {
        this.log("push prefs lookup failed", err); // fail-open: send anyway
      }
      if (!enabled) return result; // category disabled → skip entirely
    }
    if (category === "fills" && this.quietHours) {
      try {
        if (this.quietHours.isQuietNow(owner, this.now())) return result; // quiet → skip fills
      } catch (err) {
        this.log("push quiet-hours lookup failed", err); // fail-open: send anyway
      }
    }
    let rows: PushTokenRow[];
    try {
      rows = this.store.tokensForOwner(owner).filter((r) => this.isValid(r.token));
    } catch (err) {
      this.log("push tokensForOwner failed", err);
      return result;
    }
    result.tokens = rows.length;
    if (rows.length === 0) return result;

    const cache = new Map<PushLocale, Notification>();
    const renderFor = (loc: PushLocale): Notification => {
      let n = cache.get(loc);
      if (!n) {
        n = render(loc);
        cache.set(loc, n);
      }
      return n;
    };

    const tokens = rows.map((r) => r.token);
    const messages: ExpoPushMessage[] = rows.map((r) => {
      const n = renderFor(toPushLocale(r.locale));
      return { to: r.token, sound: "default", title: n.title, body: n.body, data: n.data };
    });

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
          if (this.receipts && ticket.id && token) {
            try {
              this.receipts.record(ticket.id, token, this.now());
            } catch (err) {
              this.log("push receipt record failed", err); // fail-safe
            }
          }
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
