declare module "@nktkas/hyperliquid/signing" {
  export function createL1ActionHash(args: {
    action: unknown;
    nonce: number;
    vaultAddress?: string;
    expiresAfter?: number;
  }): string;
  
  export function signL1Action(args: unknown): Promise<unknown>;
  export function signUserSignedAction(args: unknown): Promise<unknown>;
}
