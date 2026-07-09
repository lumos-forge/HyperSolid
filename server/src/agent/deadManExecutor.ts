/** Narrow agent-signed client surface for the dead-man switch. @nktkas ExchangeClient satisfies it. */
export interface DeadManClientLike {
  scheduleCancel(params: { time?: number }): Promise<unknown>;
}

export interface DeadManExecutorDeps {
  clientFor(owner: string): DeadManClientLike | undefined;
  /** Optional fire-and-forget shadow verifier (compares Go signer digest); never affects execution. */
  shadowVerify?: (kind: string, params: unknown) => void;
}

export interface DeadManExecutor {
  /** Arm (or refresh) the owner's scheduleCancel to fire at timeMs. Returns false on no client or error. */
  arm(owner: string, timeMs: number): Promise<boolean>;
  /** Clear the owner's scheduled cancel (omit time). Returns false on no client or error. */
  clear(owner: string): Promise<boolean>;
}

/**
 * Build the dead-man executor on an agent-signed client. Each arm sends a scheduleCancel with the
 * target fire time (ms). Fails closed: no client or a thrown error returns false so the heartbeat
 * does NOT mark the owner armed and retries next tick.
 */
export function makeDeadManExecutor(deps: DeadManExecutorDeps): DeadManExecutor {
  return {
    async arm(owner: string, timeMs: number): Promise<boolean> {
      const client = deps.clientFor(owner);
      if (!client) return false;
      try {
        deps.shadowVerify?.("scheduleCancel", { time: timeMs });
      } catch {
        /* shadow must never affect execution */
      }
      try {
        await client.scheduleCancel({ time: timeMs });
        return true;
      } catch {
        return false; // fail-closed: not armed this tick; heartbeat retries
      }
    },
    async clear(owner: string): Promise<boolean> {
      const client = deps.clientFor(owner);
      if (!client) return false;
      try {
        deps.shadowVerify?.("scheduleCancel", {});
      } catch {
        /* shadow must never affect execution */
      }
      try {
        await client.scheduleCancel({});
        return true;
      } catch {
        return false; // best-effort clear
      }
    },
  };
}
