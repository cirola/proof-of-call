import { toHex, type Address, type Hex } from "viem";
import { Direction } from "./format";

/**
 * The salt vault.
 *
 * This is the least glamorous file in the project and the one most likely to
 * cost somebody money. A commitment is `keccak256(assetId, direction,
 * targetPrice, deadline, salt, analyst)`. Five of those six fields are either
 * public or recoverable; the salt is 256 bits that exist nowhere but here. Lose
 * it and the call cannot be opened, the window closes, and the stake is
 * forfeited to the treasury. Nothing recovers it — not the analyst, not an
 * admin, not the chain.
 *
 * So the vault does three things and says so out loud in the UI:
 *
 *   1. Persists every commit to `localStorage` the moment it is signed.
 *   2. Offers the whole vault as a downloadable JSON file.
 *   3. Takes that file back on another machine.
 *
 * `localStorage` is per-origin and per-browser. A cleared profile, a different
 * machine, or a private window is a total loss, which is why the download is
 * offered at commit time rather than buried in a settings page.
 */

const STORAGE_KEY = "proof-of-call.secrets.v1";

/** Everything needed to rebuild a commitment preimage, plus what the UI shows. */
export interface CallSecret {
  readonly version: 1;
  readonly chainId: number;
  /** Registry the call was committed to. Scoping by it survives a redeploy. */
  readonly registry: Address;
  readonly analyst: Address;
  readonly commitment: Hex;
  readonly assetId: Hex;
  readonly direction: Direction;
  /**
   * Target price as the raw 8-decimal integer, in a string.
   *
   * A string and not a number: `JSON.stringify` cannot represent a `bigint`, and
   * a `number` silently loses precision above 2^53 — which a BTC target at eight
   * decimals passes comfortably.
   */
  readonly targetPrice: string;
  readonly deadline: number;
  readonly salt: Hex;
  /** Assigned by the chain; written back once the commit receipt is mined. */
  readonly callId?: string;
  readonly committedAt?: number;
  readonly txHash?: Hex;
}

/**
 * 256 bits from the platform CSPRNG.
 *
 * Never `Math.random`: it is seeded from a small state, is not required to be
 * unpredictable, and V8's implementation is recoverable from a handful of its
 * own outputs. A guessable salt makes the commitment decorative — an attacker
 * enumerates the small space of plausible predictions and confirms one.
 */
export function generateSalt(): Hex {
  if (!globalThis.crypto?.getRandomValues) {
    // Refusing is the only safe answer. A fallback here would be a weak salt
    // that looks exactly like a strong one.
    throw new Error(
      "This browser does not expose a cryptographic random source. " +
        "Committing would produce a guessable salt, so it is blocked.",
    );
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

function readAll(): CallSecret[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isCallSecret) : [];
  } catch {
    // A corrupt or unavailable store must not take the page down with it. The
    // UI already treats an empty vault as "your salts are somewhere else".
    return [];
  }
}

function writeAll(secrets: readonly CallSecret[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(secrets));
  } catch (error) {
    console.error("Could not persist the salt vault", error);
    throw new Error(
      "The salt could not be saved to this browser. Download the backup before continuing — " +
        "without the salt the stake cannot be recovered.",
    );
  }
}

function isCallSecret(value: unknown): value is CallSecret {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.chainId === "number" &&
    typeof candidate.registry === "string" &&
    typeof candidate.analyst === "string" &&
    typeof candidate.commitment === "string" &&
    typeof candidate.assetId === "string" &&
    (candidate.direction === Direction.Above || candidate.direction === Direction.Below) &&
    typeof candidate.targetPrice === "string" &&
    typeof candidate.deadline === "number" &&
    typeof candidate.salt === "string"
  );
}

/** Vault entries for one analyst on one registry, newest deadline first. */
export function listSecrets(chainId: number, registry: Address, analyst: Address): CallSecret[] {
  const target = { registry: registry.toLowerCase(), analyst: analyst.toLowerCase() };
  return readAll()
    .filter(
      (secret) =>
        secret.chainId === chainId &&
        secret.registry.toLowerCase() === target.registry &&
        secret.analyst.toLowerCase() === target.analyst,
    )
    .sort((a, b) => b.deadline - a.deadline);
}

/** Every entry, for the export file and the vault counter in the header. */
export function listAllSecrets(): CallSecret[] {
  return readAll();
}

export function saveSecret(secret: CallSecret): void {
  const existing = readAll().filter((entry) => !sameCommitment(entry, secret));
  writeAll([...existing, secret]);
}

/**
 * Attach the chain-assigned id to a secret once the commit receipt is mined.
 *
 * The commitment is the key, not the id: the id does not exist until the
 * transaction is in a block, and the salt has to be stored before the
 * transaction is signed.
 */
export function attachCallId(
  commitment: Hex,
  registry: Address,
  patch: { callId: string; committedAt?: number; txHash?: Hex },
): void {
  const all = readAll();
  const next = all.map((entry) =>
    entry.commitment.toLowerCase() === commitment.toLowerCase() &&
    entry.registry.toLowerCase() === registry.toLowerCase()
      ? { ...entry, ...patch }
      : entry,
  );
  writeAll(next);
}

export function findSecretByCallId(
  chainId: number,
  registry: Address,
  callId: bigint,
): CallSecret | undefined {
  return readAll().find(
    (entry) =>
      entry.chainId === chainId &&
      entry.registry.toLowerCase() === registry.toLowerCase() &&
      entry.callId === callId.toString(),
  );
}

export function removeSecret(commitment: Hex, registry: Address): void {
  writeAll(
    readAll().filter(
      (entry) =>
        !(
          entry.commitment.toLowerCase() === commitment.toLowerCase() &&
          entry.registry.toLowerCase() === registry.toLowerCase()
        ),
    ),
  );
}

function sameCommitment(a: CallSecret, b: CallSecret): boolean {
  return (
    a.commitment.toLowerCase() === b.commitment.toLowerCase() &&
    a.registry.toLowerCase() === b.registry.toLowerCase()
  );
}

/** The vault as a file the user can put somewhere that is not a browser. */
export function downloadSecrets(secrets: readonly CallSecret[], filename: string): void {
  const blob = new Blob([JSON.stringify(secrets, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Merge a backup file into the vault.
 *
 * A merge and not a replace: importing on a machine that already has live calls
 * must not delete them. Entries are keyed by commitment, and an imported entry
 * wins only where it carries an id the local copy is missing.
 */
export function importSecrets(fileContents: string): { added: number; skipped: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileContents);
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  if (!Array.isArray(parsed)) throw new Error("That file is not a Proof of Call backup.");

  const incoming = parsed.filter(isCallSecret);
  if (incoming.length === 0) throw new Error("No usable entries in that file.");

  const existing = readAll();
  const merged = [...existing];
  let added = 0;

  for (const entry of incoming) {
    const index = merged.findIndex((candidate) => sameCommitment(candidate, entry));
    if (index === -1) {
      merged.push(entry);
      added += 1;
    } else {
      const current = merged[index];
      if (current && current.callId === undefined && entry.callId !== undefined) {
        merged[index] = {
          ...current,
          callId: entry.callId,
          ...(entry.committedAt === undefined ? {} : { committedAt: entry.committedAt }),
        };
      }
    }
  }

  writeAll(merged);
  return { added, skipped: incoming.length - added };
}
