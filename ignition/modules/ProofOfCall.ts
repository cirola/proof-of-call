import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { keccak256, toHex } from "viem";

/**
 * Asset identifiers, hashed exactly the way the contracts and the frontend do.
 *
 * Deriving them here rather than pasting literals is the point: a mistyped
 * `bytes32` would register a feed under an id nothing ever asks for, and the
 * failure would surface as a call that cannot be revealed rather than as a
 * failed deployment.
 */
const BTC_USD = keccak256(toHex("BTC/USD"));
const ETH_USD = keccak256(toHex("ETH/USD"));

/**
 * Deploys the whole protocol and configures both feeds in one run.
 *
 * Everything that differs between networks is a parameter with a Sepolia
 * default, so a mainnet or fork deployment is a parameters file rather than an
 * edit to this module.
 *
 * The feed addresses below are the Chainlink Data Feed proxies on Sepolia. They
 * are proxies on purpose — Chainlink rotates the aggregator behind them, and
 * pinning an aggregator directly would leave the protocol reading a feed that
 * has been retired.
 *
 * `staleAfter` defaults to two hours against a nominal one-hour heartbeat.
 * Testnet feeds are updated on best effort rather than on contract, so a
 * threshold pinned exactly to the heartbeat produces reverts that look like
 * bugs and are really just Sepolia. It is per feed and settable afterwards
 * (ADR-002), so this is a starting value, not a commitment.
 */
export default buildModule("ProofOfCall", (m) => {
  const admin = m.getParameter("admin", m.getAccount(0));
  const treasury = m.getParameter("treasury", m.getAccount(0));

  const btcUsdFeed = m.getParameter("btcUsdFeed", "0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43");
  const ethUsdFeed = m.getParameter("ethUsdFeed", "0x694AA1769357215DE4FAC081bf1f309aDC325306");
  const staleAfter = m.getParameter("staleAfter", 2 * 60 * 60);

  const resolver = m.contract("PriceOracleResolver", [admin]);

  // Both feeds are registered before the registry is deployed, so there is no
  // window in which the registry is live and settlement would revert on a
  // missing feed.
  m.call(resolver, "setFeed", [BTC_USD, btcUsdFeed, staleAfter], { id: "setFeedBtcUsd" });
  m.call(resolver, "setFeed", [ETH_USD, ethUsdFeed, staleAfter], { id: "setFeedEthUsd" });

  const registry = m.contract("CallRegistry", [admin, treasury, resolver]);

  return { resolver, registry };
});
