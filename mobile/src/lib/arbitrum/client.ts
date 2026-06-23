import { createWalletClient, http } from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";
import type { Account } from "viem";
import type { Network } from "../../state/envStore";
import type { ArbitrumDepositClient } from "../../services/deposit";

/**
 * Isolated viem wiring for in-app Arbitrum deposits (spec §B2b). Imported ONLY by the screen so the
 * native/EVM bits stay out of jest (the service is unit-tested against a fake `ArbitrumDepositClient`).
 * The RPC URL is the user's own provider endpoint, read from config — NEVER hardcoded or committed.
 */

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/** Arbitrum RPC URL from app/env config (the user's provider key). Throws if unset. */
export function arbitrumRpcUrl(network: Network): string {
  const url =
    network === "mainnet"
      ? process.env.EXPO_PUBLIC_ARBITRUM_RPC_MAINNET
      : process.env.EXPO_PUBLIC_ARBITRUM_RPC_TESTNET;
  if (!url) {
    throw new Error("Arbitrum RPC 未配置：请设置 EXPO_PUBLIC_ARBITRUM_RPC_MAINNET / _TESTNET");
  }
  return url;
}

export function createArbitrumDepositClient(network: Network, account: Account): ArbitrumDepositClient {
  const chain = network === "mainnet" ? arbitrum : arbitrumSepolia;
  const wallet = createWalletClient({ account, chain, transport: http(arbitrumRpcUrl(network)) });
  return {
    async transferUsdc({ usdc, bridge, amountBaseUnits }) {
      return wallet.writeContract({
        address: usdc,
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [bridge, amountBaseUnits],
        chain,
        account,
      });
    },
  };
}
