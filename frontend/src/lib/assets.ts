import { keccak256, toHex, type Hex } from "viem";

/**
 * The assets the UI will let anyone commit against.
 *
 * This list is the only thing standing between a user and an unrevealable call.
 * `commitCall` receives a hash and cannot check that the asset behind it has a
 * feed — that opacity is the mechanism, not a gap in it — so a call committed
 * against an unconfigured asset is accepted, can never be revealed, and forfeits
 * its stake at the end of the window. Every entry here is additionally checked
 * against `PriceOracleResolver.isSupported` before the form will submit.
 *
 * The id is derived, never pasted. A mistyped `bytes32` literal would produce a
 * call that hashes fine, commits fine, and fails only at reveal.
 */

export interface AssetDescriptor {
  /** Feed pair exactly as the resolver was configured with it. */
  readonly symbol: string;
  /** Human name for the picker. */
  readonly label: string;
  /** `keccak256(symbol)` — the `assetId` in every contract signature. */
  readonly id: Hex;
}

function describe(symbol: string, label: string): AssetDescriptor {
  return { symbol, label, id: keccak256(toHex(symbol)) };
}

export const ASSETS: readonly AssetDescriptor[] = [
  describe("BTC/USD", "Bitcoin"),
  describe("ETH/USD", "Ether"),
];

const byId = new Map(ASSETS.map((asset) => [asset.id.toLowerCase(), asset]));

/** The descriptor for an id, or `undefined` for an asset this build does not know. */
export function assetById(id: Hex | undefined): AssetDescriptor | undefined {
  return id ? byId.get(id.toLowerCase()) : undefined;
}

/**
 * A label for an id that may not be in the list.
 *
 * Reveals from a build that offered more assets than this one are still readable
 * on the leaderboard; they just show as a truncated hash rather than a name.
 */
export function assetLabel(id: Hex): string {
  return assetById(id)?.symbol ?? `${id.slice(0, 10)}…`;
}
