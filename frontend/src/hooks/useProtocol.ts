import { useReadContracts } from "wagmi";
import { callRegistryAbi, priceOracleResolverAbi } from "../contracts/abis";
import { CHAIN, REGISTRY_ADDRESS, RESOLVER_ADDRESS, isDeployed } from "../contracts/addresses";
import { ASSETS } from "../lib/assets";

/**
 * The protocol parameters, read from the chain rather than duplicated here.
 *
 * Every one of these is admin-settable. A frontend that hard-coded the ADR-009
 * starting values would keep validating against them after they changed, and the
 * user would see a form that accepts a deadline the contract then rejects.
 */
export interface ProtocolParams {
  minStake: bigint;
  minHorizon: bigint;
  maxHorizon: bigint;
  revealWindow: number;
  paused: boolean;
  callCount: bigint;
  treasury: `0x${string}`;
  resolver: `0x${string}`;
}

export function useProtocolParams() {
  const registry = { address: REGISTRY_ADDRESS, abi: callRegistryAbi, chainId: CHAIN.id } as const;

  const query = useReadContracts({
    contracts: [
      { ...registry, functionName: "minStake" },
      { ...registry, functionName: "minHorizon" },
      { ...registry, functionName: "maxHorizon" },
      { ...registry, functionName: "revealWindow" },
      { ...registry, functionName: "paused" },
      { ...registry, functionName: "callCount" },
      { ...registry, functionName: "treasury" },
      { ...registry, functionName: "resolver" },
    ],
    query: { enabled: isDeployed, refetchInterval: 30_000 },
  });

  const results = query.data;
  const params: ProtocolParams | undefined =
    results && results.every((entry) => entry.status === "success")
      ? {
          minStake: results[0].result as bigint,
          minHorizon: results[1].result as bigint,
          maxHorizon: results[2].result as bigint,
          revealWindow: Number(results[3].result),
          paused: results[4].result as boolean,
          callCount: results[5].result as bigint,
          treasury: results[6].result as `0x${string}`,
          resolver: results[7].result as `0x${string}`,
        }
      : undefined;

  return { params, isLoading: query.isLoading, error: query.error, refetch: query.refetch };
}

/**
 * Which of the assets this build offers actually have a feed on this deployment.
 *
 * The commit form will not submit an asset that is not in this set. It is the
 * only guard there is: `commitCall` takes a hash and cannot tell that the asset
 * behind it has no feed, so the call would commit, never be revealable, and
 * forfeit its stake — with no error anywhere along the way.
 */
export function useSupportedAssets() {
  const query = useReadContracts({
    contracts: ASSETS.map((asset) => ({
      address: RESOLVER_ADDRESS,
      abi: priceOracleResolverAbi,
      chainId: CHAIN.id,
      functionName: "isSupported" as const,
      args: [asset.id] as const,
    })),
    query: { enabled: isDeployed, staleTime: 5 * 60_000 },
  });

  const supported = new Set<string>();
  query.data?.forEach((entry, index) => {
    const asset = ASSETS[index];
    if (asset && entry.status === "success" && entry.result === true) supported.add(asset.id);
  });

  return { supported, isLoading: query.isLoading };
}
