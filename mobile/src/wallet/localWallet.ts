import { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";
import type { Hex, WalletService } from "./types";

/** Generate a fresh BIP-39 12-word mnemonic (the local wallet's root backup). */
export function generateWalletMnemonic(): string {
  return generateMnemonic(english);
}

/** A non-custodial wallet whose key never leaves the device (Passkey-local, ADR-011). */
export class LocalWalletService implements WalletService {
  private account: ReturnType<typeof mnemonicToAccount>;

  constructor(mnemonic: string) {
    this.account = mnemonicToAccount(mnemonic);
  }

  getAddress(): Hex {
    return this.account.address;
  }

  /** The underlying viem account — passed to @nktkas/hyperliquid ExchangeClient for EIP-712 signing. */
  getViemAccount(): ReturnType<typeof mnemonicToAccount> {
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
