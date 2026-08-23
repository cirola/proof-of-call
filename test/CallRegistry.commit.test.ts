import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeAbiParameters, getAddress, keccak256, parseEther, toHex } from "viem";
import { network } from "hardhat";

const { viem, networkHelpers } = await network.getOrCreate();

const BTC_USD = keccak256(toHex("BTC/USD"));

const ONE_HOUR = 3600;
const ONE_DAY = 24 * ONE_HOUR;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

const MIN_STAKE = parseEther("0.001");
const MIN_HORIZON = ONE_HOUR;
const MAX_HORIZON = 30 * ONE_DAY;
const REVEAL_WINDOW = 48 * ONE_HOUR;

const ABOVE = 0;
const BELOW = 1;

const STATUS_NONE = 0;
const STATUS_COMMITTED = 1;

/** A salt that is obviously a test fixture and obviously not from a CSPRNG. */
const SALT = keccak256(toHex("salt-1"));

function price(whole: bigint): bigint {
  return whole * 10n ** 8n;
}

async function deployFixture() {
  const [admin, analyst, other, treasury] = await viem.getWalletClients();

  const resolver = await viem.deployContract("PriceOracleResolver", [admin.account.address]);
  const feed = await viem.deployContract("MockV3Aggregator", [8, price(3000n)]);
  await resolver.write.setFeed([BTC_USD, feed.address, ONE_HOUR]);

  const registry = await viem.deployContract("CallRegistry", [
    admin.account.address,
    treasury.account.address,
    resolver.address,
  ]);

  const publicClient = await viem.getPublicClient();

  return { registry, resolver, feed, admin, analyst, other, treasury, publicClient };
}

/** A deadline comfortably inside `[minHorizon, maxHorizon]`. */
async function validDeadline(offsetSeconds = 2 * ONE_HOUR): Promise<bigint> {
  return BigInt((await networkHelpers.time.latest()) + offsetSeconds);
}

