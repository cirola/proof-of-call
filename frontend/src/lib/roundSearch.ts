import type { Address, Hex, PublicClient } from "viem";
import { aggregatorV3Abi } from "../contracts/aggregator";
import { priceOracleResolverAbi } from "../contracts/abis";
import { formatDateTime } from "./format";

/**
 * Finding the round a call settles against.
 *
 * This is the off-chain half of ADR-010, and the reason the contract is not
 * usable from a block explorer alone. `getPriceAt(assetId, deadline, roundId)`
 * settles against the last Chainlink round at or before the deadline, and it
 * *verifies* the round id rather than trusting it — the round must exist,
 * predate the deadline, sit inside the feed's staleness window relative to the
 * deadline, and have no successor that also predates it. Exactly one round
 * satisfies all four. This module finds it.
 *
 * Chainlink publishes no timestamp-to-round index, so the search is a binary
 * search over `getRoundData`, which is sound because `updatedAt` is monotonic
 * within a phase.
 *
 * ### The phase boundary
 *
 * A round id is `(phaseId << 64) | aggregatorRoundId`. Rotating the aggregator
 * behind a proxy bumps the phase and restarts the inner counter, so round ids
 * are monotonic across phases but *not contiguous*. The search below stays
 * inside the current phase: if the deadline predates the current phase's first
 * round, it reports that instead of silently returning the wrong round, and the
 * reveal form exposes a manual round id for that case. Same limitation the
 * contract names in ADR-010, surfaced rather than hidden.
 */

export interface SettlementRound {
  /** Composed `(phaseId << 64) | aggregatorRoundId`, ready for `revealCall`. */
  readonly roundId: bigint;
  /** The feed's own answer, at the feed's own decimals — display only. */
  readonly answer: bigint;
  readonly updatedAt: bigint;
  readonly phaseId: bigint;
  readonly aggregatorRoundId: bigint;
  /** Seconds between the round and the deadline. */
  readonly ageAtDeadline: number;
}

export interface FeedInfo {
  readonly aggregator: Address;
  readonly staleAfter: number;
  readonly decimals: number;
}

const UINT64_MASK = (1n << 64n) - 1n;

function compose(phaseId: bigint, aggregatorRoundId: bigint): bigint {
  return (phaseId << 64n) | aggregatorRoundId;
}

/** Where the resolver points for an asset, and how fresh it demands the data be. */
export async function readFeedInfo(
  client: PublicClient,
  resolver: Address,
  assetId: Hex,
): Promise<FeedInfo> {
  const [aggregator, staleAfter] = await client.readContract({
    address: resolver,
    abi: priceOracleResolverAbi,
    functionName: "getFeedConfig",
    args: [assetId],
  });

  if (aggregator === "0x0000000000000000000000000000000000000000") {
    throw new Error(
      "No price feed is configured for this asset on this deployment, so the call can never be revealed.",
    );
  }

  const decimals = await client.readContract({
    address: aggregator,
    abi: aggregatorV3Abi,
    functionName: "decimals",
  });

  return { aggregator, staleAfter, decimals };
}

interface RoundData {
  answer: bigint;
  updatedAt: bigint;
}

/**
 * One historical round, with a missing round reported as `undefined`.
 *
 * Aggregators disagree about how absence fails — current ones revert with
 * `"No data present"`, older ones return a zeroed tuple. Collapsing both into
 * `undefined` is the same normalization `PriceOracleResolver._readRound` does
 * on-chain, and the search would otherwise treat a revert as a fatal error
 * halfway through a perfectly good binary search.
 */
async function readRound(
  client: PublicClient,
  aggregator: Address,
  roundId: bigint,
): Promise<RoundData | undefined> {
  try {
    const [, answer, , updatedAt] = await client.readContract({
      address: aggregator,
      abi: aggregatorV3Abi,
      functionName: "getRoundData",
      args: [roundId],
    });
    return updatedAt === 0n ? undefined : { answer, updatedAt };
  } catch {
    return undefined;
  }
}

export interface SearchProgress {
  /** Rounds probed so far. Drives the "searching…" line rather than a spinner. */
  probes: number;
}

