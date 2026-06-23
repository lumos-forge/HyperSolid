import { randomUUID } from "crypto";
import type { DcaParams, DcaStrategy } from "./dca";

/** Persistence boundary for strategies — swap MemoryStrategyStore for a SQLite impl later (BE T9). */
export interface StrategyStore {
  create(owner: string, params: DcaParams): DcaStrategy;
  get(id: string): DcaStrategy | undefined;
  list(owner: string): DcaStrategy[];
  listAll(): DcaStrategy[];
  setStatus(id: string, status: "running" | "paused"): void;
  recordFill(id: string, quoteUsdc: number, nextRunAt: number): void;
  remove(id: string): void;
}

/** In-memory store for tests/dev. `now` is injectable so scheduling is deterministic. */
export class MemoryStrategyStore implements StrategyStore {
  private byId = new Map<string, DcaStrategy>();

  constructor(private now: () => number = () => Date.now()) {}

  create(owner: string, params: DcaParams): DcaStrategy {
    const s: DcaStrategy = {
      id: randomUUID(),
      owner,
      status: "running",
      params,
      nextRunAt: this.now(),
      filledTotalUsdc: 0,
    };
    this.byId.set(s.id, s);
    return s;
  }

  get(id: string): DcaStrategy | undefined {
    return this.byId.get(id);
  }

  list(owner: string): DcaStrategy[] {
    return this.listAll().filter((s) => s.owner === owner);
  }

  listAll(): DcaStrategy[] {
    return [...this.byId.values()];
  }

  setStatus(id: string, status: "running" | "paused"): void {
    const s = this.byId.get(id);
    if (s) s.status = status;
  }

  recordFill(id: string, quoteUsdc: number, nextRunAt: number): void {
    const s = this.byId.get(id);
    if (s) {
      s.filledTotalUsdc += quoteUsdc;
      s.nextRunAt = nextRunAt;
    }
  }

  remove(id: string): void {
    this.byId.delete(id);
  }
}
