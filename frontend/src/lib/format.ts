import { formatEther, formatUnits, parseEther, parseUnits } from "viem";

/**
 * Every number the contracts speak in, and the strings a human reads.
 *
 * Prices are `int256` at 8 decimals everywhere — in the commitment preimage, in
 * `CallRevealed`, and in what the resolver returns after normalizing whatever
 * the feed's own `decimals()` happens to be. The frontend never invents a
 * different scale; a target parsed at the wrong precision hashes to a
 * commitment the user did not mean and cannot be corrected after the fact.
 */

/** Decimals the protocol normalizes every price to. Fixed by `IPriceResolver`. */
export const PRICE_DECIMALS = 8;

/** Contract enum `Direction`. */
export const Direction = { Above: 0, Below: 1 } as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

/** Contract enum `Status`. */
export const Status = {
  None: 0,
  Committed: 1,
  RevealedWin: 2,
  RevealedLoss: 3,
  Forfeited: 4,
} as const;
export type Status = (typeof Status)[keyof typeof Status];

export const STATUS_LABEL: Record<Status, string> = {
  [Status.None]: "Unknown",
  [Status.Committed]: "Open",
  [Status.RevealedWin]: "Won",
  [Status.RevealedLoss]: "Lost",
  [Status.Forfeited]: "Forfeited",
};

export const DIRECTION_LABEL: Record<Direction, string> = {
  [Direction.Above]: "at or above",
  [Direction.Below]: "at or below",
};

/**
 * A decimal string to a price at 8 decimals.
 *
 * Throws on anything that is not a positive decimal number. The caller turns
 * that into a field error; it must never reach `computeCommitment`.
 */
export function parsePrice(input: string): bigint {
  const trimmed = input.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error("Enter a positive number.");
  const value = parseUnits(trimmed, PRICE_DECIMALS);
  if (value <= 0n) throw new Error("The target must be greater than zero.");
  return value;
}

export function formatPrice(value: bigint): string {
  const asNumber = Number(formatUnits(value, PRICE_DECIMALS));
  return asNumber.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatUsd(value: bigint): string {
  return `$${formatPrice(value)}`;
}

export function parseStake(input: string): bigint {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error("Enter an amount in ETH.");
  return parseEther(trimmed);
}

export function formatStake(wei: bigint): string {
  // `formatEther` gives full precision; four decimals is enough to read a stake
  // and short enough to sit in a table cell.
  const asNumber = Number(formatEther(wei));
  return `${asNumber.toLocaleString(undefined, { maximumFractionDigits: 4 })} ETH`;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

/** Unix seconds, as the contracts count them. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function formatDateTime(unixSeconds: number | bigint): string {
  const date = new Date(Number(unixSeconds) * 1000);
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * A signed duration in seconds as "3d 4h", "12m", "just now".
 *
 * Deliberately coarse. A countdown that ticks the seconds invites the user to
 * submit a reveal in the same second the deadline passes, which loses a race
 * against block time and reverts with `TooEarlyToReveal`.
 */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.abs(Math.floor(totalSeconds));
  if (seconds < 60) return "under a minute";

  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** "in 3d 4h" / "3d 4h ago", relative to now. */
export function formatRelative(unixSeconds: number | bigint): string {
  const delta = Number(unixSeconds) - nowSeconds();
  const magnitude = formatDuration(delta);
  return delta >= 0 ? `in ${magnitude}` : `${magnitude} ago`;
}

/** Seconds as "48 hours" / "30 days", for protocol parameters. */
export function formatWindow(seconds: number | bigint): string {
  const value = Number(seconds);
  if (value % 86_400 === 0) return `${value / 86_400} days`;
  if (value % 3_600 === 0) return `${value / 3_600} hours`;
  return `${Math.round(value / 60)} minutes`;
}

/**
 * A `datetime-local` input value from unix seconds, in the browser's timezone.
 *
 * `toISOString` is UTC and would silently shift the deadline the user picked by
 * their offset — a call committed for "Friday noon" that settles at 9am.
 */
export function toDateTimeLocal(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export function fromDateTimeLocal(value: string): number {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("Pick a valid date and time.");
  return Math.floor(parsed.getTime() / 1000);
}
