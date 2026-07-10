import type { Notification } from "./notifier";
import type { Activity } from "../strategies/activityStore";
import { pushMessages, type PushLocale } from "./messages";

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

/** Fill notification, localized. */
export function fillNotification(a: Activity, locale: PushLocale): Notification {
  const m = pushMessages[locale];
  return {
    title: m.fillTitle,
    body: m.fillBody(a.side, fmt(a.sz), a.coin, fmt(a.px)),
    data: { kind: "fill", strategyId: a.strategyId, coin: a.coin, side: a.side, sz: a.sz, px: a.px },
  };
}

/** Dead-man protection failing, localized. */
export function deadManAlertNotification(ev: { consecutiveFailures: number }, locale: PushLocale): Notification {
  const m = pushMessages[locale];
  return {
    title: m.deadmanAlertTitle,
    body: m.deadmanAlertBody(ev.consecutiveFailures),
    data: { kind: "deadman_alert", consecutiveFailures: ev.consecutiveFailures },
  };
}

/** Dead-man protection recovered, localized. */
export function deadManRecoveredNotification(locale: PushLocale): Notification {
  const m = pushMessages[locale];
  return {
    title: m.deadmanRecoveredTitle,
    body: m.deadmanRecoveredBody,
    data: { kind: "deadman_recovered" },
  };
}
