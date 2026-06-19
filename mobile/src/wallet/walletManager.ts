import { generateWalletMnemonic, LocalWalletService } from "./localWallet";
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

  /** Load the persisted wallet (after biometric unlock on device). */
  async loadWallet(): Promise<WalletService | null> {
    const m = await this.store.loadMnemonic();
    return m ? new LocalWalletService(m) : null;
  }

  async signOut(): Promise<void> {
    await this.store.clear();
  }
}
