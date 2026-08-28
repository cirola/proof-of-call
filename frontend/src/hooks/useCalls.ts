import { useQuery } from "@tanstack/react-query";
import { getAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { usePublicClient } from "wagmi";
import { callRegistryAbi } from "../contracts/abis";
import { CHAIN, DEPLOY_BLOCK, REGISTRY_ADDRESS, isDeployed } from "../contracts/addresses";
import { getLogsInChunks } from "../lib/logs";
import { Direction, Status } from "../lib/format";

/**
 * Every call in the registry, assembled from state and from events.
 *
 * The split matters. Chain **state** — who committed, how much, what status —
 * comes from `getCall`, which is authoritative and cannot be missed. The
 * plaintext of a revealed call and the commit timestamp exist only in **events**,
 * because neither is stored: `committedAt` was deliberately kept out of the
 * struct (ADR-006), and the revealed parameters are in `CallRevealed` rather
 * than in storage because nothing on-chain reads them back.
 *
 * So state is fetched by multicall and is always complete, and the event half is
 * best-effort: an RPC that refuses the log range costs the leaderboard its
 * weighting, not the app its correctness. `logsAvailable` says which happened.
 */

export interface RevealedDetail {
  readonly assetId: Hex;
  readonly direction: Direction;
  readonly targetPrice: bigint;
  readonly settlementPrice: bigint;
  readonly won: boolean;
}

export interface ProtocolCall {
  readonly id: bigint;
  readonly analyst: Address;
  readonly deadline: bigint;
  readonly revealWindow: number;
  readonly status: Status;
  readonly commitment: Hex;
  readonly stake: bigint;
  /** Last second a reveal is legal. `deadline + revealWindow`. */
  readonly revealDeadline: bigint;
  readonly committedAt?: bigint;
  readonly revealed?: RevealedDetail;
}

/**
 * Reads `getCall` for every id, batching when the chain can.
 *
 * `multicall` needs Multicall3 deployed at its canonical address, which every
 * public network has and a freshly started local node does not. Falling back to
 * one request per call is slower and correct; throwing would make the whole
 * registry unreadable on the demo node.
 */
async function readCallStates(client: PublicClient, ids: readonly bigint[]) {
  const contracts = ids.map((id) => ({
    address: REGISTRY_ADDRESS,
    abi: callRegistryAbi,
    functionName: "getCall" as const,
    args: [id] as const,
  }));

  if (client.chain?.contracts?.multicall3) {
    return client.multicall({ contracts, allowFailure: false });
  }

  return Promise.all(contracts.map((contract) => client.readContract(contract)));
}

const committedEvent = getAbiItem({ abi: callRegistryAbi, name: "CallCommitted" });
const revealedEvent = getAbiItem({ abi: callRegistryAbi, name: "CallRevealed" });

export interface CallsIndex {
  readonly calls: readonly ProtocolCall[];
  /** False when the log queries failed; the reveal details are then missing. */
  readonly logsAvailable: boolean;
}

export function useCalls() {
  const client = usePublicClient({ chainId: CHAIN.id });

  return useQuery<CallsIndex>({
    queryKey: ["calls", CHAIN.id, REGISTRY_ADDRESS],
    enabled: isDeployed && Boolean(client),
    refetchInterval: 20_000,
    queryFn: async () => {
      if (!client) throw new Error("No RPC client for this chain.");

      const callCount = await client.readContract({
        address: REGISTRY_ADDRESS,
        abi: callRegistryAbi,
        functionName: "callCount",
      });

      const ids = Array.from({ length: Number(callCount) }, (_, index) => BigInt(index));

      const states = ids.length === 0 ? [] : await readCallStates(client, ids);

      // Best-effort half. A failure here degrades the leaderboard, so it is
      // caught rather than allowed to fail the whole query.
      let committedAt = new Map<string, bigint>();
      let revealed = new Map<string, RevealedDetail>();
      let logsAvailable = true;

      try {
        const toBlock = await client.getBlockNumber();
        const [commits, reveals] = await Promise.all([
          getLogsInChunks(client, {
            address: REGISTRY_ADDRESS,
            event: committedEvent,
            fromBlock: DEPLOY_BLOCK,
            toBlock,
          }),
          getLogsInChunks(client, {
            address: REGISTRY_ADDRESS,
            event: revealedEvent,
            fromBlock: DEPLOY_BLOCK,
            toBlock,
          }),
        ]);

        committedAt = new Map(
          commits.map((log) => [log.args.callId.toString(), log.args.committedAt]),
        );
        revealed = new Map(
          reveals.map((log) => [
            log.args.callId.toString(),
            {
              assetId: log.args.assetId,
              direction: log.args.direction as Direction,
              targetPrice: log.args.targetPrice,
              settlementPrice: log.args.settlementPrice,
              won: log.args.won,
            },
          ]),
        );
      } catch (error) {
        console.warn("Log queries failed; reveal details are unavailable.", error);
        logsAvailable = false;
      }

      const calls: ProtocolCall[] = states.map((state, index) => {
        const id = BigInt(index);
        const key = id.toString();
        const detail = revealed.get(key);
        const at = committedAt.get(key);
        return {
          id,
          analyst: state.analyst,
          deadline: state.deadline,
          revealWindow: Number(state.revealWindow),
          status: state.status as Status,
          commitment: state.commitment,
          stake: state.stake,
          revealDeadline: state.deadline + BigInt(state.revealWindow),
          ...(at === undefined ? {} : { committedAt: at }),
          ...(detail === undefined ? {} : { revealed: detail }),
        };
      });

      return { calls, logsAvailable };
    },
  });
}

/** The subset belonging to one analyst, newest first. */
export function callsOf(
  index: CallsIndex | undefined,
  analyst: Address | undefined,
): ProtocolCall[] {
  if (!index || !analyst) return [];
  const target = analyst.toLowerCase();
  return index.calls
    .filter((call) => call.analyst.toLowerCase() === target)
    .sort((a, b) => Number(b.id - a.id));
}

/** Open calls whose reveal window has closed — forfeitable by anyone. */
export function forfeitableCalls(
  index: CallsIndex | undefined,
  nowSeconds: number,
): ProtocolCall[] {
  if (!index) return [];
  return index.calls.filter(
    (call) => call.status === Status.Committed && call.revealDeadline < BigInt(nowSeconds),
  );
}
