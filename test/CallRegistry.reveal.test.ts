import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress, keccak256, parseEther, toHex } from "viem";
import { network } from "hardhat";

const { viem, networkHelpers } = await network.getOrCreate();

const BTC_USD = keccak256(toHex("BTC/USD"));
const ETH_USD = keccak256(toHex("ETH/USD"));

const ONE_HOUR = 3600;
const STALE_AFTER = ONE_HOUR;
const REVEAL_WINDOW = 48 * ONE_HOUR;
const STAKE = parseEther("0.01");
const SALT = keccak256(toHex("salt-reveal"));

const ABOVE = 0;
const BELOW = 1;

const STATUS_COMMITTED = 1;
const STATUS_REVEALED_WIN = 2;
const STATUS_REVEALED_LOSS = 3;
const STATUS_FORFEITED = 4;

function price(whole: bigint): bigint {
  return whole * 10n ** 8n;
}

async function deployFixture() {
  const [admin, analyst, bystander, treasury] = await viem.getWalletClients();

  const resolver = await viem.deployContract("PriceOracleResolver", [admin.account.address]);
  const feed = await viem.deployContract("MockV3Aggregator", [8, price(3000n)]);
  await resolver.write.setFeed([BTC_USD, feed.address, STALE_AFTER]);

  const registry = await viem.deployContract("CallRegistry", [
    admin.account.address,
    treasury.account.address,
    resolver.address,
  ]);

  const publicClient = await viem.getPublicClient();

  return { registry, resolver, feed, admin, analyst, bystander, treasury, publicClient };
}

/**
 * Commit one call and return everything needed to open it later.
 *
 * The deadline is two hours out, which clears `minHorizon` with room to spare
 * and keeps every test's arithmetic on the same base.
 */
async function commitOne(
  registry: any,
  analyst: any,
  overrides: {
    direction?: number;
    targetPrice?: bigint;
    assetId?: `0x${string}`;
    salt?: `0x${string}`;
  } = {},
) {
  const assetId = overrides.assetId ?? BTC_USD;
  const direction = overrides.direction ?? ABOVE;
  const targetPrice = overrides.targetPrice ?? price(3500n);
  const salt = overrides.salt ?? SALT;

  const deadline = BigInt((await networkHelpers.time.latest()) + 2 * ONE_HOUR);
  const commitment = await registry.read.computeCommitment([
    assetId,
    direction,
    targetPrice,
    deadline,
    salt,
    analyst.account.address,
  ]);

  const callId = BigInt(await registry.read.callCount());
  await registry.write.commitCall([commitment, deadline], {
    account: analyst.account,
    value: STAKE,
  });

  return { callId, deadline, assetId, direction, targetPrice, salt };
}

/**
 * Travel past `deadline` and publish the round that settlement will read.
 *
 * The round is stamped exactly at the deadline, so it is the last one at or
 * before it and there is no successor - which is precisely the shape
 * `getPriceAt` demands. The mock's constructor already wrote round 1, so the
 * round this publishes is number 2 on a fresh feed.
 */
async function publishSettlementRound(
  feed: any,
  deadline: bigint,
  answer: bigint,
): Promise<bigint> {
  await networkHelpers.time.increaseTo(Number(deadline) + 60);
  await feed.write.pushRoundAt([answer, deadline]);
  return 2n;
}

function revealParams(
  p: { assetId: `0x${string}`; direction: number; targetPrice: bigint; salt: `0x${string}` },
  roundId: bigint,
) {
  return {
    assetId: p.assetId,
    direction: p.direction,
    targetPrice: p.targetPrice,
    salt: p.salt,
    roundId,
  };
}

