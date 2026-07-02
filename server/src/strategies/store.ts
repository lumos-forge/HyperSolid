import { randomUUID } from "crypto";
import type { Strategy, StrategyKind, StrategyParams, StrategyStatus, DcaParams, TwapParams, TpslParams, GridParams } from "./types";

/** Persistence boundary for strategies. */
export interface StrategyStore {
  create(owner: string, kind: StrategyKind, params: StrategyParams): Strategy;
  get(id: string): Strategy | undefined;
  list(owner: string): Strategy[];
  listAll(): Strategy[];
  setStatus(id: string, status: StrategyStatus): void;
  recordFill(id: string, quoteUsdc: number, nextRunAt: number): void;
  recordTrigger(id: string, now: number): void;
  remove(id: string): void;
}

function build(owner: string, kind: StrategyKind, params: StrategyParams, now: number): Strategy {
  const base = { id: randomUUID(), owner, status: "running" as const, createdAt: now };
  if (kind === "dca") return { ...base, kind, params: params as DcaParams, nextRunAt: now, filledTotalUsdc: 0 };
  if (kind === "twap") return { ...base, kind, params: params as TwapParams, nextRunAt: now, filledTotalUsdc: 0, slicesDone: 0 };
  if (kind === "grid") return { ...base, kind, params: params as GridParams, filledTotalUsdc: 0, actionsDone: 0 };
  return { ...base, kind, params: params as TpslParams };
}

/** In-memory store for tests/dev. `now` is injectable so scheduling is deterministic. */
export class MemoryStrategyStore implements StrategyStore {
  private byId = new Map<string, Strategy>();
  constructor(private now: () => number = () => Date.now()) {}

  create(owner: string, kind: StrategyKind, params: StrategyParams): Strategy {
    const s = build(owner, kind, params, this.now());
    this.byId.set(s.id, s);
    return s;
  }
  get(id: string): Strategy | undefined { return this.byId.get(id); }
  list(owner: string): Strategy[] { return this.listAll().filter((s) => s.owner.toLowerCase() === owner.toLowerCase()); }
  listAll(): Strategy[] { return [...this.byId.values()]; }

  setStatus(id: string, status: StrategyStatus): void {
    const s = this.byId.get(id);
    if (s) s.status = status;
  }

  recordFill(id: string, quoteUsdc: number, nextRunAt: number): void {
    const s = this.byId.get(id);
    if (!s) return;
    s.filledTotalUsdc = (s.filledTotalUsdc ?? 0) + quoteUsdc;
    s.nextRunAt = nextRunAt;
    if (s.kind === "twap") {
      s.slicesDone = (s.slicesDone ?? 0) + 1;
      if (s.slicesDone >= s.params.slices) s.status = "completed";
    }
  }

  recordTrigger(id: string, now: number): void {
    const s = this.byId.get(id);
    if (!s) return;
    s.triggeredAt = now;
    s.status = "completed";
  }

  remove(id: string): void { this.byId.delete(id); }
}
