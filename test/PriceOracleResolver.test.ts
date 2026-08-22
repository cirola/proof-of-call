import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress, keccak256, toHex } from "viem";
import { network } from "hardhat";

const { viem, networkHelpers } = await network.getOrCreate();

/** Asset identifiers, hashed exactly the way the contract does it. */
const BTC_USD = keccak256(toHex("BTC/USD"));
const ETH_USD = keccak256(toHex("ETH/USD"));

const ONE_HOUR = 3600;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/** Build a price literal at an arbitrary decimal scale, e.g. `price(3000n, 8)`. */
function price(whole: bigint, decimals: number): bigint {
  return whole * 10n ** BigInt(decimals);
}

async function deployFixture() {
  const [admin, outsider] = await viem.getWalletClients();

  const resolver = await viem.deployContract("PriceOracleResolver", [admin.account.address]);

  // Three feeds at three scales. The 18- and 6-decimal ones exist only to prove
  // that normalization is driven by the feed's own `decimals()` and not by an
  // assumption baked into the adapter.
  const feed8 = await viem.deployContract("MockV3Aggregator", [8, price(3000n, 8)]);
  const feed18 = await viem.deployContract("MockV3Aggregator", [18, price(3000n, 18)]);
  const feed6 = await viem.deployContract("MockV3Aggregator", [6, price(3000n, 6)]);

  return { resolver, feed8, feed18, feed6, admin, outsider };
}

/**
 * Place the latest round of `feed` exactly `ageSeconds` behind the next block.
 *
 * Doing this naively — writing `now - age` and then reading — drifts, because
 * every transaction mines a block and moves the clock forward by at least a
 * second. Staleness assertions live or die on the boundary being exact, so the
 * timestamp of the observing block is pinned explicitly instead of inferred.
 */
async function setFeedAge(
  feed: { write: { setUpdatedAt: (args: readonly [bigint]) => Promise<`0x${string}`> } },
  ageSeconds: number,
): Promise<void> {
  const now = await networkHelpers.time.latest();
  const observationTime = now + 10;

  await feed.write.setUpdatedAt([BigInt(observationTime - ageSeconds)]);
  await networkHelpers.time.setNextBlockTimestamp(observationTime);
  await networkHelpers.mine();
}

