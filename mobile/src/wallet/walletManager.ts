import { generateWalletMnemonic, isPrivateKey, secretToPrivateKey, LocalWalletService } from "./localWallet";
import type { KeyStore, WalletService } from "./types";

/**
 * Ties key generation/restore to persistence. Storage is injectable so the
 * onboarding logic is unit-testable with an in-memory store and runs on-device
 * with the biometric-gated SecureStoreKeyStore.
 */
export class WalletManager {
  constructor(private store: KeyStore) {}

  async hasWallet(): Promise<boolean> {
    return this.store.has();
  }

  /** Create a brand-new wallet; returns the mnemonic ONCE for the user to back up. */
  async createWallet(): Promise<{ mnemonic: string; wallet: WalletService }> {
    const mnemonic = generateWalletMnemonic();
    await this.store.saveMnemonic(mnemonic);
    return { mnemonic, wallet: new LocalWalletService(mnemonic) };
  }

  /** Restore from a user-supplied mnemonic (recovery / migrate-in). */
  async restoreWallet(mnemonic: string): Promise<WalletService> {
    const m = mnemonic.trim();
    const wallet = new LocalWalletService(m); // throws if invalid
    await this.store.saveMnemonic(m);
    return wallet;
  }

  /**
   * Import an existing raw private key (`0x` + 64 hex). The key is wrapped in the SAME
   * biometric-gated, device-only secure store as a created mnemonic (only the secret shape differs).
   * Throws on a malformed key.
   */
  async importPrivateKey(privateKey: string): Promise<WalletService> {
    const pk = privateKey.trim();
    if (!isPrivateKey(pk)) throw new Error("Invalid private key: expected 0x + 64 hex characters");
    const wallet = new LocalWalletService(pk);
    await this.store.saveMnemonic(pk);
    return wallet;
  }

  /** Load the persisted wallet (after biometric unlock on device). */
  async loadWallet(): Promise<WalletService | null> {
    const m = await this.store.loadMnemonic();
    return m ? new LocalWalletService(m) : null;
  }

  /**
   * Reveal the persisted mnemonic for backup/export. Reuses the gated store read: on device
   * `SecureStoreKeyStore.loadMnemonic` reads with `requireAuthentication`, so the OS biometric
   * prompt guards every export (and a cancel/fail rejects). Returns null when no wallet exists.
   */
  async exportMnemonic(): Promise<string | null> {
    return this.store.loadMnemonic();
  }

  /**
   * Reveal the raw private key for backup/migration. Mnemonic wallets derive their first-account key;
   * imported keys return as-is. Same biometric-gated store read as {@link exportMnemonic}; returns
   * null when no wallet exists. Note: a mnemonic-derived key only covers account #0.
   */
  async exportPrivateKey(): Promise<string | null> {
    const secret = await this.store.loadMnemonic();
    return secret ? secretToPrivateKey(secret) : null;
  }

  async signOut(): Promise<void> {
    await this.store.clear();
  }
}
