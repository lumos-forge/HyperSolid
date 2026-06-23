import { createWalletClient, createPublicClient, http, formatUnits } from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";
import type { Account } from "viem";
import type { Network } from "../../state/envStore";
import type { ArbitrumDepositClient } from "../../services/deposit";
import { bridgeConstants } from "./bridge";

/**
 * Isolated viem wiring for in-app Arbitrum deposits (spec §B2b). Imported ONLY by the screen so the
 * native/EVM bits stay out of jest (the service is unit-tested against a fake `ArbitrumDepositClient`).
 * The RPC URL is **delivered by the server at runtime** (see `runtimeConfigStore`) and passed in here
 * — it is NEVER hardcoded or embedded via EXPO_PUBLIC_* build env.
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

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

function chainFor(network: Network) {
  return network === "mainnet" ? arbitrum : arbitrumSepolia;
}

/**
 * Read the wallet's on-chain Arbitrum balances for the deposit precheck (spec §B2b): native USDC
 * (6 decimals) it can deposit, and ETH (18 decimals) it needs for gas. Read-only; uses the
 * server-delivered RPC. Isolated (viem) — the screen mocks this in tests.
 */
export async function fetchArbitrumBalances(
  network: Network,
  address: `0x${string}`,
  rpcUrl: string,
): Promise<{ usdc: number; eth: number }> {
  const chain = chainFor(network);
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  const { usdc } = bridgeConstants(network);
  const [usdcRaw, ethRaw] = await Promise.all([
    pub.readContract({ address: usdc, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [address] }),
    pub.getBalance({ address }),
  ]);
  return {
    usdc: Number(formatUnits(usdcRaw as bigint, 6)),
    eth: Number(formatUnits(ethRaw, 18)),
  };
}

export function createArbitrumDepositClient(
  network: Network,
  account: Account,
  rpcUrl: string,
): ArbitrumDepositClient {
  const chain = chainFor(network);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
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