describe("PriceOracleResolver", () => {
  describe("deployment", () => {
    it("grants DEFAULT_ADMIN_ROLE to the constructor argument", async () => {
      const { resolver, admin } = await networkHelpers.loadFixture(deployFixture);

      const adminRole = await resolver.read.DEFAULT_ADMIN_ROLE();
      assert.equal(await resolver.read.hasRole([adminRole, admin.account.address]), true);
    });

    it("rejects the zero address as admin", async () => {
      const { resolver } = await networkHelpers.loadFixture(deployFixture);

      // AccessControl grants nothing by default, so an admin of address(0)
      // produces a resolver whose feeds can never be configured. It has to fail
      // at construction, because there is no recovery afterwards. The already
      // deployed instance is passed only as the ABI to decode the revert with.
      await viem.assertions.revertWithCustomError(
        viem.deployContract("PriceOracleResolver", [ZERO_ADDRESS]),
        resolver,
        "InvalidAdmin",
      );
    });

    it("normalizes to 8 decimals", async () => {
      const { resolver } = await networkHelpers.loadFixture(deployFixture);
      assert.equal(await resolver.read.PRICE_DECIMALS(), 8);
    });
  });

  describe("setFeed", () => {
    it("registers a feed and reports it as supported", async () => {
      const { resolver, feed8 } = await networkHelpers.loadFixture(deployFixture);

      assert.equal(await resolver.read.isSupported([BTC_USD]), false);

      await resolver.write.setFeed([BTC_USD, feed8.address, ONE_HOUR]);

      assert.equal(await resolver.read.isSupported([BTC_USD]), true);
      const [aggregator, staleAfter] = await resolver.read.getFeedConfig([BTC_USD]);
      assert.equal(getAddress(aggregator), getAddress(feed8.address));
      assert.equal(staleAfter, ONE_HOUR);
    });

    it("emits FeedConfigured with the asset, aggregator and threshold", async () => {
      const { resolver, feed8 } = await networkHelpers.loadFixture(deployFixture);

      await viem.assertions.emitWithArgs(
        resolver.write.setFeed([BTC_USD, feed8.address, ONE_HOUR]),
        resolver,
        "FeedConfigured",
        [BTC_USD, getAddress(feed8.address), ONE_HOUR],
      );
    });

    it("lets an existing feed be reconfigured in place", async () => {
      const { resolver, feed8, feed18 } = await networkHelpers.loadFixture(deployFixture);

      await resolver.write.setFeed([BTC_USD, feed8.address, ONE_HOUR]);
      await resolver.write.setFeed([BTC_USD, feed18.address, 2 * ONE_HOUR]);

      const [aggregator, staleAfter] = await resolver.read.getFeedConfig([BTC_USD]);
      assert.equal(getAddress(aggregator), getAddress(feed18.address));
      assert.equal(staleAfter, 2 * ONE_HOUR);
    });

    it("rejects a caller without DEFAULT_ADMIN_ROLE", async () => {
      const { resolver, feed8, outsider } = await networkHelpers.loadFixture(deployFixture);

      await viem.assertions.revertWithCustomError(
        resolver.write.setFeed([BTC_USD, feed8.address, ONE_HOUR], { account: outsider.account }),
        resolver,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("rejects a zero asset id", async () => {
      const { resolver, feed8 } = await networkHelpers.loadFixture(deployFixture);

      await viem.assertions.revertWithCustomError(
        resolver.write.setFeed([ZERO_BYTES32, feed8.address, ONE_HOUR]),
        resolver,
        "InvalidAssetId",
      );
    });

    it("rejects a zero aggregator address", async () => {
      const { resolver } = await networkHelpers.loadFixture(deployFixture);

      await viem.assertions.revertWithCustomError(
        resolver.write.setFeed([BTC_USD, ZERO_ADDRESS, ONE_HOUR]),
        resolver,
        "InvalidAggregator",
      );
    });

    it("rejects a zero staleness threshold", async () => {
      const { resolver, feed8 } = await networkHelpers.loadFixture(deployFixture);

      // A threshold of zero would refuse every price, including a perfectly
      // fresh one, so a feed configured that way is silently unusable.
      await viem.assertions.revertWithCustomError(
        resolver.write.setFeed([BTC_USD, feed8.address, 0]),
        resolver,
        "InvalidStalenessThreshold",
      );
    });

    it("rejects a contract that does not answer decimals()", async () => {
      const { resolver } = await networkHelpers.loadFixture(deployFixture);

      // The resolver itself stands in for a mistyped address that happens to
      // hold code. The probe is what turns a deployment typo into a failed
      // configuration transaction instead of a failed settlement months later.
      await viem.assertions.revertWithCustomError(
        resolver.write.setFeed([BTC_USD, resolver.address, ONE_HOUR]),
        resolver,
        "AggregatorProbeFailed",
      );
    });

    it("rejects an address with no code at all", async () => {
      const { resolver, outsider } = await networkHelpers.loadFixture(deployFixture);

      // An EOA also fails, but through Solidity's extcodesize guard rather than
      // the try/catch, so only the revert itself is asserted. What matters is
      // that the configuration cannot succeed.
      await viem.assertions.revert(
        resolver.write.setFeed([BTC_USD, outsider.account.address, ONE_HOUR]),
      );
    });

    it("rejects a feed with an implausible number of decimals", async () => {
      const { resolver } = await networkHelpers.loadFixture(deployFixture);

      const absurdFeed = await viem.deployContract("MockV3Aggregator", [40, 1n]);

      await viem.assertions.revertWithCustomError(
        resolver.write.setFeed([BTC_USD, absurdFeed.address, ONE_HOUR]),
        resolver,
        "UnsupportedDecimals",
      );
    });
  });

  describe("removeFeed", () => {
    it("de-registers a feed and emits FeedRemoved", async () => {
      const { resolver, feed8 } = await networkHelpers.loadFixture(deployFixture);

      await resolver.write.setFeed([BTC_USD, feed8.address, ONE_HOUR]);

      await viem.assertions.emitWithArgs(
        resolver.write.removeFeed([BTC_USD]),
        resolver,
        "FeedRemoved",
        [BTC_USD, getAddress(feed8.address)],
      );

      assert.equal(await resolver.read.isSupported([BTC_USD]), false);
    });

    it("reverts when the asset was never configured", async () => {
      const { resolver } = await networkHelpers.loadFixture(deployFixture);

      // Succeeding silently would make a typo look like a completed removal.
      await viem.assertions.revertWithCustomError(
        resolver.write.removeFeed([ETH_USD]),
        resolver,
        "FeedNotConfigured",
      );
    });

    it("rejects a caller without DEFAULT_ADMIN_ROLE", async () => {
      const { resolver, feed8, outsider } = await networkHelpers.loadFixture(deployFixture);

      await resolver.write.setFeed([BTC_USD, feed8.address, ONE_HOUR]);

      await viem.assertions.revertWithCustomError(
        resolver.write.removeFeed([BTC_USD], { account: outsider.account }),
        resolver,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("getPrice - decimal normalization", () => {
    it("passes an 8-decimal feed through unchanged", async () => {
      const { resolver, feed8 } = await networkHelpers.loadFixture(deployFixture);

      await resolver.write.setFeed([BTC_USD, feed8.address, ONE_HOUR]);

      assert.equal(await resolver.read.getPrice([BTC_USD]), price(3000n, 8));
    });

    it("scales an 18-decimal feed down to 8", async () => {
      const { resolver, feed18 } = await networkHelpers.loadFixture(deployFixture);

      await resolver.write.setFeed([ETH_USD, feed18.address, ONE_HOUR]);

      assert.equal(await resolver.read.getPrice([ETH_USD]), price(3000n, 8));
    });

    it("scales a 6-decimal feed up to 8", async () => {
      const { resolver, feed6 } = await networkHelpers.loadFixture(deployFixture);

      await resolver.write.setFeed([ETH_USD, feed6.address, ONE_HOUR]);

      assert.equal(await resolver.read.getPrice([ETH_USD]), price(3000n, 8));
    });

    it("truncates precision below 8 decimals when scaling down", async () => {
      const { resolver, feed18 } = await networkHelpers.loadFixture(deployFixture);

      await resolver.write.setFeed([ETH_USD, feed18.address, ONE_HOUR]);

      // 3000.000000005 at 18 decimals. The trailing 5 sits below the 8-decimal
      // grid and is discarded - documented behaviour, asserted so a future
      // refactor cannot change it silently.
      await feed18.write.updateAnswer([price(3000n, 18) + 5n]);

      assert.equal(await resolver.read.getPrice([ETH_USD]), price(3000n, 8));
    });
  });

  describe("getPrice - freshness", () => {
    it("accepts data exactly at the staleness threshold", async () => {
      const { resolver, feed8 } = await networkHelpers.loadFixture(deployFixture);

      await resolver.write.setFeed([BTC_USD, feed8.address, ONE_HOUR]);
      await setFeedAge(feed8, ONE_HOUR);

      // The check is `age > staleAfter`, so an age of exactly the threshold is
      // still valid. Pinning the boundary keeps an off-by-one from turning into
      // spurious settlement failures on a healthy feed.
      assert.equal(await resolver.read.getPrice([BTC_USD]), price(3000n, 8));
    });

    it("rejects data one second past the threshold", async () => {
      const { resolver, feed8 } = await networkHelpers.loadFixture(deployFixture);

      await resolver.write.setFeed([BTC_USD, feed8.address, ONE_HOUR]);
      await setFeedAge(feed8, ONE_HOUR + 1);

      await viem.assertions.revertWithCustomError(
        resolver.read.getPrice([BTC_USD]),
        resolver,
        "StalePrice",
      );
    });

    it("rejects a feed that stopped publishing hours ago", async () => {
      const { resolver, feed8 } = await networkHelpers.loadFixture(deployFixture);

      await resolver.write.setFeed([BTC_USD, feed8.address, ONE_HOUR]);
      await setFeedAge(feed8, 12 * ONE_HOUR);

      // This is attack C. The feed still answers, still returns a plausible
      // number, and gives no indication that it is dead. Only `updatedAt`
      // distinguishes it from a healthy feed.
      await viem.assertions.revertWithCustomError(
        resolver.read.getPrice([BTC_USD]),
        resolver,
        "StalePrice",
      );
    });

    it("applies each feed's own threshold independently", async () => {
      const { resolver, feed8, feed18 } = await networkHelpers.loadFixture(deployFixture);

      await resolver.write.setFeed([BTC_USD, feed8.address, ONE_HOUR]);
      await resolver.write.setFeed([ETH_USD, feed18.address, 6 * ONE_HOUR]);

      await setFeedAge(feed8, 3 * ONE_HOUR);
      await setFeedAge(feed18, 3 * ONE_HOUR);

      // Same age, opposite outcomes. A single global threshold could not produce
      // this, which is the whole argument for storing it per feed.
      await viem.assertions.revertWithCustomError(
        resolver.read.getPrice([BTC_USD]),
        resolver,
        "StalePrice",
      );
      assert.equal(await resolver.read.getPrice([ETH_USD]), price(3000n, 8));
    });

    it("rejects a round that was never answered", async () => {
      const { resolver, feed8 } = await networkHelpers.loadFixture(deployFixture);

      await resolver.write.setFeed([BTC_USD, feed8.address, ONE_HOUR]);
      await feed8.write.setUpdatedAt([0n]);

      await viem.assertions.revertWithCustomError(
        resolver.read.getPrice([BTC_USD]),
        resolver,
        "RoundNotComplete",
      );
    });

    it("rejects a timestamp in the future", async () => {
      const { resolver, feed8 } = await networkHelpers.loadFixture(deployFixture);

      await resolver.write.setFeed([BTC_USD, feed8.address, ONE_HOUR]);

      const now = await networkHelpers.time.latest();
      await feed8.write.setUpdatedAt([BigInt(now + 10 * ONE_HOUR)]);

      // Without this guard the staleness subtraction underflows and surfaces as
      // an anonymous arithmetic panic instead of a named error.
      await viem.assertions.revertWithCustomError(
        resolver.read.getPrice([BTC_USD]),
        resolver,
        "FutureTimestamp",
      );
    });
  });

  describe("getPrice - content", () => {
    it("rejects an unconfigured asset", async () => {
      const { resolver } = await networkHelpers.loadFixture(deployFixture);

      await viem.assertions.revertWithCustomError(
        resolver.read.getPrice([BTC_USD]),
        resolver,
        "FeedNotConfigured",
      );
    });

    it("rejects a negative price", async () => {
      const { resolver, feed8 } = await networkHelpers.loadFixture(deployFixture);

      await resolver.write.setFeed([BTC_USD, feed8.address, ONE_HOUR]);
      await feed8.write.updateAnswer([-1n]);

      await viem.assertions.revertWithCustomError(
        resolver.read.getPrice([BTC_USD]),
        resolver,
        "NonPositivePrice",
      );
    });

    it("rejects a zero price", async () => {
      const { resolver, feed8 } = await networkHelpers.loadFixture(deployFixture);

      await resolver.write.setFeed([BTC_USD, feed8.address, ONE_HOUR]);
      await feed8.write.updateAnswer([0n]);

      await viem.assertions.revertWithCustomError(
        resolver.read.getPrice([BTC_USD]),
        resolver,
        "NonPositivePrice",
      );
    });

    it("stops answering once the feed is removed", async () => {
      const { resolver, feed8 } = await networkHelpers.loadFixture(deployFixture);

      await resolver.write.setFeed([BTC_USD, feed8.address, ONE_HOUR]);
      assert.equal(await resolver.read.getPrice([BTC_USD]), price(3000n, 8));

      await resolver.write.removeFeed([BTC_USD]);

      await viem.assertions.revertWithCustomError(
        resolver.read.getPrice([BTC_USD]),
        resolver,
        "FeedNotConfigured",
      );
    });
  });
});
