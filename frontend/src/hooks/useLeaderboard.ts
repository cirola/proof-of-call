import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { usePublicClient } from "wagmi";
import { CHAIN, RESOLVER_ADDRESS, isDeployed } from "../contracts/addresses";
import { FORFEIT_PENALTY, edgeOf, weightOf } from "../lib/boldness";
import { Status } from "../lib/format";
import { priceAtOrBefore } from "../lib/roundSearch";
import type { CallsIndex, ProtocolCall } from "./useCalls";

/**
 * The leaderboard.
 *
 * Two columns that must not be confused with each other:
 *
 *   - **Counts** — committed, wins, losses, forfeits. Chain data, derived from
 *     `getCall` state, and exactly what `getStats` reports.
 *   - **Score** — the boldness-weighted number. Computed here, from a spot price
 *     this frontend went and fetched. A claim, and labelled as one.
 *
 * The spot price at commit time is the expensive part: nothing records it, so
 * each revealed call needs its own binary search over the feed's history. The
 * results are cached in `localStorage` because a past price never changes, which
 * turns a repeat visit into zero RPC calls.
 */

export interface LeaderboardRow {
  readonly analyst: Address;
  readonly committed: number;
  readonly wins: number;
  readonly losses: number;
  readonly forfeited: number;
  readonly open: number;
  /**
   * Boldness-weighted score.
   *
   * Provisional until `useSpotAtCommit` resolves: calls whose spot price is not
   * in yet contribute nothing and are counted in `unweighted`, so the number
   * only moves in one direction as the prices arrive.
   */
  readonly score: number;
  /** Calls whose spot price could not be found, so they are unweighted. */
  readonly unweighted: number;
  readonly staked: bigint;
}

const SPOT_CACHE_KEY = "proof-of-call.spot-cache.v1";

function loadSpotCache(): Map<string, string> {
  try {
    const raw = localStorage.getItem(SPOT_CACHE_KEY);
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return new Map();
    return new Map(Object.entries(parsed as Record<string, string>));
  } catch {
    return new Map();
  }
}

function saveSpotCache(cache: Map<string, string>): void {
  try {
    localStorage.setItem(SPOT_CACHE_KEY, JSON.stringify(Object.fromEntries(cache)));
  } catch {
    // A full or unavailable store costs a re-fetch next visit, nothing more.
  }
}

/**
 * Spot price at commit time for every revealed call, keyed by call id.
 *
 * Serial rather than parallel on purpose: each entry is itself a binary search
 * of a dozen or so `eth_call`s, and a public endpoint answers a burst of a few
 * hundred with rate-limit errors. The leaderboard renders its counts
 * immediately and fills the score in when this resolves.
 */
export function useSpotAtCommit(index: CallsIndex | undefined) {
  const client = usePublicClient({ chainId: CHAIN.id });

  const needed = (index?.calls ?? []).filter(
    (
      call,
    ): call is ProtocolCall & {
      revealed: NonNullable<ProtocolCall["revealed"]>;
      committedAt: bigint;
    } => call.revealed !== undefined && call.committedAt !== undefined,
  );

  const signature = needed.map((call) => call.id.toString()).join(",");

  return useQuery<Map<string, bigint>>({
    queryKey: ["spot-at-commit", CHAIN.id, RESOLVER_ADDRESS, signature],
    enabled: isDeployed && Boolean(client) && needed.length > 0,
    staleTime: Infinity,
    queryFn: async () => {
      if (!client) throw new Error("No RPC client for this chain.");

      const cache = loadSpotCache();
      const resolved = new Map<string, bigint>();
      let cacheDirty = false;

      for (const call of needed) {
        const cacheKey = `${call.revealed.assetId}:${call.committedAt.toString()}`;
        const cached = cache.get(cacheKey);
        if (cached !== undefined) {
          resolved.set(call.id.toString(), BigInt(cached));
          continue;
        }

        const spot = await priceAtOrBefore(
          client,
          RESOLVER_ADDRESS,
          call.revealed.assetId,
          call.committedAt,
        );
        if (spot !== undefined) {
          resolved.set(call.id.toString(), spot);
          cache.set(cacheKey, spot.toString());
          cacheDirty = true;
        }
      }

      if (cacheDirty) saveSpotCache(cache);
      return resolved;
    },
  });
}

export function buildLeaderboard(
  index: CallsIndex | undefined,
  spots: Map<string, bigint> | undefined,
): LeaderboardRow[] {
  if (!index) return [];

  const rows = new Map<
    string,
    {
      analyst: Address;
      committed: number;
      wins: number;
      losses: number;
      forfeited: number;
      open: number;
      score: number;
      unweighted: number;
      staked: bigint;
    }
  >();

  for (const call of index.calls) {
    const key = call.analyst.toLowerCase();
    const row = rows.get(key) ?? {
      analyst: call.analyst,
      committed: 0,
      wins: 0,
      losses: 0,
      forfeited: 0,
      open: 0,
      score: 0,
      unweighted: 0,
      staked: 0n,
    };

    row.committed += 1;
    row.staked += call.stake;

    switch (call.status) {
      case Status.Committed:
        row.open += 1;
        break;
      case Status.RevealedWin:
      case Status.RevealedLoss: {
        const won = call.status === Status.RevealedWin;
        if (won) row.wins += 1;
        else row.losses += 1;

        const spot = spots?.get(call.id.toString());
        if (spot === undefined || call.revealed === undefined) {
          row.unweighted += 1;
        } else {
          const weight = weightOf(edgeOf(call.revealed.targetPrice, spot));
          row.score += won ? weight : -weight;
        }
        break;
      }
      case Status.Forfeited:
        row.forfeited += 1;
        row.score -= FORFEIT_PENALTY;
        break;
      default:
        break;
    }

    rows.set(key, row);
  }

  return [...rows.values()]
    .map((row) => ({ ...row, score: Number(row.score.toFixed(3)) }))
    .sort((a, b) => b.score - a.score || b.wins - a.wins || a.forfeited - b.forfeited);
}
