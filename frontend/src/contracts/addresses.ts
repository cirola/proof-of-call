import { isAddress, zeroAddress, type Address, type Chain } from "viem";
import { hardhat, sepolia } from "wagmi/chains";

/**
 * Where the protocol lives, on which chain, and whether it lives anywhere at all.
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

/**
 * The chains this client knows how to talk to, by id.
 *
 * Two, and deliberately not more: Sepolia is where the protocol is deployed, and
 * the local Hardhat node is the demo — `npm run demo` deploys the protocol
 * against mock Chainlink aggregators so the whole commit/reveal loop can be
 * walked in minutes instead of hours, with no faucet and no keys.
 *
 * The build targets exactly one of them. A multi-chain client would have to
 * carry a per-chain address book and a chain switcher in every write path, and
 * the protocol is not deployed in more than one place at a time.
 */
const CHAINS = {
  [sepolia.id]: sepolia,
  [hardhat.id]: hardhat,
} as const;

const DEFAULT_CHAIN_ID = sepolia.id;

function readChainId(): keyof typeof CHAINS {
  const raw = import.meta.env.VITE_CHAIN_ID?.trim();
  if (!raw) return DEFAULT_CHAIN_ID;

  const id = Number(raw);
  if (id in CHAINS) return id as keyof typeof CHAINS;

  console.error(
    `VITE_CHAIN_ID is ${raw}, which this build does not know. ` +
      `Supported: ${Object.keys(CHAINS).join(", ")}. Falling back to ${DEFAULT_CHAIN_ID}.`,
  );
  return DEFAULT_CHAIN_ID;
}

/**
 * The only chain this build talks to.
 *
 * Widened to `Chain` deliberately. Left as the union of the two entries, every
 * downstream type that keys off a chain id — wagmi's `transports` record above
 * all — would demand an entry for both chains, and this build only configures
 * the one it is pointed at.
 */
export const CHAIN: Chain = CHAINS[readChainId()];

/** True when this build is pointed at the local demo node rather than a testnet. */
export const isLocalChain = CHAIN.id === hardhat.id;

/**
 * RPC endpoint override.
 *
 * `VITE_RPC_URL` is the current name; `VITE_SEPOLIA_RPC_URL` is still read so an
 * existing deployment's environment keeps working. Empty means "use the chain's
 * own default", which for Sepolia is a rate-limited public endpoint and for the
 * local node is `http://127.0.0.1:8545`.
 */
export const RPC_URL =
  import.meta.env.VITE_RPC_URL?.trim() || import.meta.env.VITE_SEPOLIA_RPC_URL?.trim() || undefined;

/**
 * Block the registry was deployed in.
 *
 * Log queries start here instead of at block 0. Public Sepolia endpoints cap
 * `eth_getLogs` at a few thousand blocks per request, so the difference between
 * a correct start block and zero is roughly two thousand requests.
 */
export const DEPLOY_BLOCK = BigInt(import.meta.env.VITE_DEPLOY_BLOCK ?? "0");

/**
 * The chain's block explorer, or `undefined` when it has none.
 *
 * A local node has no explorer, and linking to Etherscan for an address that
 * only exists on someone's laptop is worse than not linking at all — it looks
 * like a working link and lands on a "not found" page. `ExplorerLink` renders
 * plain text instead when this is undefined.
 */
export const EXPLORER_URL: string | undefined = CHAIN.blockExplorers?.default.url;

export function explorerTx(hash: string): string | undefined {
  return EXPLORER_URL ? `${EXPLORER_URL}/tx/${hash}` : undefined;
}

export function explorerAddress(address: string): string | undefined {
  return EXPLORER_URL ? `${EXPLORER_URL}/address/${address}` : undefined;
}
