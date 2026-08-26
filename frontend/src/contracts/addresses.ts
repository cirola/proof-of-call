import { isAddress, zeroAddress, type Address } from "viem";
import { sepolia } from "wagmi/chains";

/**
 * Where the protocol lives, and whether it lives anywhere at all.
 *
 * Addresses come from the environment rather than from a committed constant so
 * that a redeploy is a Vercel setting, not a code change. The trade-off is that
 * a missing variable is a runtime problem instead of a compile-time one, which
 * is why `isDeployed` exists and why every page checks it before rendering a
 * form that would build an unsendable transaction.
 */

const registryEnv = import.meta.env.VITE_REGISTRY_ADDRESS;
const resolverEnv = import.meta.env.VITE_RESOLVER_ADDRESS;

function readAddress(value: string | undefined, name: string): Address {
  if (!value) return zeroAddress;
  if (!isAddress(value)) {
    // Loud, and at startup. A malformed address that reached a contract call
    // would surface as an unrelated ABI decode error deep in a transaction.
    console.error(`${name} is not a valid address: ${value}`);
    return zeroAddress;
  }
  return value;
}

export const REGISTRY_ADDRESS = readAddress(registryEnv, "VITE_REGISTRY_ADDRESS");
export const RESOLVER_ADDRESS = readAddress(resolverEnv, "VITE_RESOLVER_ADDRESS");

/** False until both addresses are configured. Every write path is gated on it. */
export const isDeployed = REGISTRY_ADDRESS !== zeroAddress && RESOLVER_ADDRESS !== zeroAddress;

/** The only chain the protocol is deployed on. */
export const CHAIN = sepolia;

/**
 * Block the registry was deployed in.
 *
 * Log queries start here instead of at block 0. Public Sepolia endpoints cap
 * `eth_getLogs` at a few thousand blocks per request, so the difference between
 * a correct start block and zero is roughly two thousand requests.
 */
export const DEPLOY_BLOCK = BigInt(import.meta.env.VITE_DEPLOY_BLOCK ?? "0");

export const EXPLORER_URL = CHAIN.blockExplorers?.default.url ?? "https://sepolia.etherscan.io";

export function explorerTx(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`;
}

export function explorerAddress(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}
