import { useAuthStore } from "../state/authStore";
import { useWalletStore } from "../state/walletStore";
import type { BiometricGate, AuthResult } from "./biometricGate";
import type { DeviceIntegrity } from "./deviceIntegrity";
import type { WalletManager } from "./walletManager";

const UNLOCK_REASON = "解锁 HyperSolid 钱包";

export async function unlockSession(
  gate: BiometricGate,
  manager: WalletManager,
  integrity: DeviceIntegrity,
): Promise<AuthResult> {
  // Fail closed: only a positively-trusted device may unlock/sign. "compromised"
  // (rooted/jailbroken) and "unknown" (detection failed/indeterminate — the state
  // a tampered runtime can induce) both block before any biometric prompt or key load.
  if ((await integrity.check()) !== "trusted") return "compromised";
  const result = await gate.authenticate({ reason: UNLOCK_REASON });
  if (result !== "success") return result;
  let wallet;
  try {
    wallet = await manager.loadWallet();
  } catch {
    return "failed";
  }
  if (!wallet) return "failed";
  useWalletStore.getState().setLocalWallet(wallet);
  useAuthStore.getState().unlock();
  return "success";
}

export function lockSession(): void {
  useWalletStore.getState().reset();
  useAuthStore.getState().lock();
}
