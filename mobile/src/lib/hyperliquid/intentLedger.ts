import { generateCloid } from "./cloid";
import type { NormalizedStatus, OrderStatusKind } from "./order";

/**
 * Persistent intent ledger / state machine (spec §6.2).
 * Flow: intent -> persist (cloid, pending) -> sign -> submit -> reconcile by cloid.
 * On uncertain HTTP/WS receipts, retries reuse the SAME cloid and are deduped here
 * so we never produce duplicate or orphan orders.
 */
export type IntentStatus =
  | "pending" // persisted, not yet signed/submitted
  | "submitted" // sent, receipt uncertain (in flight)
  | "open" // resting/live on the book
  | "filled"
  | "rejected"
  | "canceled";

export interface OrderIntent {
  cloid: `0x${string}`;
  coin: string;
  side: "buy" | "sell";
  size: number;
  price: number;
  status: IntentStatus;
  attempts: number;
  oid?: number;
  reason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface IntentInput {
  coin: string;
  side: "buy" | "sell";
  size: number;
  price: number;
  /** Reuse on retry; generated if absent (persisted BEFORE signing). */
  cloid?: `0x${string}`;
}

/** Injectable storage so the in-memory default can be swapped for a persistent one. */
export interface IntentStore {
  get(cloid: string): OrderIntent | undefined;
  set(cloid: string, intent: OrderIntent): void;
  delete(cloid: string): void;
  values(): OrderIntent[];
}

export class MemoryIntentStore implements IntentStore {
  private map = new Map<string, OrderIntent>();
  get(cloid: string) {
    return this.map.get(cloid);
  }
  set(cloid: string, intent: OrderIntent) {
    this.map.set(cloid, intent);
  }
  delete(cloid: string) {
    this.map.delete(cloid);
  }
  values() {
    return [...this.map.values()];
  }
}

const TERMINAL: ReadonlySet<IntentStatus> = new Set(["filled", "rejected", "canceled"]);

function isTerminalStatus(s: IntentStatus): boolean {
  return TERMINAL.has(s);
}

function intentStatusFromKind(kind: OrderStatusKind): IntentStatus {
  switch (kind) {
    case "resting":
    case "waiting":
      return "open";
    case "filled":
      return "filled";
    case "rejected":
      return "rejected";
    case "canceled":
      return "canceled";
    default:
      return "submitted";
  }
}

export class IntentLedger {
  constructor(
    private store: IntentStore = new MemoryIntentStore(),
    private clock: () => number = () => Date.now(),
    private cloidFactory: () => `0x${string}` = generateCloid,
  ) {}

  /** Create-or-get a pending intent BEFORE signing. Idempotent by cloid (retry-safe). */
  open(input: IntentInput): OrderIntent {
    const cloid = input.cloid ?? this.cloidFactory();
    const existing = this.store.get(cloid);
    if (existing) {
      existing.attempts += 1;
      existing.updatedAt = this.clock();
      this.store.set(cloid, existing);
      return existing;
    }
    const now = this.clock();
    const intent: OrderIntent = {
      cloid,
      coin: input.coin,
      side: input.side,
      size: input.size,
      price: input.price,
      status: "pending",
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.store.set(cloid, intent);
    return intent;
  }

  get(cloid: string): OrderIntent | undefined {
    return this.store.get(cloid);
  }

  /** Find an intent by its exchange-assigned order id (set during reconcile). */
  getByOid(oid: number): OrderIntent | undefined {
    return this.store.values().find((i) => i.oid === oid);
  }

  markSubmitted(cloid: string): OrderIntent | undefined {
    return this.transition(cloid, "submitted");
  }

  /** Mark an intent canceled after a cancel/modify. Won't override a settled (terminal) state. */
  markCanceled(cloid: string): OrderIntent | undefined {
    const i = this.store.get(cloid);
    if (!i) return undefined;
    if (isTerminalStatus(i.status)) return i;
    i.status = "canceled";
    i.updatedAt = this.clock();
    this.store.set(cloid, i);
    return i;
  }

  /** Reconcile a persisted intent against a normalized HL status (monotonic toward terminal). */
  reconcile(cloid: string, status: NormalizedStatus): OrderIntent | undefined {
    const intent = this.store.get(cloid);
    if (!intent) return undefined;
    const next = intentStatusFromKind(status.kind);
    // Out-of-order WS guard: never regress out of a terminal state.
    if (isTerminalStatus(intent.status) && !isTerminalStatus(next)) {
      return intent;
    }
    intent.status = next;
    if (status.oid !== undefined) intent.oid = status.oid;
    if (next === "rejected" || next === "canceled") intent.reason = status.message;
    intent.updatedAt = this.clock();
    this.store.set(cloid, intent);
    return intent;
  }

  /** Already settled (filled/rejected/canceled)? Used to dedupe uncertain receipts. */
  isSettled(cloid: string): boolean {
    const i = this.store.get(cloid);
    return !!i && isTerminalStatus(i.status);
  }

  /** Safe to (re)submit for this cloid? False once the order is live or terminal. */
  shouldSubmit(cloid: string): boolean {
    const i = this.store.get(cloid);
    if (!i) return true;
    return i.status === "pending" || i.status === "submitted";
  }

  /** Non-terminal, un-reconciled intents (recovery / orphan sweep). */
  pending(): OrderIntent[] {
    return this.store.values().filter((i) => i.status === "pending" || i.status === "submitted");
  }

  private transition(cloid: string, status: IntentStatus): OrderIntent | undefined {
    const i = this.store.get(cloid);
    if (!i) return undefined;
    i.status = status;
    i.updatedAt = this.clock();
    this.store.set(cloid, i);
    return i;
  }
}
