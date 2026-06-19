import * as SecureStore from "expo-secure-store";
import type { KeyStore } from "./types";

const KEY = "hypersolid.wallet.mnemonic";

/**
 * Device keystore: biometric-gated mnemonic storage (Passkey-local, ADR-011).
 * The work key is hardware-protected (Secure Enclave / StrongBox) and requires
 * authentication on read. NOTE: requireAuthentication items do NOT iCloud-sync;
 * the optional iCloud mnemonic backup must be a separate, non-auth item (spec §5.5).
 */
export class SecureStoreKeyStore implements KeyStore {
  async saveMnemonic(mnemonic: string): Promise<void> {
    await SecureStore.setItemAsync(KEY, mnemonic, {
      requireAuthentication: true,
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }
  async loadMnemonic(): Promise<string | null> {
    return SecureStore.getItemAsync(KEY, { requireAuthentication: true });
  }
  async has(): Promise<boolean> {
    return (await SecureStore.getItemAsync(KEY, { requireAuthentication: true })) !== null;
  }
  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(KEY);
  }
}
