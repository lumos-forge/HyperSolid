import type { Network } from "../../state/envStore";

export interface BridgeConstants {
  chainId: number;
  /** Native USDC token (Circle) — NOT USDC.e. */
  usdc: `0x${string}`;
  /** Hyperliquid Bridge2 contract. Deposits = transfer native USDC here; credited to the sender. */
  bridge: `0x${string}`;
}

/**
 * Hyperliquid bridge + native-USDC addresses per network.
 * VERIFIED against the official Bridge2 docs (hyperliquid.gitbook.io/.../api/bridge2) + Arbiscan,
 * and confirmed by the user on 2026-06-23. Re-verify before any address change.
 */
const CONSTANTS: Record<Network, BridgeConstants> = {
  mainnet: {
    chainId: 42161, // Arbitrum One
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    bridge: "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7",
  },
  testnet: {
    chainId: 421614, // Arbitrum Sepolia
    usdc: "0x1baAbB04529D43a73232B713C0FE471f7c7334d5",
    bridge: "0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89",
  },
};

export function bridgeConstants(network: Network): BridgeConstants {
  return CONSTANTS[network];
}

/** USDC has 6 decimals. Convert a USDC amount to base units. */
export function usdcToBaseUnits(amount: number): bigint {
  return BigInt(Math.round(amount * 1e6));
}
