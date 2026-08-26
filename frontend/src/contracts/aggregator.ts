/**
 * The three functions of `AggregatorV3Interface` the reveal flow actually calls.
 *
 * Hand-written rather than exported from `artifacts/`, because the aggregator is
 * not one of this project's contracts — it is Chainlink's, and pulling in the
 * full `@chainlink/contracts` build output to reach three signatures would tie
 * the frontend bundle to a dependency it does not otherwise have.
 *
 * The registry never touches this. Only the round search does, and only to find
 * the `roundId` that `PriceOracleResolver.getPriceAt` will then verify on-chain.
 * Nothing here is trusted: a wrong round id produces a revert, not a wrong
 * settlement.
 */
export const aggregatorV3Abi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function",
    name: "getRoundData",
    stateMutability: "view",
    inputs: [{ name: "_roundId", type: "uint80" }],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;
