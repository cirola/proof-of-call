import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress, keccak256, parseEther, toHex } from "viem";
import { network } from "hardhat";

import ProofOfCall from "../ignition/modules/ProofOfCall.js";

const { viem, ignition } = await network.getOrCreate();

const BTC_USD = keccak256(toHex("BTC/USD"));
const ETH_USD = keccak256(toHex("ETH/USD"));

const TWO_HOURS = 2 * 60 * 60;

/**
 * Runs the real Ignition module against the simulated network.
 *
 * A deployment script that has never been executed is a guess, and the place it
 * fails is Sepolia, after gas has been spent and with a half-configured
 * protocol on chain. The only substitution here is the two feed addresses: the
 * module's defaults are the Chainlink proxies on Sepolia, which have no code
 * locally and would fail `setFeed`'s `decimals()` probe. Everything else - the
 * order, the constructor wiring, the asset ids - is exactly what Sepolia gets.
 */
describe("ProofOfCall deployment module", () => {
  it("deploys both contracts, wires them together and registers both feeds", async () => {
    const [deployer] = await viem.getWalletClients();

    const btcFeed = await viem.deployContract("MockV3Aggregator", [8, 60_000n * 10n ** 8n]);
    const ethFeed = await viem.deployContract("MockV3Aggregator", [8, 3_000n * 10n ** 8n]);

    const { resolver, registry } = await ignition.deploy(ProofOfCall, {
      parameters: {
        ProofOfCall: {
          btcUsdFeed: btcFeed.address,
          ethUsdFeed: ethFeed.address,
        },
      },
    });

    // The registry must be pointing at the resolver this run produced, not at
    // whatever address happened to be left in a previous deployment journal.
    assert.equal(getAddress(await registry.read.resolver()), getAddress(resolver.address));

    assert.equal(await resolver.read.isSupported([BTC_USD]), true);
    assert.equal(await resolver.read.isSupported([ETH_USD]), true);

    const [btcAggregator, btcStaleAfter] = await resolver.read.getFeedConfig([BTC_USD]);
    assert.equal(getAddress(btcAggregator), getAddress(btcFeed.address));
    assert.equal(btcStaleAfter, TWO_HOURS);

    const adminRole = await registry.read.DEFAULT_ADMIN_ROLE();
    assert.equal(await registry.read.hasRole([adminRole, deployer.account.address]), true);
    assert.equal(await resolver.read.hasRole([adminRole, deployer.account.address]), true);

    // The protocol is usable the moment the module finishes: a commit needs no
    // further admin transaction.
    assert.equal(await registry.read.minStake(), parseEther("0.001"));
    assert.equal(await registry.read.callCount(), 0n);
  });
});
