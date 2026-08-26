/**
 * The off-chain half of the record.
 *
 * The chain counts wins, losses and forfeits and nothing else. It cannot do
 * more: `commitCall` receives a hash, so it does not know the asset, cannot
 * read a spot price, and has no way to tell "ETH above $1" from a real call —
 * which means a raw win count is gameable by anyone willing to predict that
 * water is wet (ADR-004).
 *
 * So boldness is measured here, from the distance between the target and the
 * spot price **at commit time**, and the result is labelled in the UI as a claim
 * by this frontend rather than as chain data. Both numbers are shown: the counts
 * are trustworthy and the ranking is an opinion, and conflating them would be
 * the dishonest part.
 */

/** A move of this size is worth a full point. */
export const EDGE_REFERENCE = 0.05;

/** Cap on a single call's weight, so one lottery ticket cannot carry a record. */
export const MAX_WEIGHT = 3;

/**
 * What an unrevealed call costs.
 *
 * Flat, because a forfeited call never disclosed its target and there is nothing
 * to weight it by. Set at the reference weight on purpose: staying silent should
 * cost about what an ordinary losing call costs, or silence becomes the cheap
 * way out of a bad prediction — which is the whole thing the protocol exists to
 * prevent.
 */
export const FORFEIT_PENALTY = 1;

/** Fractional distance the price had to travel for the call to be right. */
export function edgeOf(targetPrice: bigint, spotAtCommit: bigint): number {
  if (spotAtCommit <= 0n) return 0;
  const target = Number(targetPrice);
  const spot = Number(spotAtCommit);
  return Math.abs(target - spot) / spot;
}

/** An edge as a score weight: 1.0 at `EDGE_REFERENCE`, capped at `MAX_WEIGHT`. */
export function weightOf(edge: number): number {
  return Math.min(edge / EDGE_REFERENCE, MAX_WEIGHT);
}

export function formatEdge(edge: number): string {
  return `${(edge * 100).toFixed(2)}%`;
}