/**
 * The round `revealCall` will accept for this deadline.
 *
 * Throws with a message meant for a user, not a log, on every case where no such
 * round exists. Those cases are real and permanent — a feed that had no fresh
 * price at the deadline means the call cannot be settled at all — so they are
 * worth naming precisely instead of returning `null`.
 */
export async function findSettlementRound(
  client: PublicClient,
  params: {
    resolver: Address;
    assetId: Hex;
    deadline: bigint;
    onProgress?: (progress: SearchProgress) => void;
  },
): Promise<{ round: SettlementRound; feed: FeedInfo }> {
  const feed = await readFeedInfo(client, params.resolver, params.assetId);
  const { deadline } = params;

  let probes = 0;
  const probe = async (roundId: bigint) => {
    probes += 1;
    params.onProgress?.({ probes });
    return readRound(client, feed.aggregator, roundId);
  };

  const [latestRoundId, , , latestUpdatedAt] = await client.readContract({
    address: feed.aggregator,
    abi: aggregatorV3Abi,
    functionName: "latestRoundData",
  });

  const phaseId = latestRoundId >> 64n;
  const latestInPhase = latestRoundId & UINT64_MASK;

  let found: { roundId: bigint; data: RoundData } | undefined;

  if (latestUpdatedAt <= deadline) {
    // The feed has not published since the deadline, so the latest round is the
    // last one before it by definition and no successor exists to reject it.
    // Probed rather than assumed only to pick up the answer for display.
    const data = await probe(latestRoundId);
    found = { roundId: latestRoundId, data: data ?? { answer: 0n, updatedAt: latestUpdatedAt } };
  } else {
    // Largest `aggregatorRoundId` whose `updatedAt <= deadline`. Rounds are
    // 1-indexed within a phase.
    let low = 1n;
    let high = latestInPhase;

    while (low <= high) {
      const mid = (low + high) / 2n;
      const data = await probe(compose(phaseId, mid));

      if (data && data.updatedAt <= deadline) {
        found = { roundId: compose(phaseId, mid), data };
        low = mid + 1n;
      } else {
        // A missing round is treated the same as one that is too new: search
        // lower. Within a live phase the gaps are at the top, not the bottom.
        if (mid === 0n) break;
        high = mid - 1n;
      }
    }
  }

  if (!found) {
    throw new Error(
      `This feed has no round at or before ${formatDateTime(Number(deadline))} in its current phase. ` +
        "The aggregator behind the feed was rotated after that deadline, which the automatic search " +
        "cannot cross. Enter the round id manually if you can find it.",
    );
  }

  const ageAtDeadline = Number(deadline - found.data.updatedAt);
  if (ageAtDeadline > feed.staleAfter) {
    throw new Error(
      `The closest round before the deadline is ${ageAtDeadline} seconds old, past this feed's ` +
        `${feed.staleAfter}-second staleness threshold. The feed had no fresh price at the deadline, ` +
        "so the contract will refuse to settle this call.",
    );
  }

  return {
    round: {
      roundId: found.roundId,
      answer: found.data.answer,
      updatedAt: found.data.updatedAt,
      phaseId,
      aggregatorRoundId: found.roundId & UINT64_MASK,
      ageAtDeadline,
    },
    feed,
  };
}

/**
 * The feed's answer at a past moment, normalized to 8 decimals.
 *
 * Used by the leaderboard, not by settlement: the boldness weight needs the spot
 * price at commit time, which nothing on-chain records because the asset is
 * still hidden at that point (ADR-004). Failure is not an error here — a missing
 * round means one call goes unweighted, not that the page breaks — so this
 * returns `undefined` rather than throwing.
 */
export async function priceAtOrBefore(
  client: PublicClient,
  resolver: Address,
  assetId: Hex,
  timestamp: bigint,
): Promise<bigint | undefined> {
  try {
    const { round, feed } = await findSettlementRound(client, {
      resolver,
      assetId,
      deadline: timestamp,
    });
    return normalizeAnswer(round.answer, feed.decimals);
  } catch {
    return undefined;
  }
}

/** Rescale a feed answer to the protocol's 8 decimals, the way the resolver does. */
export function normalizeAnswer(answer: bigint, feedDecimals: number): bigint {
  if (feedDecimals === 8) return answer;
  if (feedDecimals < 8) return answer * 10n ** BigInt(8 - feedDecimals);
  return answer / 10n ** BigInt(feedDecimals - 8);
}
