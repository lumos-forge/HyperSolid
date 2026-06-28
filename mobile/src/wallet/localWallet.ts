import { english, generateMnemonic, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";
import type { Hex, WalletService } from "./types";

/** Generate a fresh BIP-39 12-word mnemonic (the local wallet's root backup). */
export function generateWalletMnemonic(): string {
  return generateMnemonic(english);
}

/** True if the secret is a raw 32-byte hex private key (`0x` + 64 hex), vs a BIP-39 mnemonic. */
export function isPrivateKey(secret: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(secret.trim());
}

/**
 * A non-custodial wallet whose key never leaves the device (Passkey-local, ADR-011). The secret is
 * either a BIP-39 mnemonic (created in-app) or an imported raw private key — detected by shape.
 */
export class LocalWalletService implements WalletService {
  private account: LocalAccount;

  constructor(secret: string) {
    const s = secret.trim();
    this.account = isPrivateKey(s) ? privateKeyToAccount(s as Hex) : mnemonicToAccount(s);
  }

  getAddress(): Hex {
    return this.account.address;
  }

  /** The underlying viem account — passed to @nktkas/hyperliquid ExchangeClient for EIP-712 signing. */
  getViemAccount(): LocalAccount {
    return this.account;
  }

  signMessage(message: string): Promise<Hex> {
    return this.account.signMessage({ message });
  }

  signTypedData(params: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<Hex> {
    // viem's account.signTypedData accepts the standard EIP-712 payload.
    return this.account.signTypedData(params as never);
  }
}
