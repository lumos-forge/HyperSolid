import type { KeyStore } from "./types";

/** In-memory keystore for tests and ephemeral previews (no persistence). */
export class InMemoryKeyStore implements KeyStore {
  private mnemonic: string | null = null;

  async saveMnemonic(mnemonic: string): Promise<void> {
    this.mnemonic = mnemonic;
  }
  async loadMnemonic(): Promise<string | null> {
    return this.mnemonic;
  }
  async has(): Promise<boolean> {
    return this.mnemonic !== null;
  }
  async clear(): Promise<void> {
    this.mnemonic = null;
  }
}
