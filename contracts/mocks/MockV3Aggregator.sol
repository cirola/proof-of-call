// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @title MockV3Aggregator
/// @author Ciro Urrustarazu
/// @notice Test-only Chainlink aggregator with full write access to round data.
/// @dev Not deployable to a real network by intent: every field is publicly
///      settable and there is no access control at all.
///
///      This is written by hand rather than imported from the Chainlink package
///      because the settlement tests need to place `updatedAt` at an arbitrary
///      point in the past. Chainlink's own mock stamps `block.timestamp` on
///      every update, which makes the staleness path — the single most important
///      oracle failure mode this project defends against — unreachable in tests.
///
///      It implements the *Chainlink* interface rather than `IPriceResolver` on
///      purpose. Mocking one layer lower means the tests run the real adapter's
///      normalization and freshness logic instead of stubbing it out.
contract MockV3Aggregator is AggregatorV3Interface {
    struct Round {
        int256 answer;
        uint256 startedAt;
        uint256 updatedAt;
        uint80 answeredInRound;
    }

    uint8 private immutable DECIMALS;

    /// @notice Id of the most recent round, returned by `latestRoundData`.
    uint80 public latestRound;

    mapping(uint80 roundId => Round) private _rounds;

    constructor(uint8 decimals_, int256 initialAnswer) {
        DECIMALS = decimals_;
        _push(initialAnswer, block.timestamp);
    }

    // --------------------------------------------------------------------
    // Test controls
    // --------------------------------------------------------------------

    /// @notice Append a new round with `answer`, stamped at the current block time.
    function updateAnswer(int256 answer) external {
        _push(answer, block.timestamp);
    }

    /// @notice Overwrite every field of an arbitrary round.
    /// @dev The escape hatch for the adversarial cases: a round that was never
    ///      answered (`updatedAt == 0`), a timestamp in the future, or an
    ///      `answeredInRound` behind `roundId`.
    function setRoundData(
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) external {
        _rounds[roundId] = Round({
            answer: answer,
            startedAt: startedAt,
            updatedAt: updatedAt,
            answeredInRound: answeredInRound
        });
        if (roundId > latestRound) {
            latestRound = roundId;
        }
    }

    /// @notice Move the latest round's `updatedAt` without touching its answer.
    /// @dev This is how a feed that stopped publishing is simulated: the price
    ///      is still there and still looks valid, it is simply old. A consumer
    ///      that does not check freshness cannot tell the difference.
    function setUpdatedAt(uint256 updatedAt) external {
        _rounds[latestRound].updatedAt = updatedAt;
    }

    // --------------------------------------------------------------------
    // AggregatorV3Interface
    // --------------------------------------------------------------------

    function decimals() external view returns (uint8) {
        return DECIMALS;
    }

    function description() external pure returns (string memory) {
        return "MockV3Aggregator";
    }

    function version() external pure returns (uint256) {
        return 3;
    }

    function getRoundData(
        uint80 roundId_
    )
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        Round memory r = _rounds[roundId_];
        return (roundId_, r.answer, r.startedAt, r.updatedAt, r.answeredInRound);
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        uint80 id = latestRound;
        Round memory r = _rounds[id];
        return (id, r.answer, r.startedAt, r.updatedAt, r.answeredInRound);
    }

    // --------------------------------------------------------------------
    // Internal
    // --------------------------------------------------------------------

    function _push(int256 answer, uint256 timestamp) private {
        uint80 next = latestRound + 1;
        latestRound = next;
        _rounds[next] = Round({answer: answer, startedAt: timestamp, updatedAt: timestamp, answeredInRound: next});
    }
}
