import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { formatUnits, keccak256, parseEventLogs, toHex } from "viem";
import { network } from "hardhat";

import ProofOfCall from "../ignition/modules/ProofOfCall.js";
import { startAnalysts, type FeedHandle, type PublishedRound } from "./demo-analysts.js";

/**
 * The local demo: the whole protocol, on a node running on this machine.
 *
 * Sepolia is the honest target, and it is also a bad first impression — a faucet,
 * three keystore secrets, and a one-hour minimum horizon before a call can even
 * be revealed. This script gives the same protocol a shorter path: mock
 * Chainlink aggregators it can drive itself, a two-minute minimum horizon, and a
 * price that actually moves, so the commit → wait → reveal loop takes minutes.
 *
 * Two things are deliberately *not* substituted. The deployment runs the real
 * Ignition module, so the demo exercises the same wiring Sepolia gets; and the
 * resolver, the round search and settlement are the real ones, reading a real
 * `AggregatorV3Interface`. The only fiction is who publishes the rounds.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const BTC_USD = keccak256(toHex("BTC/USD"));
const ETH_USD = keccak256(toHex("ETH/USD"));

/** Feed decimals. Chainlink's USD pairs are 8, and the resolver normalizes to 8. */
const FEED_DECIMALS = 8;
const ONE = 10n ** BigInt(FEED_DECIMALS);

/** Seconds between published rounds. Chainlink's testnet heartbeat is an hour. */
const ROUND_INTERVAL_SECONDS = 5;

/**
 * How stale a round may be at the deadline before settlement refuses it.
 *
 * Five minutes against a five-second heartbeat is generous, and it has to be:
 * the keeper is a script that can be paused by a laptop going to sleep, and a
 * threshold pinned tight to the interval turns that into a call that cannot be
 * revealed rather than into a demo that is briefly behind.
 */
const STALE_AFTER_SECONDS = 5 * 60;

/** Shortest horizon a call may be committed with, in seconds. */
const MIN_HORIZON_SECONDS = 2 * 60;
const MAX_HORIZON_SECONDS = 30 * 24 * 60 * 60;

/** Reveal window for demo calls. Long enough to walk away and come back. */
const REVEAL_WINDOW_SECONDS = 60 * 60;

const START_PRICES = {
  "BTC/USD": 96_000n * ONE,
  "ETH/USD": 3_400n * ONE,
} as const;

/**
 * One step of the random walk, in basis points of the current price.
 *
 * Large enough that a two-minute call is a genuine coin flip rather than a
 * foregone conclusion, small enough that the number on screen still looks like a
 * price rather than a lottery draw.
 */
const MAX_STEP_BPS = 25n;

function randomStep(price: bigint): bigint {
  const magnitude = BigInt(Math.floor(Math.random() * Number(MAX_STEP_BPS + 1n)));
  const delta = (price * magnitude) / 10_000n;
  return Math.random() < 0.5 ? price - delta : price + delta;
}

