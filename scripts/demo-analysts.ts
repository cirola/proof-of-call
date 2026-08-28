import { formatEther, parseEther, toHex, type Address, type Hex } from "viem";

/**
 * Simulated analysts, so the demo has a registry worth looking at.
 *
 * An empty Calls page and an empty leaderboard are indistinguishable from a
 * broken build. These accounts commit real calls through the real contract,
 * reveal them when their deadline passes, and — on purpose — sometimes do not,
 * so the forfeit path any visitor can execute is visible within a few minutes of
 * starting the demo.
 *
 * Nothing here is privileged. They are Hardhat test accounts using the same two
 * public functions the frontend uses; the only thing they know that a browser
 * does not is which round ids the keeper published, which saves re-deriving the
 * settlement round by binary search over an aggregator this same process is
 * writing. The frontend's own reveal path does that search for real.
 */

/** A round this process published, kept so a reveal can pick the right one. */
export interface PublishedRound {
  readonly roundId: bigint;
  readonly updatedAt: bigint;
  readonly answer: bigint;
}

export interface FeedHandle {
  readonly symbol: string;
  readonly assetId: Hex;
  /** Every round published for this feed, in order. */
  readonly rounds: PublishedRound[];
  /** Latest published answer, at feed decimals. */
  price(): bigint;
}

/** Minimal shape of the viem contract instance the deploy script already holds. */
interface RegistryLike {
  address: Address;
  read: {
    computeCommitment: (args: readonly [Hex, number, bigint, bigint, Hex, Address]) => Promise<Hex>;
  };
  write: {
    commitCall: (
      args: readonly [Hex, bigint],
      options: { account: Address; value: bigint },
    ) => Promise<Hex>;
    revealCall: (
      args: readonly [
        bigint,
        { assetId: Hex; direction: number; targetPrice: bigint; salt: Hex; roundId: bigint },
      ],
      options: { account: Address },
    ) => Promise<Hex>;
  };
}

const DIRECTION_ABOVE = 0;
const DIRECTION_BELOW = 1;

/** Seconds from a bot's commit to its deadline. Just over the demo minimum. */
const HORIZON_SECONDS = 150;

/** How often a bot considers making a call. */
const DECISION_INTERVAL_MS = 20_000;

/** Chance a bot commits when it considers it. Keeps the registry from flooding. */
const COMMIT_PROBABILITY = 0.45;

/**
 * Chance a bot walks away from a call it could have revealed.
 *
 * The forfeit path is the protocol's answer to selective reveal, and it is the
 * one thing a visitor cannot see unless somebody declines to open a call.
 */
const ABANDON_PROBABILITY = 0.2;

/** How far from spot a target is placed, in basis points. */
const MAX_TARGET_OFFSET_BPS = 40n;

interface PendingCall {
  callId: bigint;
  analyst: Address;
  assetId: Hex;
  direction: number;
  targetPrice: bigint;
  deadline: bigint;
  salt: Hex;
  abandon: boolean;
}

function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

/**
 * The last round at or before `deadline` — the one `getPriceAt` will accept.
 *
 * Same rule the contract enforces and the frontend searches for, decided here by
 * reading the history this process wrote rather than by probing the aggregator.
 */
function settlementRound(feed: FeedHandle, deadline: bigint): PublishedRound | undefined {
  let found: PublishedRound | undefined;
  for (const round of feed.rounds) {
    if (round.updatedAt <= deadline) found = round;
    else break;
  }
  return found;
}

export interface AnalystsOptions {
  registry: RegistryLike;
  feeds: readonly FeedHandle[];
  /** Accounts that will make calls. The deployer is deliberately not among them. */
  analysts: readonly Address[];
  /** Current chain time, in seconds. */
  now: () => Promise<bigint>;
  /** The `callId` a `commitCall` transaction produced, from its receipt. */
  callIdFromTx: (hash: Hex) => Promise<bigint | undefined>;
  log: (line: string) => void;
}

/**
 * Starts the simulation and returns a function that stops it.
 */
