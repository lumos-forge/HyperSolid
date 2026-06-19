export type Hex = `0x${string}`;

/** Signing capabilities used by the app; backed by Passkey-local / Privy / view-only. */
export interface WalletService {
  getAddress(): Hex;
  signMessage(message: string): Promise<Hex>;
  signTypedData(params: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<Hex>;
}

/** Persistence for the local wallet's mnemonic. Device impl uses expo-secure-store. */
export interface KeyStore {
  saveMnemonic(mnemonic: string): Promise<void>;
  loadMnemonic(): Promise<string | null>;
  has(): Promise<boolean>;
  clear(): Promise<void>;
}