function fmt(price: bigint): string {
  return Number(formatUnits(price, FEED_DECIMALS)).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

/**
 * Ignition keeps a journal per deployment id and reconciles against it.
 *
 * Every demo run deploys fresh mock aggregators at fresh addresses, which is a
 * changed module parameter, which Ignition correctly refuses to reconcile
 * against the previous run. The node it is deploying to is also brand new, so
 * the previous journal describes contracts that no longer exist. Dropping it is
 * the honest move; the alternative is a confusing reconciliation error on the
 * second `npm run demo`.
 */
function clearPreviousDemoJournal(deploymentId: string): void {
  const dir = join(ROOT, "ignition", "deployments", deploymentId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/**
 * Points the frontend at this deployment.
 *
 * An existing `.env.local` is moved aside rather than overwritten. It is the
 * file that holds a real Sepolia deployment's addresses and a WalletConnect
 * project id, and silently replacing it to run a demo would be a bad trade.
 */
function writeFrontendEnv(values: Record<string, string>): string {
  const dir = join(ROOT, "frontend");
  mkdirSync(dir, { recursive: true });

  const path = join(dir, ".env.local");
  if (existsSync(path)) {
    const backup = join(dir, ".env.local.bak");
    rmSync(backup, { force: true });
    renameSync(path, backup);
    console.log(`  previous frontend/.env.local moved to frontend/.env.local.bak`);
  }

  const body = [
    "# Written by `npm run demo`. Safe to delete.",
    "# The local node's state does not survive a restart, so these addresses are",
    "# only meaningful while that node is running.",
    "",
    ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
    "",
  ].join("\n");

  writeFileSync(path, body, "utf8");
  return path;
}

async function main(): Promise<void> {
  const deploymentId = "demo";
  clearPreviousDemoJournal(deploymentId);

  const { viem, ignition } = await network.getOrCreate({ network: "localhost", chainType: "l1" });
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  const chainId = await publicClient.getChainId();
  console.log(`\nProof of Call — local demo`);
  console.log(`  node      http://127.0.0.1:8545 (chain ${chainId})`);
  console.log(`  deployer  ${deployer.account.address}\n`);

  // Mock aggregators first: the module's `setFeed` probes `decimals()`, so the
  // feeds have to have code before the resolver is configured against them.
  const btcFeed = await viem.deployContract("MockV3Aggregator", [
    FEED_DECIMALS,
    START_PRICES["BTC/USD"],
  ]);
  const ethFeed = await viem.deployContract("MockV3Aggregator", [
    FEED_DECIMALS,
    START_PRICES["ETH/USD"],
  ]);
  console.log(`  BTC/USD feed  ${btcFeed.address}  ${fmt(START_PRICES["BTC/USD"])}`);
  console.log(`  ETH/USD feed  ${ethFeed.address}  ${fmt(START_PRICES["ETH/USD"])}`);

  const deployedFrom = await publicClient.getBlockNumber();

  const { resolver, registry } = await ignition.deploy(ProofOfCall, {
    deploymentId,
    parameters: {
      ProofOfCall: {
        btcUsdFeed: btcFeed.address,
        ethUsdFeed: ethFeed.address,
        staleAfter: STALE_AFTER_SECONDS,
      },
    },
  });

  console.log(`\n  PriceOracleResolver  ${resolver.address}`);
  console.log(`  CallRegistry         ${registry.address}`);

  // ADR-009's starting parameters are tuned for a protocol people use, not for
  // one they are being shown. A one-hour minimum horizon means the earliest a
  // reveal can happen is an hour after the demo starts.
  await registry.write.setHorizons([BigInt(MIN_HORIZON_SECONDS), BigInt(MAX_HORIZON_SECONDS)]);
  await registry.write.setRevealWindow([REVEAL_WINDOW_SECONDS]);
  console.log(
    `\n  horizons relaxed to ${MIN_HORIZON_SECONDS / 60} minutes – ` +
      `${MAX_HORIZON_SECONDS / 86_400} days, reveal window ` +
      `${REVEAL_WINDOW_SECONDS / 60} minutes`,
  );

  const envPath = writeFrontendEnv({
    VITE_CHAIN_ID: String(chainId),
    VITE_RPC_URL: "http://127.0.0.1:8545",
    VITE_REGISTRY_ADDRESS: registry.address,
    VITE_RESOLVER_ADDRESS: resolver.address,
    VITE_DEPLOY_BLOCK: deployedFrom.toString(),
  });
  console.log(`  wrote ${envPath}`);

  console.log(
    `\n  publishing a round every ${ROUND_INTERVAL_SECONDS}s. Ctrl-C stops the demo.\n` +
      `  Import a Hardhat test account into MetaMask and add the network at\n` +
      `  http://127.0.0.1:8545 with chain id ${chainId} to make calls.\n`,
  );

  // The keeper. Beyond moving the price, this is what keeps `block.timestamp`
  // tracking the wall clock: an idle Hardhat node mines nothing, and a chain
  // whose clock has stopped rejects every deadline the browser computes.
  const feeds = [
    { symbol: "BTC/USD", assetId: BTC_USD, contract: btcFeed, price: START_PRICES["BTC/USD"] },
    { symbol: "ETH/USD", assetId: ETH_USD, contract: ethFeed, price: START_PRICES["ETH/USD"] },
  ].map((feed) => {
    const rounds: PublishedRound[] = [];
    const record = async () => {
      const [roundId, answer, , updatedAt] = await feed.contract.read.latestRoundData();
      rounds.push({ roundId, answer, updatedAt });
    };

    const handle: FeedHandle & { push: () => Promise<void>; record: () => Promise<void> } = {
      symbol: feed.symbol,
      assetId: feed.assetId,
      rounds,
      price: () => feed.price,
      record,
      push: async () => {
        feed.price = randomStep(feed.price);
        await feed.contract.write.updateAnswer([feed.price]);
        await record();
      },
    };
    return handle;
  });

  const publish = async () => {
    for (const feed of feeds) await feed.push();
    const block = await publicClient.getBlock();
    console.log(
      `  [${new Date(Number(block.timestamp) * 1000).toLocaleTimeString()}] ` +
        feeds.map((feed) => `${feed.symbol} ${fmt(feed.price())}`).join("   "),
    );
  };

  // The constructor's opening round predates this history, and a call committed
  // in the first seconds of the demo could settle against it.
  for (const feed of feeds) await feed.record();

  await publish();

  // Simulated analysts, so the Calls page and the leaderboard are not empty for
  // the first several minutes. They use the same two entry points a browser
  // does; see scripts/demo-analysts.ts for what they deliberately do not do.
  const walletClients = await viem.getWalletClients();
  const analysts = walletClients.slice(1, 4).map((client) => client.account.address);
  const stopAnalysts = startAnalysts({
    registry: registry as never,
    feeds,
    analysts,
    now: async () => (await publicClient.getBlock()).timestamp,
    callIdFromTx: async (hash) => {
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const events = parseEventLogs({
        abi: registry.abi,
        eventName: "CallCommitted",
        logs: receipt.logs,
      });
      return events[0]?.args.callId;
    },
    log: (line) => console.log(line),
  });
  console.log(`  simulated analysts: ${analysts.map((a) => a.slice(0, 8) + "…").join(", ")}
`);
  const timer = setInterval(() => {
    void publish().catch((error: unknown) => {
      // A failed round is not fatal — the node may be restarting, or the run may
      // be shutting down. Report it and keep the interval alive.
      console.error(`  round failed: ${(error as Error).message}`);
    });
  }, ROUND_INTERVAL_SECONDS * 1000);

  const stop = () => {
    clearInterval(timer);
    stopAnalysts();
    console.log("\n  keeper stopped.\n");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

await main();
