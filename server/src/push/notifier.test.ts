import { Notifier, type ExpoLike } from "./notifier";
import type { ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";
import type { PushTokenRow } from "./pushTokenStore";

const T1 = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const T2 = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";
const T3 = "ExponentPushToken[cccccccccccccccccccccc]";
const OWNER = "0x1111111111111111111111111111111111111111";

function row(token: string, locale: string | null = null): PushTokenRow {
  return { token, owner: OWNER, platform: "ios", locale, createdAt: 1, updatedAt: 1 };
}

// Fake store recording deleteToken calls.
function fakeStore(tokens: string[]) {
  const deleted: string[] = [];
  return {
    deleted,
    tokensForOwner: (_owner: string) => tokens.map((t) => row(t)),
    deleteToken: (token: string) => { deleted.push(token); },
  };
}

// Fake store with per-token locale.
function fakeStoreLocales(entries: { token: string; locale: string | null }[]) {
  const deleted: string[] = [];
  return {
    deleted,
    tokensForOwner: (_o: string) => entries.map((e) => row(e.token, e.locale)),
    deleteToken: (t: string) => { deleted.push(t); },
  };
}

// Fake Expo: chunk by `chunkSize`; send returns programmed tickets or throws.
function fakeExpo(opts: {
  chunkSize?: number;
  tickets?: (chunk: ExpoPushMessage[]) => ExpoPushTicket[];
  throwOnChunk?: number; // index of chunk that throws
}): ExpoLike & { sends: ExpoPushMessage[][] } {
  const sends: ExpoPushMessage[][] = [];
  let sendCount = 0;
  return {
    sends,
    chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][] {
      const size = opts.chunkSize ?? (messages.length || 1);
      const out: ExpoPushMessage[][] = [];
      for (let i = 0; i < messages.length; i += size) out.push(messages.slice(i, i + size));
      return out;
    },
    async sendPushNotificationsAsync(chunk: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
      const idx = sendCount++;
      sends.push(chunk);
      if (opts.throwOnChunk === idx) throw new Error("network");
      return opts.tickets ? opts.tickets(chunk) : chunk.map(() => ({ status: "ok", id: "r" }) as ExpoPushTicket);
    },
  };
}

const okTickets = (chunk: ExpoPushMessage[]): ExpoPushTicket[] => chunk.map(() => ({ status: "ok", id: "r" }));

describe("Notifier.notify", () => {
  const N = { title: "Filled", body: "Your order filled", data: { kind: "fill" } };

  it("returns zeros and does not send when the owner has no tokens", async () => {
    const store = fakeStore([]);
    const expo = fakeExpo({ tickets: okTickets });
    const res = await new Notifier({ expo, store }).notify(OWNER, () => N);
    expect(res).toEqual({ tokens: 0, sent: 0, errors: 0, pruned: 0 });
    expect(expo.sends).toHaveLength(0);
  });

  it("sends to all valid tokens and reports them sent", async () => {
    const store = fakeStore([T1, T2]);
    const expo = fakeExpo({ tickets: okTickets });
    const res = await new Notifier({ expo, store }).notify(OWNER, () => N);
    expect(res).toEqual({ tokens: 2, sent: 2, errors: 0, pruned: 0 });
    const msgs = expo.sends.flat();
    expect(msgs.map((m) => m.to)).toEqual([T1, T2]);
    expect(msgs[0]).toMatchObject({ to: T1, title: "Filled", body: "Your order filled", data: { kind: "fill" }, sound: "default" });
  });

  it("prunes a token that returns DeviceNotRegistered", async () => {
    const store = fakeStore([T1, T2]);
    const expo = fakeExpo({
      tickets: (chunk) => chunk.map((m) => (m.to === T1 ? ({ status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }) : ({ status: "ok", id: "r" })) as ExpoPushTicket),
    });
    const res = await new Notifier({ expo, store }).notify(OWNER, () => N);
    expect(res).toEqual({ tokens: 2, sent: 1, errors: 1, pruned: 1 });
    expect(store.deleted).toEqual([T1]);
  });

  it("does not prune non-DeviceNotRegistered errors", async () => {
    const store = fakeStore([T1]);
    const expo = fakeExpo({
      tickets: () => [{ status: "error", message: "slow down", details: { error: "MessageRateExceeded" } } as ExpoPushTicket],
    });
    const res = await new Notifier({ expo, store }).notify(OWNER, () => N);
    expect(res).toEqual({ tokens: 1, sent: 0, errors: 1, pruned: 0 });
    expect(store.deleted).toEqual([]);
  });

  it("filters out invalid tokens before sending", async () => {
    const store = fakeStore([T1, "garbage"]);
    const expo = fakeExpo({ tickets: okTickets });
    const res = await new Notifier({ expo, store, isValidToken: (t) => t === T1 }).notify(OWNER, () => N);
    expect(res).toEqual({ tokens: 1, sent: 1, errors: 0, pruned: 0 });
    expect(expo.sends.flat().map((m) => m.to)).toEqual([T1]);
  });

  it("does not throw when a send chunk rejects; logs and counts errors", async () => {
    const store = fakeStore([T1]);
    const expo = fakeExpo({ throwOnChunk: 0 });
    const logs: string[] = [];
    const res = await new Notifier({ expo, store, logger: (m) => logs.push(m) }).notify(OWNER, () => N);
    expect(res).toEqual({ tokens: 1, sent: 0, errors: 1, pruned: 0 });
    expect(logs.length).toBeGreaterThan(0);
  });

  it("correlates tickets to tokens across chunks (prunes the right token)", async () => {
    const store = fakeStore([T1, T2, T3]);
    // chunkSize 1 → three chunks; only the T2 chunk returns DeviceNotRegistered.
    const expo = fakeExpo({
      chunkSize: 1,
      tickets: (chunk) => chunk.map((m) => (m.to === T2 ? ({ status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }) : ({ status: "ok", id: "r" })) as ExpoPushTicket),
    });
    const res = await new Notifier({ expo, store }).notify(OWNER, () => N);
    expect(res).toEqual({ tokens: 3, sent: 2, errors: 1, pruned: 1 });
    expect(store.deleted).toEqual([T2]);
  });

  it("does not throw when tokensForOwner throws", async () => {
    const store = {
      tokensForOwner: () => { throw new Error("db"); },
      deleteToken: () => {},
    };
    const expo = fakeExpo({ tickets: okTickets });
    const logs: string[] = [];
    const res = await new Notifier({ expo, store, logger: (m) => logs.push(m) }).notify(OWNER, () => N);
    expect(res).toEqual({ tokens: 0, sent: 0, errors: 0, pruned: 0 });
    expect(logs.length).toBeGreaterThan(0);
  });

  it("renders each token in its own locale (default en)", async () => {
    const store = fakeStoreLocales([
      { token: T1, locale: "en" },
      { token: T2, locale: "zh" },
      { token: T3, locale: null },
    ]);
    const expo = fakeExpo({ chunkSize: 10, tickets: okTickets });
    const res = await new Notifier({ expo, store }).notify(OWNER, (locale) => ({ title: locale, body: `b-${locale}`, data: {} }));
    expect(res.sent).toBe(3);
    const byTok = new Map(expo.sends.flat().map((m) => [m.to, m]));
    expect(byTok.get(T1)?.title).toBe("en");
    expect(byTok.get(T2)?.title).toBe("zh");
    expect(byTok.get(T3)?.title).toBe("en"); // null → en
  });
});
