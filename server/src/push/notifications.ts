import type { Notification } from "./notifier";
import type { Activity } from "../strategies/activityStore";

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

/** "Order filled" — "Buy 0.01 BTC @ 50,000". */
export function fillNotification(a: Activity): Notification {
  return {
    title: "Order filled",
    body: `${capitalize(a.side)} ${fmt(a.sz)} ${a.coin} @ ${fmt(a.px)}`,
    data: { kind: "fill", strategyId: a.strategyId, coin: a.coin, side: a.side, sz: a.sz, px: a.px },
  };
}

/** Dead-man protection is failing (agent authorization at risk). */
export function deadManAlertNotification(ev: { consecutiveFailures: number }): Notification {
  return {
    title: "Strategy protection at risk",
    body: `${ev.consecutiveFailures} consecutive unprotected heartbeats — check your agent authorization.`,
    data: { kind: "deadman_alert", consecutiveFailures: ev.consecutiveFailures },
  };
}

/** Dead-man protection recovered. */
export function deadManRecoveredNotification(): Notification {
  return {
    title: "Strategy protection restored",
    body: "Your automated strategies are protected again.",
    data: { kind: "deadman_recovered" },
  };
}
