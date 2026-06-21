import * as SecureStore from "expo-secure-store";
import type { KeyStore } from "./types";

const KEY = "hypersolid.wallet.mnemonic";
const PRESENT_KEY = "hypersolid.wallet.present";

/**
 * Device keystore: biometric-gated mnemonic storage (Passkey-local, ADR-011).
 * The work key is hardware-protected (Secure Enclave / StrongBox) and requires
 * authentication on read. A separate non-auth presence marker is used so
 * existence checks never prompt; only the mnemonic read is biometric-gated.
 * NOTE: requireAuthentication items do NOT iCloud-sync; the optional iCloud
 * mnemonic backup must be a separate, non-auth item (spec §5.5).
 */
export class SecureStoreKeyStore implements KeyStore {
  async saveMnemonic(mnemonic: string): Promise<void> {
    await SecureStore.setItemAsync(KEY, mnemonic, {
      requireAuthentication: true,
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    await SecureStore.setItemAsync(PRESENT_KEY, "1", {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }
  async loadMnemonic(): Promise<string | null> {
    return SecureStore.getItemAsync(KEY, { requireAuthentication: true });
  }
  async has(): Promise<boolean> {
    return (await SecureStore.getItemAsync(PRESENT_KEY)) !== null;
  }
  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(KEY);
    await SecureStore.deleteItemAsync(PRESENT_KEY);
  }
}