describe("CallRegistry - reveal, forfeit and settlement", () => {
  describe("outcome", () => {
    it("returns the stake when an Above call is right", async () => {
      const { registry, feed, analyst, publicClient } =
        await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst);
      const roundId = await publishSettlementRound(feed, call.deadline, price(3600n));

      const before = await publicClient.getBalance({ address: analyst.account.address });
      const hash = await registry.write.revealCall([call.callId, revealParams(call, roundId)], {
        account: analyst.account,
      });
      const receipt = await publicClient.getTransactionReceipt({ hash });
      const gas = receipt.gasUsed * receipt.effectiveGasPrice;

      const stored = await registry.read.getCall([call.callId]);
      assert.equal(stored.status, STATUS_REVEALED_WIN);

      const stats = await registry.read.getStats([analyst.account.address]);
      assert.equal(stats.wins, 1);
      assert.equal(stats.losses, 0);

      assert.equal(
        await publicClient.getBalance({ address: analyst.account.address }),
        before + STAKE - gas,
      );
      assert.equal(await publicClient.getBalance({ address: registry.address }), 0n);
    });

    it("slashes the stake to the treasury when an Above call is wrong", async () => {
      const { registry, feed, analyst, treasury, publicClient } =
        await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst);
      const roundId = await publishSettlementRound(feed, call.deadline, price(3400n));

      const before = await publicClient.getBalance({ address: treasury.account.address });
      await registry.write.revealCall([call.callId, revealParams(call, roundId)], {
        account: analyst.account,
      });

      assert.equal((await registry.read.getCall([call.callId])).status, STATUS_REVEALED_LOSS);
      assert.equal((await registry.read.getStats([analyst.account.address])).losses, 1);
      assert.equal(
        await publicClient.getBalance({ address: treasury.account.address }),
        before + STAKE,
      );
    });

    it("wins a Below call when the price came in under the target", async () => {
      const { registry, feed, analyst } = await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst, {
        direction: BELOW,
        targetPrice: price(3500n),
      });
      const roundId = await publishSettlementRound(feed, call.deadline, price(3400n));

      await registry.write.revealCall([call.callId, revealParams(call, roundId)], {
        account: analyst.account,
      });

      assert.equal((await registry.read.getCall([call.callId])).status, STATUS_REVEALED_WIN);
    });

    it("loses a Below call when the price came in over the target", async () => {
      const { registry, feed, analyst } = await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst, {
        direction: BELOW,
        targetPrice: price(3500n),
      });
      const roundId = await publishSettlementRound(feed, call.deadline, price(3600n));

      await registry.write.revealCall([call.callId, revealParams(call, roundId)], {
        account: analyst.account,
      });

      assert.equal((await registry.read.getCall([call.callId])).status, STATUS_REVEALED_LOSS);
    });

    it("counts an exact hit as a win for Above", async () => {
      const { registry, feed, analyst } = await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst, {
        direction: ABOVE,
        targetPrice: price(3500n),
      });
      const roundId = await publishSettlementRound(feed, call.deadline, price(3500n));

      // `>=`, not `>`. The alternative silently loses a call that landed exactly
      // on its target, which is the one outcome an analyst would call correct.
      await registry.write.revealCall([call.callId, revealParams(call, roundId)], {
        account: analyst.account,
      });

      assert.equal((await registry.read.getCall([call.callId])).status, STATUS_REVEALED_WIN);
    });

    it("counts an exact hit as a win for Below", async () => {
      const { registry, feed, analyst } = await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst, {
        direction: BELOW,
        targetPrice: price(3500n),
      });
      const roundId = await publishSettlementRound(feed, call.deadline, price(3500n));

      assert.equal(await registry.read.callCount(), 1n);
      await registry.write.revealCall([call.callId, revealParams(call, roundId)], {
        account: analyst.account,
      });

      assert.equal((await registry.read.getCall([call.callId])).status, STATUS_REVEALED_WIN);
    });

    it("announces the target and the settlement price it was judged against", async () => {
      const { registry, feed, analyst } = await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst);
      const roundId = await publishSettlementRound(feed, call.deadline, price(3600n));

      await viem.assertions.emitWithArgs(
        registry.write.revealCall([call.callId, revealParams(call, roundId)], {
          account: analyst.account,
        }),
        registry,
        "CallRevealed",
        [
          call.callId,
          getAddress(analyst.account.address),
          BTC_USD,
          ABOVE,
          price(3500n),
          price(3600n),
          true,
        ],
      );
    });
  });

  describe("settling at the deadline rather than at the reveal", () => {
    it("ignores a later price that would have flipped the outcome", async () => {
      const { registry, feed, analyst } = await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst, {
        direction: ABOVE,
        targetPrice: price(3500n),
      });

      // At the deadline the call is wrong: $3,400 against a $3,500 target.
      const roundId = await publishSettlementRound(feed, call.deadline, price(3400n));

      // A day later the price crosses. This is exactly the moment a dishonest
      // analyst would choose to reveal, and under `latestRoundData` settlement
      // it would record a win.
      await networkHelpers.time.increase(24 * ONE_HOUR);
      await feed.write.updateAnswer([price(3900n)]);

      await registry.write.revealCall([call.callId, revealParams(call, roundId)], {
        account: analyst.account,
      });

      assert.equal((await registry.read.getCall([call.callId])).status, STATUS_REVEALED_LOSS);
    });

    it("refuses a round from after the deadline", async () => {
      const { registry, resolver, feed, analyst } = await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst);
      await publishSettlementRound(feed, call.deadline, price(3400n));

      await networkHelpers.time.increase(30 * 60);
      await feed.write.updateAnswer([price(3900n)]);

      // Round 3 is the post-deadline price the analyst would rather be judged on.
      await viem.assertions.revertWithCustomError(
        registry.write.revealCall([call.callId, revealParams(call, 3n)], {
          account: analyst.account,
        }),
        resolver,
        "RoundAfterTimestamp",
      );
    });

    it("refuses a cherry-picked earlier round when a later one also covers the deadline", async () => {
      const { registry, resolver, feed, analyst } = await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst);

      // Two rounds inside the staleness window before the deadline. Round 2 says
      // the call is right, round 3 - the one that actually covers the deadline -
      // says it is wrong.
      await networkHelpers.time.increaseTo(Number(call.deadline) + 60);
      await feed.write.pushRoundAt([price(3600n), call.deadline - 1800n]);
      await feed.write.pushRoundAt([price(3400n), call.deadline]);

      await viem.assertions.revertWithCustomError(
        registry.write.revealCall([call.callId, revealParams(call, 2n)], {
          account: analyst.account,
        }),
        resolver,
        "LaterRoundAvailable",
      );

      await registry.write.revealCall([call.callId, revealParams(call, 3n)], {
        account: analyst.account,
      });
      assert.equal((await registry.read.getCall([call.callId])).status, STATUS_REVEALED_LOSS);
    });

    it("leaves the call open when the feed has no round covering the deadline", async () => {
      const { registry, resolver, feed, analyst } = await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst);

      // The feed went quiet before the deadline and came back after it. Nothing
      // describes the price at the deadline, so settlement fails closed and the
      // call stays revealable until the window shuts.
      await networkHelpers.time.increaseTo(Number(call.deadline) + 2 * ONE_HOUR);
      await feed.write.pushRoundAt([price(3600n), call.deadline - BigInt(2 * ONE_HOUR)]);

      await viem.assertions.revertWithCustomError(
        registry.write.revealCall([call.callId, revealParams(call, 2n)], {
          account: analyst.account,
        }),
        resolver,
        "StaleRoundForTimestamp",
      );

      assert.equal((await registry.read.getCall([call.callId])).status, STATUS_COMMITTED);
    });
  });

  describe("reveal access and timing", () => {
    it("refuses a reveal before the deadline", async () => {
      const { registry, feed, analyst } = await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst);
      await feed.write.updateAnswer([price(3600n)]);

      // If this were legal the analyst could watch the price and open only once
      // it already favoured them, and the commitment would be decorative.
      await viem.assertions.revertWithCustomError(
        registry.write.revealCall([call.callId, revealParams(call, 1n)], {
          account: analyst.account,
        }),
        registry,
        "TooEarlyToReveal",
      );
    });

    it("accepts a reveal on the last second of the window", async () => {
      const { registry, feed, analyst } = await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst);
      const roundId = await publishSettlementRound(feed, call.deadline, price(3600n));

      const revealDeadline = Number(call.deadline) + REVEAL_WINDOW;
      await networkHelpers.time.setNextBlockTimestamp(revealDeadline);

      await registry.write.revealCall([call.callId, revealParams(call, roundId)], {
        account: analyst.account,
      });

      assert.equal((await registry.read.getCall([call.callId])).status, STATUS_REVEALED_WIN);
    });

    it("refuses a reveal one second after the window closes", async () => {
      const { registry, feed, analyst } = await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst);
      const roundId = await publishSettlementRound(feed, call.deadline, price(3600n));

      await networkHelpers.time.setNextBlockTimestamp(Number(call.deadline) + REVEAL_WINDOW + 1);

      await viem.assertions.revertWithCustomError(
        registry.write.revealCall([call.callId, revealParams(call, roundId)], {
          account: analyst.account,
        }),
        registry,
        "RevealWindowClosed",
      );
    });

    it("refuses a reveal from anybody but the analyst", async () => {
      const { registry, feed, analyst, bystander } =
        await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst);
      const roundId = await publishSettlementRound(feed, call.deadline, price(3600n));

      // The analyst is in the preimage, so a stranger could not produce a
      // matching hash anyway. Rejecting here names the failure instead of
      // surfacing it as a confusing commitment mismatch.
      await viem.assertions.revertWithCustomError(
        registry.write.revealCall([call.callId, revealParams(call, roundId)], {
          account: bystander.account,
        }),
        registry,
        "NotAnalyst",
      );
    });

    it("refuses a call id that was never used", async () => {
      const { registry, analyst } = await networkHelpers.loadFixture(deployFixture);

      await viem.assertions.revertWithCustomError(
        registry.write.revealCall(
          [
            7n,
            { assetId: BTC_USD, direction: ABOVE, targetPrice: price(1n), salt: SALT, roundId: 1n },
          ],
          { account: analyst.account },
        ),
        registry,
        "CallNotFound",
      );
    });

    it("refuses to reveal the same call twice", async () => {
      const { registry, feed, analyst } = await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst);
      const roundId = await publishSettlementRound(feed, call.deadline, price(3600n));

      await registry.write.revealCall([call.callId, revealParams(call, roundId)], {
        account: analyst.account,
      });

      // Invariant 5: no path leads back to `Committed`, so a settled call cannot
      // be settled again and the stake cannot be paid out twice.
      await viem.assertions.revertWithCustomError(
        registry.write.revealCall([call.callId, revealParams(call, roundId)], {
          account: analyst.account,
        }),
        registry,
        "CallNotOpen",
      );
    });
  });

  describe("commitment binding", () => {
    it("refuses a different target price", async () => {
      const { registry, feed, analyst } = await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst, { targetPrice: price(3500n) });
      const roundId = await publishSettlementRound(feed, call.deadline, price(3600n));

      // The whole mechanism in one assertion: the call cannot be edited into a
      // shape that wins once the outcome is known.
      await viem.assertions.revertWithCustomError(
        registry.write.revealCall(
          [call.callId, revealParams({ ...call, targetPrice: price(3550n) }, roundId)],
          { account: analyst.account },
        ),
        registry,
        "CommitmentMismatch",
      );
    });

    it("refuses a flipped direction", async () => {
      const { registry, feed, analyst } = await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst, { direction: ABOVE });
      const roundId = await publishSettlementRound(feed, call.deadline, price(3400n));

      await viem.assertions.revertWithCustomError(
        registry.write.revealCall(
          [call.callId, revealParams({ ...call, direction: BELOW }, roundId)],
          {
            account: analyst.account,
          },
        ),
        registry,
        "CommitmentMismatch",
      );
    });

    it("refuses a substituted asset", async () => {
      const { registry, feed, analyst } = await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst);
      const roundId = await publishSettlementRound(feed, call.deadline, price(3600n));

      await viem.assertions.revertWithCustomError(
        registry.write.revealCall(
          [call.callId, revealParams({ ...call, assetId: ETH_USD }, roundId)],
          {
            account: analyst.account,
          },
        ),
        registry,
        "CommitmentMismatch",
      );
    });

    it("refuses a wrong salt", async () => {
      const { registry, feed, analyst } = await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst);
      const roundId = await publishSettlementRound(feed, call.deadline, price(3600n));

      // Losing the salt is unrecoverable, which is why the UI treats it as a
      // secret worth as much as the stake.
      await viem.assertions.revertWithCustomError(
        registry.write.revealCall(
          [call.callId, revealParams({ ...call, salt: keccak256(toHex("wrong")) }, roundId)],
          { account: analyst.account },
        ),
        registry,
        "CommitmentMismatch",
      );
    });
  });

  describe("forfeit", () => {
    it("lets a stranger close an abandoned call", async () => {
      const { registry, analyst, bystander, treasury, publicClient } =
        await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst);
      await networkHelpers.time.increaseTo(Number(call.deadline) + REVEAL_WINDOW + 1);

      const before = await publicClient.getBalance({ address: treasury.account.address });

      // Attack A. If only the analyst could record their own forfeit, a
      // hundred-call spray would leave ninety-seven calls sitting in `Committed`
      // and the visible record would still be flawless.
      await registry.write.forfeit([call.callId], { account: bystander.account });

      assert.equal((await registry.read.getCall([call.callId])).status, STATUS_FORFEITED);
      assert.equal((await registry.read.getStats([analyst.account.address])).forfeited, 1);
      assert.equal(
        await publicClient.getBalance({ address: treasury.account.address }),
        before + STAKE,
      );
    });

    it("announces who let it lapse and who closed it", async () => {
      const { registry, analyst, bystander } = await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst);
      await networkHelpers.time.increaseTo(Number(call.deadline) + REVEAL_WINDOW + 1);

      await viem.assertions.emitWithArgs(
        registry.write.forfeit([call.callId], { account: bystander.account }),
        registry,
        "CallForfeited",
        [
          call.callId,
          getAddress(analyst.account.address),
          getAddress(bystander.account.address),
          STAKE,
        ],
      );
    });

    it("refuses while the window is still open, including on its last second", async () => {
      const { registry, analyst, bystander } = await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst);
      await networkHelpers.time.setNextBlockTimestamp(Number(call.deadline) + REVEAL_WINDOW);

      // The boundary belongs to the analyst: `forfeit` needs `> revealDeadline`
      // where `revealCall` accepts `<=`, so the two can never both be legal.
      await viem.assertions.revertWithCustomError(
        registry.write.forfeit([call.callId], { account: bystander.account }),
        registry,
        "RevealWindowStillOpen",
      );
    });

    it("refuses a call that was already revealed", async () => {
      const { registry, feed, analyst, bystander } =
        await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst);
      const roundId = await publishSettlementRound(feed, call.deadline, price(3600n));
      await registry.write.revealCall([call.callId, revealParams(call, roundId)], {
        account: analyst.account,
      });

      await networkHelpers.time.increaseTo(Number(call.deadline) + REVEAL_WINDOW + 1);

      await viem.assertions.revertWithCustomError(
        registry.write.forfeit([call.callId], { account: bystander.account }),
        registry,
        "CallNotOpen",
      );
    });

    it("refuses to be undone by a late reveal", async () => {
      const { registry, feed, analyst, bystander } =
        await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst);
      const roundId = await publishSettlementRound(feed, call.deadline, price(3600n));

      await networkHelpers.time.increaseTo(Number(call.deadline) + REVEAL_WINDOW + 1);
      await registry.write.forfeit([call.callId], { account: bystander.account });

      // Invariant 5 from the other side: a forfeit is terminal even for a call
      // that would have won.
      await viem.assertions.revertWithCustomError(
        registry.write.revealCall([call.callId, revealParams(call, roundId)], {
          account: analyst.account,
        }),
        registry,
        "CallNotOpen",
      );
    });

    it("refuses a call id that was never used", async () => {
      const { registry, bystander } = await networkHelpers.loadFixture(deployFixture);

      await viem.assertions.revertWithCustomError(
        registry.write.forfeit([7n], { account: bystander.account }),
        registry,
        "CallNotFound",
      );
    });

    it("stays available while the protocol is paused", async () => {
      const { registry, analyst, bystander } = await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst);
      await registry.write.pause();
      await networkHelpers.time.increaseTo(Number(call.deadline) + REVEAL_WINDOW + 1);

      // A pause that could reach settlement would let an admin freeze stakes
      // indefinitely, which is a confiscation switch rather than a brake.
      await registry.write.forfeit([call.callId], { account: bystander.account });

      assert.equal((await registry.read.getCall([call.callId])).status, STATUS_FORFEITED);
    });

    it("stays available for a reveal while the protocol is paused", async () => {
      const { registry, feed, analyst } = await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst);
      const roundId = await publishSettlementRound(feed, call.deadline, price(3600n));
      await registry.write.pause();

      await registry.write.revealCall([call.callId, revealParams(call, roundId)], {
        account: analyst.account,
      });

      assert.equal((await registry.read.getCall([call.callId])).status, STATUS_REVEALED_WIN);
    });
  });

  describe("payout failure and reentrancy", () => {
    it("reverts the whole reveal when the winner cannot receive ETH", async () => {
      const { registry, feed, admin } = await networkHelpers.loadFixture(deployFixture);

      const rejecter = await viem.deployContract("EthRejecter", []);

      const deadline = BigInt((await networkHelpers.time.latest()) + 2 * ONE_HOUR);
      const commitment = await registry.read.computeCommitment([
        BTC_USD,
        ABOVE,
        price(3500n),
        deadline,
        SALT,
        rejecter.address,
      ]);
      await rejecter.write.commit([registry.address, commitment, deadline], {
        account: admin.account,
        value: STAKE,
      });

      const roundId = await publishSettlementRound(feed, deadline, price(3600n));

      // The failure is loud. An unchecked `call{value:}` would have marked the
      // call settled and quietly kept the money.
      await viem.assertions.revertWithCustomError(
        rejecter.write.reveal([
          registry.address,
          0n,
          { assetId: BTC_USD, direction: ABOVE, targetPrice: price(3500n), salt: SALT, roundId },
        ]),
        registry,
        "StakeTransferFailed",
      );

      assert.equal((await registry.read.getCall([0n])).status, STATUS_COMMITTED);
    });

    it("rejects a treasury that calls back into the registry during settlement", async () => {
      const { registry, feed, analyst, publicClient } =
        await networkHelpers.loadFixture(deployFixture);

      const hostile = await viem.deployContract("ReentrantTreasury", []);
      await registry.write.setTreasury([hostile.address]);

      const call = await commitOne(registry, analyst);
      await hostile.write.arm([registry.address, call.callId]);

      const roundId = await publishSettlementRound(feed, call.deadline, price(3400n));

      await registry.write.revealCall([call.callId, revealParams(call, roundId)], {
        account: analyst.account,
      });

      // The treasury got control mid-settlement and tried to forfeit the same
      // call. Two independent things stopped it: the status left `Committed`
      // before the transfer, and the transient reentrancy guard was still held.
      assert.equal(await hostile.read.reentryReverted(), true);
      assert.equal(await hostile.read.reentrySucceeded(), false);

      // Settled exactly once: the stake moved, and it moved only the one time.
      assert.equal((await registry.read.getCall([call.callId])).status, STATUS_REVEALED_LOSS);
      assert.equal(await publicClient.getBalance({ address: hostile.address }), STAKE);
      assert.equal(await publicClient.getBalance({ address: registry.address }), 0n);
    });
  });

  describe("invariants", () => {
    it("never pays out more than the stakes it holds across mixed outcomes", async () => {
      const { registry, feed, analyst, bystander, publicClient } =
        await networkHelpers.loadFixture(deployFixture);

      // Three calls with the same deadline: one wins, one loses, one is
      // abandoned. Every path out of `Committed` runs in a single test.
      const deadline = BigInt((await networkHelpers.time.latest()) + 2 * ONE_HOUR);
      const specs = [
        { direction: ABOVE, targetPrice: price(3500n), salt: keccak256(toHex("s0")) },
        { direction: ABOVE, targetPrice: price(3900n), salt: keccak256(toHex("s1")) },
        { direction: BELOW, targetPrice: price(3000n), salt: keccak256(toHex("s2")) },
      ];

      for (const spec of specs) {
        const commitment = await registry.read.computeCommitment([
          BTC_USD,
          spec.direction,
          spec.targetPrice,
          deadline,
          spec.salt,
          analyst.account.address,
        ]);
        await registry.write.commitCall([commitment, deadline], {
          account: analyst.account,
          value: STAKE,
        });
      }

      assert.equal(await publicClient.getBalance({ address: registry.address }), STAKE * 3n);

      const roundId = await publishSettlementRound(feed, deadline, price(3600n));

      await registry.write.revealCall([0n, { assetId: BTC_USD, ...specs[0], roundId }], {
        account: analyst.account,
      });
      await registry.write.revealCall([1n, { assetId: BTC_USD, ...specs[1], roundId }], {
        account: analyst.account,
      });

      await networkHelpers.time.increaseTo(Number(deadline) + REVEAL_WINDOW + 1);
      await registry.write.forfeit([2n], { account: bystander.account });

      const stats = await registry.read.getStats([analyst.account.address]);
      assert.equal(stats.committed, 3);
      assert.equal(stats.wins, 1);
      assert.equal(stats.losses, 1);
      assert.equal(stats.forfeited, 1);

      // Invariant 6 at the end state: nothing is open, so nothing is owed, and
      // the contract holds nothing.
      let openStake = 0n;
      for (let id = 0n; id < 3n; id++) {
        const stored = await registry.read.getCall([id]);
        if (stored.status === STATUS_COMMITTED) openStake += stored.stake;
      }
      assert.equal(openStake, 0n);
      assert.ok((await publicClient.getBalance({ address: registry.address })) >= openStake);
      assert.equal(await publicClient.getBalance({ address: registry.address }), 0n);
    });

    it("counts every committed call in exactly one terminal bucket", async () => {
      const { registry, feed, analyst } = await networkHelpers.loadFixture(deployFixture);

      const call = await commitOne(registry, analyst);
      const roundId = await publishSettlementRound(feed, call.deadline, price(3600n));
      await registry.write.revealCall([call.callId, revealParams(call, roundId)], {
        account: analyst.account,
      });

      // Invariant 3: `committed == wins + losses + forfeited` once nothing is
      // open. It is what makes selective reveal visible rather than deniable.
      const stats = await registry.read.getStats([analyst.account.address]);
      assert.equal(stats.committed, stats.wins + stats.losses + stats.forfeited);
    });
  });
});
