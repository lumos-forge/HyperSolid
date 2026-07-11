import type { ActivityStore, Activity } from "../strategies/activityStore";
import type { Notifier } from "./notifier";
import type { PushLocale } from "./messages";
import { fillNotification } from "./notifications";

/** Wraps an ActivityStore; on record() also fires a fill push notification
 *  (fire-and-forget; Notifier.notify is itself fail-safe). Other methods pass through. */
export class NotifyingActivityStore implements ActivityStore {
  constructor(
    private readonly inner: ActivityStore,
    private readonly notifier: Pick<Notifier, "notify">,
  ) {}

  record(a: Omit<Activity, "id">): Activity {
    const row = this.inner.record(a);
    try {
      // fire-and-forget: swallow both a synchronous throw and an async rejection
      // so a broken notifier can never break activity recording.
      void Promise.resolve(this.notifier.notify(row.owner, "fills", (locale: PushLocale) => fillNotification(row, locale))).catch(() => {});
    } catch {
      // notifier threw synchronously (non-async broken impl)
    }
    return row;
  }

  list(owner: string, strategyId: string): Activity[] {
    return this.inner.list(owner, strategyId);
  }

  listRecent(owner: string, limit: number): Activity[] {
    return this.inner.listRecent(owner, limit);
  }

  notionalSince(owner: string, sinceMs: number): number {
    return this.inner.notionalSince(owner, sinceMs);
  }
}