describe("CallRegistry - commit", () => {
  describe("deployment", () => {
    it("grants both roles to the admin", async () => {
      const { registry, admin } = await networkHelpers.loadFixture(deployFixture);

      const adminRole = await registry.read.DEFAULT_ADMIN_ROLE();
      const pauserRole = await registry.read.PAUSER_ROLE();

      assert.equal(await registry.read.hasRole([adminRole, admin.account.address]), true);
      assert.equal(await registry.read.hasRole([pauserRole, admin.account.address]), true);
    });

    it("starts at the parameters fixed in ADR-009", async () => {
      const { registry } = await networkHelpers.loadFixture(deployFixture);

      assert.equal(await registry.read.minStake(), MIN_STAKE);
      assert.equal(await registry.read.minHorizon(), BigInt(MIN_HORIZON));
      assert.equal(await registry.read.maxHorizon(), BigInt(MAX_HORIZON));
      assert.equal(await registry.read.revealWindow(), REVEAL_WINDOW);
      assert.equal(await registry.read.callCount(), 0n);
    });

    it("rejects a zero admin", async () => {
      const { registry, resolver, treasury } = await networkHelpers.loadFixture(deployFixture);

      await viem.assertions.revertWithCustomError(
        viem.deployContract("CallRegistry", [
          ZERO_ADDRESS,
          treasury.account.address,
          resolver.address,
        ]),
        registry,
        "InvalidAdmin",
      );
    });

    it("rejects a zero treasury", async () => {
      const { registry, resolver, admin } = await networkHelpers.loadFixture(deployFixture);

      // A zero treasury is not a dormant setting: every slashed stake would be
      // burned to address(0) until somebody noticed.
      await viem.assertions.revertWithCustomError(
        viem.deployContract("CallRegistry", [
          admin.account.address,
          ZERO_ADDRESS,
          resolver.address,
        ]),
        registry,
        "InvalidTreasury",
      );
    });

    it("rejects a zero resolver", async () => {
      const { registry, admin, treasury } = await networkHelpers.loadFixture(deployFixture);

      await viem.assertions.revertWithCustomError(
        viem.deployContract("CallRegistry", [
          admin.account.address,
          treasury.account.address,
          ZERO_ADDRESS,
        ]),
        registry,
        "InvalidResolver",
      );
    });
  });

  describe("computeCommitment", () => {
    it("matches an off-chain abi.encode of the same tuple", async () => {
      const { registry, analyst } = await networkHelpers.loadFixture(deployFixture);

      const deadline = await validDeadline();

      const onChain = await registry.read.computeCommitment([
        BTC_USD,
        ABOVE,
        price(3500n),
        deadline,
        SALT,
        analyst.account.address,
      ]);

      // The frontend has to reproduce this encoding exactly. A divergence does
      // not fail loudly - it produces a commitment that can never be opened and
      // a stake that is lost, so it is pinned here rather than trusted.
      const offChain = keccak256(
        encodeAbiParameters(
          [
            { type: "bytes32" },
            { type: "uint8" },
            { type: "int256" },
            { type: "uint64" },
            { type: "bytes32" },
            { type: "address" },
          ],
          [BTC_USD, ABOVE, price(3500n), deadline, SALT, getAddress(analyst.account.address)],
        ),
      );

      assert.equal(onChain, offChain);
    });

    it("separates two calls that differ only in direction", async () => {
      const { registry, analyst } = await networkHelpers.loadFixture(deployFixture);

      const deadline = await validDeadline();
      const args = [BTC_USD, price(3500n), deadline, SALT, analyst.account.address] as const;

      const above = await registry.read.computeCommitment([
        args[0],
        ABOVE,
        args[1],
        args[2],
        args[3],
        args[4],
      ]);
      const below = await registry.read.computeCommitment([
        args[0],
        BELOW,
        args[1],
        args[2],
        args[3],
        args[4],
      ]);

      assert.notEqual(above, below);
    });

    it("separates two analysts making the identical prediction", async () => {
      const { registry, analyst, other } = await networkHelpers.loadFixture(deployFixture);

      const deadline = await validDeadline();

      const mine = await registry.read.computeCommitment([
        BTC_USD,
        ABOVE,
        price(3500n),
        deadline,
        SALT,
        analyst.account.address,
      ]);
      const theirs = await registry.read.computeCommitment([
        BTC_USD,
        ABOVE,
        price(3500n),
        deadline,
        SALT,
        other.account.address,
      ]);

      // This is what makes a copied commitment unopenable by the copier.
      assert.notEqual(mine, theirs);
    });
  });

  describe("commitCall", () => {
    it("stores the call, assigns id 0 and locks the stake", async () => {
      const { registry, analyst, publicClient } = await networkHelpers.loadFixture(deployFixture);

      const deadline = await validDeadline();
      const commitment = await registry.read.computeCommitment([
        BTC_USD,
        ABOVE,
        price(3500n),
        deadline,
        SALT,
        analyst.account.address,
      ]);

      await registry.write.commitCall([commitment, deadline], {
        account: analyst.account,
        value: MIN_STAKE,
      });

      const call = await registry.read.getCall([0n]);
      assert.equal(getAddress(call.analyst), getAddress(analyst.account.address));
      assert.equal(call.deadline, deadline);
      assert.equal(call.revealWindow, REVEAL_WINDOW);
      assert.equal(call.status, STATUS_COMMITTED);
      assert.equal(call.commitment, commitment);
      assert.equal(call.stake, MIN_STAKE);

      assert.equal(await registry.read.callCount(), 1n);
      assert.equal(await publicClient.getBalance({ address: registry.address }), MIN_STAKE);
    });

    it("emits CallCommitted carrying the commit timestamp", async () => {
      const { registry, analyst } = await networkHelpers.loadFixture(deployFixture);

      const deadline = await validDeadline();
      const commitment = await registry.read.computeCommitment([
        BTC_USD,
        ABOVE,
        price(3500n),
        deadline,
        SALT,
        analyst.account.address,
      ]);

      // `committedAt` is not in storage, so the event is the only record of it.
      // Pinning the block timestamp is what makes it assertable at all.
      const at = (await networkHelpers.time.latest()) + 5;
      await networkHelpers.time.setNextBlockTimestamp(at);

      await viem.assertions.emitWithArgs(
        registry.write.commitCall([commitment, deadline], {
          account: analyst.account,
          value: MIN_STAKE,
        }),
        registry,
        "CallCommitted",
        [
          0n,
          getAddress(analyst.account.address),
          commitment,
          MIN_STAKE,
          deadline,
          REVEAL_WINDOW,
          BigInt(at),
        ],
      );
    });

    it("counts the commit against the analyst before anything is revealed", async () => {
      const { registry, analyst } = await networkHelpers.loadFixture(deployFixture);

      const deadline = await validDeadline();
      const commitment = await registry.read.computeCommitment([
        BTC_USD,
        ABOVE,
        price(3500n),
        deadline,
        SALT,
        analyst.account.address,
      ]);

      await registry.write.commitCall([commitment, deadline], {
        account: analyst.account,
        value: MIN_STAKE,
      });

      const stats = await registry.read.getStats([analyst.account.address]);
      assert.equal(stats.committed, 1);
      assert.equal(stats.wins, 0);
      assert.equal(stats.losses, 0);
      assert.equal(stats.forfeited, 0);
    });

    it("assigns sequential ids across analysts", async () => {
      const { registry, analyst, other } = await networkHelpers.loadFixture(deployFixture);

      const deadline = await validDeadline();

      for (const [index, account] of [analyst, other, analyst].entries()) {
        const commitment = keccak256(toHex(`call-${index}`));
        await registry.write.commitCall([commitment, deadline], {
          account: account.account,
          value: MIN_STAKE,
        });
      }

      assert.equal(await registry.read.callCount(), 3n);
      assert.equal(
        getAddress((await registry.read.getCall([1n])).analyst),
        getAddress(other.account.address),
      );
    });

    it("accepts a stake exactly at the minimum", async () => {
      const { registry, analyst } = await networkHelpers.loadFixture(deployFixture);

      const deadline = await validDeadline();
      await registry.write.commitCall([keccak256(toHex("c")), deadline], {
        account: analyst.account,
        value: MIN_STAKE,
      });

      assert.equal(await registry.read.callCount(), 1n);
    });

    it("rejects a stake one wei below the minimum", async () => {
      const { registry, analyst } = await networkHelpers.loadFixture(deployFixture);

      const deadline = await validDeadline();

      await viem.assertions.revertWithCustomError(
        registry.write.commitCall([keccak256(toHex("c")), deadline], {
          account: analyst.account,
          value: MIN_STAKE - 1n,
        }),
        registry,
        "StakeBelowMinimum",
      );
    });

    it("rejects a zero commitment", async () => {
      const { registry, analyst } = await networkHelpers.loadFixture(deployFixture);

      const deadline = await validDeadline();

      // The zero hash is what an uninitialised frontend variable produces. It is
      // also unopenable, so accepting it means accepting a guaranteed forfeit.
      await viem.assertions.revertWithCustomError(
        registry.write.commitCall([ZERO_BYTES32, deadline], {
          account: analyst.account,
          value: MIN_STAKE,
        }),
        registry,
        "InvalidCommitment",
      );
    });

    it("accepts a deadline exactly at minHorizon", async () => {
      const { registry, analyst } = await networkHelpers.loadFixture(deployFixture);

      const at = (await networkHelpers.time.latest()) + 5;
      await networkHelpers.time.setNextBlockTimestamp(at);

      await registry.write.commitCall([keccak256(toHex("c")), BigInt(at + MIN_HORIZON)], {
        account: analyst.account,
        value: MIN_STAKE,
      });

      assert.equal(await registry.read.callCount(), 1n);
    });

    it("rejects a deadline one second inside minHorizon", async () => {
      const { registry, analyst } = await networkHelpers.loadFixture(deployFixture);

      const at = (await networkHelpers.time.latest()) + 5;
      await networkHelpers.time.setNextBlockTimestamp(at);

      // Below roughly an hour the commitment stops hiding anything: the analyst
      // is predicting the next few blocks and the reveal follows immediately.
      await viem.assertions.revertWithCustomError(
        registry.write.commitCall([keccak256(toHex("c")), BigInt(at + MIN_HORIZON - 1)], {
          account: analyst.account,
          value: MIN_STAKE,
        }),
        registry,
        "DeadlineTooSoon",
      );
    });

    it("accepts a deadline exactly at maxHorizon", async () => {
      const { registry, analyst } = await networkHelpers.loadFixture(deployFixture);

      const at = (await networkHelpers.time.latest()) + 5;
      await networkHelpers.time.setNextBlockTimestamp(at);

      await registry.write.commitCall([keccak256(toHex("c")), BigInt(at + MAX_HORIZON)], {
        account: analyst.account,
        value: MIN_STAKE,
      });

      assert.equal(await registry.read.callCount(), 1n);
    });

    it("rejects a deadline one second past maxHorizon", async () => {
      const { registry, analyst } = await networkHelpers.loadFixture(deployFixture);

      const at = (await networkHelpers.time.latest()) + 5;
      await networkHelpers.time.setNextBlockTimestamp(at);

      // The bound exists because a call can outlive its own testnet feed, which
      // strands the stake through no fault of the analyst.
      await viem.assertions.revertWithCustomError(
        registry.write.commitCall([keccak256(toHex("c")), BigInt(at + MAX_HORIZON + 1)], {
          account: analyst.account,
          value: MIN_STAKE,
        }),
        registry,
        "DeadlineTooLate",
      );
    });

    it("rejects the same commitment twice from the same analyst", async () => {
      const { registry, analyst } = await networkHelpers.loadFixture(deployFixture);

      const deadline = await validDeadline();
      const commitment = keccak256(toHex("reused"));

      await registry.write.commitCall([commitment, deadline], {
        account: analyst.account,
        value: MIN_STAKE,
      });

      // Invariant 1. A reuse means the salt was reused, which means the second
      // call is openable by whoever opened the first.
      await viem.assertions.revertWithCustomError(
        registry.write.commitCall([commitment, deadline], {
          account: analyst.account,
          value: MIN_STAKE,
        }),
        registry,
        "CommitmentAlreadyUsed",
      );
    });

    it("lets a different analyst use a hash the first analyst already used", async () => {
      const { registry, analyst, other } = await networkHelpers.loadFixture(deployFixture);

      const deadline = await validDeadline();
      const commitment = keccak256(toHex("reused"));

      await registry.write.commitCall([commitment, deadline], {
        account: analyst.account,
        value: MIN_STAKE,
      });
      await registry.write.commitCall([commitment, deadline], {
        account: other.account,
        value: MIN_STAKE,
      });

      // Uniqueness is scoped per analyst on purpose. Two honest analysts cannot
      // collide - their addresses are in the preimage - so a global mapping
      // would only let a watcher front-run a broadcast commitment and make the
      // victim's own transaction revert.
      assert.equal(await registry.read.callCount(), 2n);
      assert.equal(
        await registry.read.isCommitmentUsed([analyst.account.address, commitment]),
        true,
      );
      assert.equal(await registry.read.isCommitmentUsed([other.account.address, commitment]), true);
    });

    it("keeps the reveal window a call was committed with when the parameter changes", async () => {
      const { registry, analyst } = await networkHelpers.loadFixture(deployFixture);

      const deadline = await validDeadline();
      await registry.write.commitCall([keccak256(toHex("c")), deadline], {
        account: analyst.account,
        value: MIN_STAKE,
      });

      await registry.write.setRevealWindow([ONE_HOUR]);

      // Reading the window live at reveal time would let this setter push an
      // already-open call past its window and force a forfeit on an analyst who
      // did nothing wrong.
      assert.equal((await registry.read.getCall([0n])).revealWindow, REVEAL_WINDOW);
      assert.equal(await registry.read.revealDeadlineOf([0n]), deadline + BigInt(REVEAL_WINDOW));
    });
  });

  describe("pausing", () => {
    it("blocks commits while paused and allows them again after unpausing", async () => {
      const { registry, analyst } = await networkHelpers.loadFixture(deployFixture);

      await registry.write.pause();

      await viem.assertions.revertWithCustomError(
        registry.write.commitCall([keccak256(toHex("c")), await validDeadline()], {
          account: analyst.account,
          value: MIN_STAKE,
        }),
        registry,
        "EnforcedPause",
      );

      await registry.write.unpause();

      await registry.write.commitCall([keccak256(toHex("c")), await validDeadline()], {
        account: analyst.account,
        value: MIN_STAKE,
      });
      assert.equal(await registry.read.callCount(), 1n);
    });

    it("rejects a pause from an account without PAUSER_ROLE", async () => {
      const { registry, other } = await networkHelpers.loadFixture(deployFixture);

      await viem.assertions.revertWithCustomError(
        registry.write.pause({ account: other.account }),
        registry,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("administration", () => {
    it("swaps the resolver and announces both addresses", async () => {
      const { registry, resolver, admin } = await networkHelpers.loadFixture(deployFixture);

      const replacement = await viem.deployContract("PriceOracleResolver", [admin.account.address]);

      await viem.assertions.emitWithArgs(
        registry.write.setResolver([replacement.address]),
        registry,
        "ResolverUpdated",
        [getAddress(resolver.address), getAddress(replacement.address)],
      );

      assert.equal(getAddress(await registry.read.resolver()), getAddress(replacement.address));
    });

    it("retargets the treasury", async () => {
      const { registry, other } = await networkHelpers.loadFixture(deployFixture);

      await registry.write.setTreasury([other.account.address]);

      assert.equal(getAddress(await registry.read.treasury()), getAddress(other.account.address));
    });

    it("rejects a zero minimum stake", async () => {
      const { registry } = await networkHelpers.loadFixture(deployFixture);

      // A free commit makes spraying commitments costless, which is the exact
      // behaviour the stake is there to price.
      await viem.assertions.revertWithCustomError(
        registry.write.setMinStake([0n]),
        registry,
        "InvalidMinStake",
      );
    });

    it("rejects horizons that cross over", async () => {
      const { registry } = await networkHelpers.loadFixture(deployFixture);

      // Set as a pair so there is no intermediate state where min > max and
      // every commit reverts.
      await viem.assertions.revertWithCustomError(
        registry.write.setHorizons([BigInt(2 * ONE_DAY), BigInt(ONE_DAY)]),
        registry,
        "InvalidHorizons",
      );
    });

    it("rejects a zero reveal window", async () => {
      const { registry } = await networkHelpers.loadFixture(deployFixture);

      await viem.assertions.revertWithCustomError(
        registry.write.setRevealWindow([0]),
        registry,
        "InvalidRevealWindow",
      );
    });

    it("rejects every setter from an account without DEFAULT_ADMIN_ROLE", async () => {
      const { registry, resolver, other } = await networkHelpers.loadFixture(deployFixture);

      // Thunks, not promises: building the array eagerly would fire every
      // transaction at once and reject before anything awaits them.
      const calls = [
        () => registry.write.setResolver([resolver.address], { account: other.account }),
        () => registry.write.setTreasury([other.account.address], { account: other.account }),
        () => registry.write.setMinStake([1n], { account: other.account }),
        () =>
          registry.write.setHorizons([BigInt(ONE_HOUR), BigInt(ONE_DAY)], {
            account: other.account,
          }),
        () => registry.write.setRevealWindow([ONE_HOUR], { account: other.account }),
      ];

      for (const call of calls) {
        await viem.assertions.revertWithCustomError(
          call(),
          registry,
          "AccessControlUnauthorizedAccount",
        );
      }
    });
  });

  describe("views", () => {
    it("reports an unknown call as Status.None rather than reverting", async () => {
      const { registry } = await networkHelpers.loadFixture(deployFixture);

      // Callers use this to find out whether a call exists, so reverting would
      // make the question unanswerable.
      assert.equal((await registry.read.getCall([42n])).status, STATUS_NONE);
    });

    it("refuses to report a reveal deadline for a call that does not exist", async () => {
      const { registry } = await networkHelpers.loadFixture(deployFixture);

      await viem.assertions.revertWithCustomError(
        registry.read.revealDeadlineOf([42n]),
        registry,
        "CallNotFound",
      );
    });
  });

  describe("invariants", () => {
    it("holds at least the sum of every open stake", async () => {
      const { registry, analyst, other, publicClient } =
        await networkHelpers.loadFixture(deployFixture);

      const deadline = await validDeadline();
      const stakes = [MIN_STAKE, parseEther("0.05"), parseEther("0.2")];

      for (const [index, stake] of stakes.entries()) {
        await registry.write.commitCall([keccak256(toHex(`i-${index}`)), deadline], {
          account: (index % 2 === 0 ? analyst : other).account,
          value: stake,
        });
      }

      // Invariant 6, stated as `>=` and not `==` on purpose: selfdestruct and
      // block rewards can push ETH into a contract without touching any of its
      // code, so equality is falsifiable by an outsider while solvency is not.
      let openStake = 0n;
      const count = await registry.read.callCount();
      for (let id = 0n; id < count; id++) {
        const call = await registry.read.getCall([id]);
        if (call.status === STATUS_COMMITTED) openStake += call.stake;
      }

      assert.equal(
        openStake,
        stakes.reduce((a, b) => a + b, 0n),
      );
      assert.ok((await publicClient.getBalance({ address: registry.address })) >= openStake);
    });

    it("refuses plain ETH transfers", async () => {
      const { registry, analyst } = await networkHelpers.loadFixture(deployFixture);

      // No `receive` and no `fallback`. Every wei in this contract arrives
      // through `commitCall` and is accounted for by a call.
      await assert.rejects(analyst.sendTransaction({ to: registry.address, value: MIN_STAKE }));
    });
  });
});
