import * as SecureStore from "expo-secure-store";
import { derivePinVerifier, verifyPin, type PinVerifier } from "./pin";

const VERIFIER_KEY = "hypersolid.pin.verifier";
const ATTEMPTS_KEY = "hypersolid.pin.attempts";

/** Consecutive wrong-PIN attempts allowed before PIN unlock locks out (→ seed-restore recovery). */
export const MAX_PIN_ATTEMPTS = 10;

const deviceOnly = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;

export type PinVerifyResult =
  | { ok: true }
  | { ok: false; lockedOut: true }
  | { ok: false; lockedOut: false; remaining: number };

/**
 * App-PIN store: persists a salted PBKDF2 verifier (never the PIN) plus a consecutive-failure counter
 * in a non-auth, device-bound keychain item. Gates app access as the knowledge factor / biometric
 * fallback. `iterations` is injectable so tests can run a cheap KDF.
 */
export class PinStore {
  constructor(private iterations: number = 100000) {}

  async setPin(pin: string): Promise<void> {
    const verifier = derivePinVerifier(pin, undefined, this.iterations);
    await SecureStore.setItemAsync(VERIFIER_KEY, JSON.stringify(verifier), deviceOnly);
    await SecureStore.setItemAsync(ATTEMPTS_KEY, "0", deviceOnly);
  }

  async hasPin(): Promise<boolean> {
    return (await SecureStore.getItemAsync(VERIFIER_KEY)) !== null;
  }

  async verify(pin: string): Promise<PinVerifyResult> {
    const raw = await SecureStore.getItemAsync(VERIFIER_KEY);
    if (!raw) return { ok: false, lockedOut: false, remaining: MAX_PIN_ATTEMPTS };
    const verifier = JSON.parse(raw) as PinVerifier;
    const attempts = Number((await SecureStore.getItemAsync(ATTEMPTS_KEY)) ?? "0");
    if (attempts >= MAX_PIN_ATTEMPTS) return { ok: false, lockedOut: true };

    if (verifyPin(pin, verifier)) {
      await SecureStore.setItemAsync(ATTEMPTS_KEY, "0", deviceOnly);
      return { ok: true };
    }
    const next = attempts + 1;
    await SecureStore.setItemAsync(ATTEMPTS_KEY, String(next), deviceOnly);
    return next >= MAX_PIN_ATTEMPTS
      ? { ok: false, lockedOut: true }
      : { ok: false, lockedOut: false, remaining: MAX_PIN_ATTEMPTS - next };
  }

  /** Change the PIN: verify the current one (counts against lockout) then store the new verifier. */
  async change(oldPin: string, newPin: string): Promise<PinVerifyResult> {
    const result = await this.verify(oldPin);
    if (result.ok) await this.setPin(newPin);
    return result;
  }

  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(VERIFIER_KEY);
    await SecureStore.deleteItemAsync(ATTEMPTS_KEY);
  }
}
