import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useDeadManStore } from "../state/deadManStore";
import { useWalletStore } from "../state/walletStore";
import { useEnvStore } from "../state/envStore";
import { createExchangeClient } from "../lib/hyperliquid/client";
import { buildAssetIndex } from "../lib/hyperliquid/assetId";
import { ExchangeService } from "../services/exchange";
import { decideArm, nextArm, type ArmBudget } from "../lib/deadManBudget";
import type { LocalWalletService } from "../wallet/localWallet";
import type { Network } from "../state/envStore";

/** Heartbeat interval: half the TTL, floored at 20s — strictly < TTL so refreshes stay free. */
export function heartbeatMs(ttlMs: number): number {
  return Math.max(20_000, Math.floor(ttlMs / 2));
}

function makeService(network: Network): ExchangeService | null {
  const { mode, wallet } = useWalletStore.getState();
  if (mode !== "local" || !wallet) return null;
  const local = wallet as Partial<LocalWalletService>;
  if (typeof local.getViemAccount !== "function") return null;
  return new ExchangeService(createExchangeClient(network, local.getViemAccount()), buildAssetIndex({ universe: [] }));
}

/**
 * Manual-trader dead-man (opt-in). While enabled + foregrounded + a local wallet is connected, keeps an
 * HL scheduleCancel armed (`now + ttl`) on a heartbeat (< ttl → refreshes are free, ≤10/day budget-
 * guarded). On background the interval stops so the armed schedule fires (cancels all resting orders) if
 * the app stays gone past the ttl. On disable / wallet change / unmount it clears the schedule so there's
 * no surprise cancellation while the user is active. Fail-safe: an arm error just skips the tick.
 */
export function useManualDeadMan(): void {
  const enabled = useDeadManStore((s) => s.enabled);
  const ttlMinutes = useDeadManStore((s) => s.ttlMinutes);
  const mode = useWalletStore((s) => s.mode);
  const address = useWalletStore((s) => s.address);
  const network = useEnvStore((s) => s.network);
  const budgetRef = useRef<ArmBudget | undefined>(undefined);

  // A new wallet/network is a new HL account → reset the arm budget.
  useEffect(() => {
    budgetRef.current = undefined;
  }, [address, network]);

  useEffect(() => {
    if (!(enabled && mode === "local" && address)) return;
    const service = makeService(network);
    if (!service) return;
    const ttlMs = ttlMinutes * 60_000;

    async function arm(): Promise<void> {
      const now = Date.now();
      const d = decideArm(budgetRef.current, now, ttlMs);
      if (d.skip) return;
      const res = await service!.scheduleCancel(d.time);
      if (res.ok) budgetRef.current = nextArm(budgetRef.current, now, d.time, d.counts);
    }

    let timer: ReturnType<typeof setInterval> | null = null;
    function start(): void {
      if (timer) return;
      void arm();
      timer = setInterval(() => void arm(), heartbeatMs(ttlMs));
    }
    function stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }

    if (AppState.currentState === "active") start();
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (next === "active") start();
      else stop(); // background/inactive → leave the armed schedule to fire
    });

    return () => {
      sub.remove();
      stop();
      // Disable / wallet change / unmount while the user is present → clear (no surprise cancellation).
      void service.scheduleCancel().catch(() => undefined);
    };
  }, [enabled, ttlMinutes, mode, address, network]);
}