export function startAnalysts(options: AnalystsOptions): () => void {
  const { registry, feeds, analysts, now, callIdFromTx, log } = options;
  const pending: PendingCall[] = [];
  let stopped = false;

  const commit = async (analyst: Address): Promise<void> => {
    const feed = pick(feeds);
    const spot = feed.price();
    if (spot === 0n) return;

    const direction = Math.random() < 0.5 ? DIRECTION_ABOVE : DIRECTION_BELOW;

    // Targets sit on the side of spot that makes the call a real question: an
    // `Above` call aims above the current price, a `Below` call below it.
    const offsetBps = BigInt(1 + Math.floor(Math.random() * Number(MAX_TARGET_OFFSET_BPS)));
    const offset = (spot * offsetBps) / 10_000n;
    const targetPrice = direction === DIRECTION_ABOVE ? spot + offset : spot - offset;

    const deadline = (await now()) + BigInt(HORIZON_SECONDS);
    const salt = randomSalt();
    const stake = parseEther((0.001 + Math.random() * 0.02).toFixed(6));

    const commitment = await registry.read.computeCommitment([
      feed.assetId,
      direction,
      targetPrice,
      deadline,
      salt,
      analyst,
    ]);

    const hash = await registry.write.commitCall([commitment, deadline], {
      account: analyst,
      value: stake,
    });

    // The call id is assigned by the contract, so it is read back out of this
    // transaction's own receipt. Scanning the block instead would race the price
    // keeper, which is mining a block every few seconds in the same process.
    const callId = await callIdFromTx(hash);
    if (callId === undefined) {
      log(`  commit from ${analyst.slice(0, 8)}… landed but emitted no CallCommitted`);
      return;
    }

    const abandon = Math.random() < ABANDON_PROBABILITY;
    pending.push({
      callId,
      analyst,
      assetId: feed.assetId,
      direction,
      targetPrice,
      deadline,
      salt,
      abandon,
    });

    log(
      `  call #${callId} committed by ${analyst.slice(0, 8)}… ` +
        `${feed.symbol} ${direction === DIRECTION_ABOVE ? "above" : "below"} ` +
        `${(Number(targetPrice) / 1e8).toFixed(2)} for ${formatEther(stake)} ETH` +
        (abandon ? " (will be abandoned)" : ""),
    );
  };

  const revealDue = async (): Promise<void> => {
    const chainNow = await now();

    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const call = pending[index]!;
      if (chainNow < call.deadline) continue;

      // Abandoned calls are dropped from tracking, not revealed. They stay open
      // until their window closes, at which point anyone — including whoever is
      // reading this demo — can forfeit them from the Calls page.
      if (call.abandon) {
        pending.splice(index, 1);
        log(`  call #${call.callId} left unopened by ${call.analyst.slice(0, 8)}…`);
        continue;
      }

      const feed = feeds.find((candidate) => candidate.assetId === call.assetId);
      const round = feed && settlementRound(feed, call.deadline);
      if (!feed || !round) continue;

      pending.splice(index, 1);
      try {
        await registry.write.revealCall(
          [
            call.callId,
            {
              assetId: call.assetId,
              direction: call.direction,
              targetPrice: call.targetPrice,
              salt: call.salt,
              roundId: round.roundId,
            },
          ],
          { account: call.analyst },
        );

        const won =
          call.direction === DIRECTION_ABOVE
            ? round.answer >= call.targetPrice
            : round.answer <= call.targetPrice;
        log(`  call #${call.callId} revealed — ${won ? "win" : "loss"}`);
      } catch (error) {
        log(`  call #${call.callId} failed to reveal: ${(error as Error).message.split("\n")[0]}`);
      }
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    await revealDue();
    for (const analyst of analysts) {
      if (Math.random() < COMMIT_PROBABILITY) await commit(analyst);
    }
  };

  const timer = setInterval(() => {
    void tick().catch((error: unknown) => {
      log(`  analyst simulation error: ${(error as Error).message.split("\n")[0]}`);
    });
  }, DECISION_INTERVAL_MS);

  void tick().catch(() => {});

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
