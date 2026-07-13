import type { StrategyStore } from "./store";
import type { Strategy, StrategyKind, StrategyParams, StrategyStatus } from "./types";
import type { RungState } from "./gridLimit";
import type { Notifier } from "../push/notifier";
import type { PushLocale } from "../push/messages";
import { strategyCompletedNotification } from "../push/notifications";

/** Wraps a StrategyStore; when a strategy transitions to `completed`, fires a
 *  `lifecycle` push (fire-and-forget; Notifier.notify is itself fail-safe).
 *  All other behavior passes through unchanged. */
export class NotifyingStrategyStore implements StrategyStore {
  constructor(
    private readonly inner: StrategyStore,
    private readonly notifier: Pick<Notifier, "notify">,
  ) {}

  private fireIfCompleted(id: string, before: StrategyStatus | undefined): void {
    const s = this.inner.get(id);
    if (!s || before === "completed" || s.status !== "completed") return;
    try {
      // fire-and-forget: swallow a synchronous throw and an async rejection so a
      // broken notifier can never break strategy persistence.
      void Promise.resolve(
        this.notifier.notify(s.owner, "lifecycle", (locale: PushLocale) => strategyCompletedNotification(s, locale)),
      ).catch(() => {});
    } catch {
      // notifier threw synchronously (non-async broken impl)
    }
  }

  // --- completion-producing methods: detect running→completed and notify ---
  setStatus(id: string, status: StrategyStatus): void {
    const before = this.inner.get(id)?.status;
    this.inner.setStatus(id, status);
    this.fireIfCompleted(id, before);
  }
  recordFill(id: string, quoteUsdc: number, nextRunAt: number): void {
    const before = this.inner.get(id)?.status;
    this.inner.recordFill(id, quoteUsdc, nextRunAt);
    this.fireIfCompleted(id, before);
  }
  recordTrigger(id: string, now: number): void {
    const before = this.inner.get(id)?.status;
    this.inner.recordTrigger(id, now);
    this.fireIfCompleted(id, before);
  }

  // --- pure pass-throughs ---
  create(owner: string, kind: StrategyKind, params: StrategyParams): Strategy {
    return this.inner.create(owner, kind, params);
  }
  get(id: string): Strategy | undefined { return this.inner.get(id); }
  list(owner: string): Strategy[] { return this.inner.list(owner); }
  listAll(): Strategy[] { return this.inner.listAll(); }
  seedGridLevel(id: string, level: number): void { this.inner.seedGridLevel(id, level); }
  recordGridAction(id: string, newLevel: number, boughtUsdc: number): void { this.inner.recordGridAction(id, newLevel, boughtUsdc); }
  gridLimitRungs(id: string): RungState[] { return this.inner.gridLimitRungs(id); }
  setGridLimitRung(id: string, rung: RungState): void { this.inner.setGridLimitRung(id, rung); }
  addFilledUsdc(id: string, usdc: number): void { this.inner.addFilledUsdc(id, usdc); }
  setTrailPeak(id: string, peak: number): void { this.inner.setTrailPeak(id, peak); }
  remove(id: string): void { this.inner.remove(id); }
}
