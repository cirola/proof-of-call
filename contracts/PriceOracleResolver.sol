// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

import {IPriceResolver} from "./interfaces/IPriceResolver.sol";

/// @title PriceOracleResolver
/// @author Ciro Urrustarazu
/// @notice Chainlink adapter. Everything oracle-specific in this system lives here.
/// @dev Holds the feed registry, the per-feed freshness policy and the decimal
///      normalization, so `CallRegistry` can consume prices without knowing what
///      an oracle is.
///
///      The contract treats every read from a feed as untrusted and fails
///      closed. A resolver that degraded gracefully — returning the last known
///      price with a warning flag — would settle real stakes against a price
///      that may be hours dead, and the caller would have to remember to check
///      the flag. Reverting removes that possibility: a reveal against an
///      unhealthy feed simply does not execute, and the call stays open for a
///      retry once the feed recovers.
contract PriceOracleResolver is IPriceResolver, AccessControl {
    /// @param aggregator Chainlink aggregator (or its proxy) for this asset.
    /// @param staleAfter Seconds after which this feed's data is refused.
    /// @dev 20 + 4 bytes, so a feed configuration is exactly one storage slot.
    ///      `staleAfter` is per feed, not global, because heartbeats differ
    ///      between feeds: a single threshold is either too strict for the slow
    ///      feed or too permissive for the fast one, and there is no value that
    ///      is correct for both.
    struct FeedConfig {
        AggregatorV3Interface aggregator;
        uint32 staleAfter;
    }

    /// @notice Decimal scale every price is normalized to before leaving this contract.
    uint8 public constant PRICE_DECIMALS = 8;

    /// @dev Upper bound accepted for a feed's own `decimals()`.
    ///
    ///      Normalizing down from `d` decimals divides by `10 ** (d - 8)`. An
    ///      `int256` overflows somewhere past `10 ** 76`, so an absurd value
    ///      would turn every `getPrice` into an arithmetic panic. No production
    ///      feed exceeds 18; 36 leaves generous headroom while still rejecting
    ///      a garbage address that happens to answer `decimals()`.
    uint8 private constant MAX_FEED_DECIMALS = 36;

    mapping(bytes32 assetId => FeedConfig) private _feeds;

    /// @notice Emitted when a feed is registered or reconfigured.
    /// @dev `assetId` and `aggregator` are indexed so a deployment can be audited
    ///      from logs: which address was pointed at which asset, and when.
    ///      `staleAfter` is deliberately not indexed: nobody filters logs by a
    ///      freshness threshold, and an extra topic costs gas on every write.
    /// @param assetId Identifier of the configured asset.
    /// @param aggregator Aggregator address now backing the asset.
    /// @param staleAfter Freshness threshold in seconds.
    event FeedConfigured(bytes32 indexed assetId, address indexed aggregator, uint32 staleAfter);

    /// @notice Emitted when a feed is de-registered.
    /// @param assetId Identifier of the removed asset.
    /// @param aggregator Aggregator address that was backing it.
    event FeedRemoved(bytes32 indexed assetId, address indexed aggregator);

    error InvalidAdmin();
    error InvalidAssetId();
    error InvalidAggregator();
    error InvalidStalenessThreshold();
    error AggregatorProbeFailed(address aggregator);
    error UnsupportedDecimals(address aggregator, uint8 feedDecimals);
    error FeedNotConfigured(bytes32 assetId);
    error RoundNotComplete(bytes32 assetId, uint80 roundId);
    error FutureTimestamp(bytes32 assetId, uint256 updatedAt, uint256 blockTimestamp);
    error StalePrice(bytes32 assetId, uint256 updatedAt, uint256 staleAfter, uint256 blockTimestamp);
    error NonPositivePrice(bytes32 assetId, int256 answer);
    error RoundAfterTimestamp(bytes32 assetId, uint80 roundId, uint256 updatedAt, uint256 atTimestamp);
    error StaleRoundForTimestamp(
        bytes32 assetId,
        uint80 roundId,
        uint256 updatedAt,
        uint256 staleAfter,
        uint256 atTimestamp
    );
    error LaterRoundAvailable(bytes32 assetId, uint80 roundId, uint256 nextUpdatedAt, uint256 atTimestamp);

    /// @notice Deploy the resolver with an initial administrator.
    /// @param admin Account receiving `DEFAULT_ADMIN_ROLE`.
    /// @dev The zero-address check matters more than it looks: `AccessControl`
    ///      grants no role by default, so deploying with `address(0)` would
    ///      produce a resolver whose feeds can never be configured and which
    ///      therefore has to be redeployed.
    constructor(address admin) {
        if (admin == address(0)) revert InvalidAdmin();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // --------------------------------------------------------------------
    // Administration
    // --------------------------------------------------------------------

    /// @notice Register or reconfigure the feed backing `assetId`.
    /// @dev Registering a feed and setting its freshness policy is one atomic
    ///      operation, which makes the "feed registered, threshold still zero"
    ///      state unreachable — a threshold of zero would refuse every price.
    ///
    ///      The `decimals()` probe is the point of this function. A mistyped
    ///      aggregator address is a realistic deployment error, and without the
    ///      probe it stays invisible until the first reveal, when it surfaces as
    ///      a failed settlement instead of a failed configuration transaction.
    /// @param assetId Identifier, e.g. `keccak256("BTC/USD")`.
    /// @param aggregator Chainlink aggregator or proxy address.
    /// @param staleAfter Seconds of age after which this feed's data is refused.
    function setFeed(bytes32 assetId, address aggregator, uint32 staleAfter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (assetId == bytes32(0)) revert InvalidAssetId();
        if (aggregator == address(0)) revert InvalidAggregator();
        if (staleAfter == 0) revert InvalidStalenessThreshold();

        uint8 feedDecimals;
        try AggregatorV3Interface(aggregator).decimals() returns (uint8 d) {
            feedDecimals = d;
        } catch {
            revert AggregatorProbeFailed(aggregator);
        }
        if (feedDecimals > MAX_FEED_DECIMALS) revert UnsupportedDecimals(aggregator, feedDecimals);

        _feeds[assetId] = FeedConfig({aggregator: AggregatorV3Interface(aggregator), staleAfter: staleAfter});

        emit FeedConfigured(assetId, aggregator, staleAfter);
    }

    /// @notice De-register the feed backing `assetId`.
    /// @dev Reverts on an unconfigured asset rather than succeeding silently, so
    ///      a typo in an admin transaction is visible instead of being mistaken
    ///      for a completed removal.
    /// @param assetId Identifier of the feed to remove.
    function removeFeed(bytes32 assetId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        address aggregator = address(_feeds[assetId].aggregator);
        if (aggregator == address(0)) revert FeedNotConfigured(assetId);

        delete _feeds[assetId];

        emit FeedRemoved(assetId, aggregator);
    }

    // --------------------------------------------------------------------
    // IPriceResolver
    // --------------------------------------------------------------------

    /// @inheritdoc IPriceResolver
    /// @dev Checks run freshness first and content second, deliberately: a price
    ///      from a dead feed is meaningless whether or not the number looks
    ///      plausible, and the resulting error names the actual problem.
    ///
    ///      `answeredInRound` is intentionally NOT checked. That field belongs to
    ///      the pre-OCR aggregator design; on every current feed it equals
    ///      `roundId` unconditionally, so the classic
    ///      `require(answeredInRound >= roundId)` can never fire and buys nothing
    ///      but the appearance of rigour. `updatedAt == 0` is checked instead,
    ///      which does catch a real failure: a round that was started and never
    ///      answered.
    function getPrice(bytes32 assetId) external view returns (int256 price) {
        FeedConfig memory config = _feeds[assetId];
        if (address(config.aggregator) == address(0)) revert FeedNotConfigured(assetId);

        (uint80 roundId, int256 answer, , uint256 updatedAt, ) = config.aggregator.latestRoundData();

        if (updatedAt == 0) revert RoundNotComplete(assetId, roundId);

        // A timestamp ahead of the block would make the staleness subtraction
        // below underflow into an opaque arithmetic panic. Rejecting it up front
        // turns a nonsensical feed into a named error instead.
        if (updatedAt > block.timestamp) revert FutureTimestamp(assetId, updatedAt, block.timestamp);

        if (block.timestamp - updatedAt > config.staleAfter) {
            revert StalePrice(assetId, updatedAt, config.staleAfter, block.timestamp);
        }

        if (answer <= 0) revert NonPositivePrice(assetId, answer);

        return _normalize(answer, config.aggregator.decimals());
    }

    /// @inheritdoc IPriceResolver
    /// @dev The four validations below are not interchangeable, and the last one
    ///      is the reason this function exists at all.
    ///
    ///      Accepting any round at or before `atTimestamp` would let a revealer
    ///      scan backwards and settle against whichever historical price suits
    ///      them. Requiring that round `roundId + 1` either does not exist or
    ///      postdates `atTimestamp` pins the answer: for a given timestamp
    ///      exactly one round satisfies both bounds, so the caller supplies a
    ///      lookup key and gets no discretion with it.
    ///
    ///      `roundId + 1` cannot cross a Chainlink phase boundary — a round id is
    ///      `(phaseId << 64) | aggregatorRoundId`, so the successor of the last
    ///      round of a phase is not the first round of the next one. The
    ///      staleness bound caps the resulting gap at one heartbeat on the single
    ///      call whose deadline lands inside an aggregator rotation. Written up
    ///      in ADR-010 rather than papered over.
    function getPriceAt(bytes32 assetId, uint256 atTimestamp, uint80 roundId) external view returns (int256) {
        FeedConfig memory config = _feeds[assetId];
        if (address(config.aggregator) == address(0)) revert FeedNotConfigured(assetId);

        // Asking about the future is a caller bug, and answering it would let a
        // deadline that has not arrived yet settle against the present price.
        if (atTimestamp > block.timestamp) revert FutureTimestamp(assetId, atTimestamp, block.timestamp);

        (int256 answer, uint256 updatedAt) = _readRound(config.aggregator, roundId);

        if (updatedAt == 0) revert RoundNotComplete(assetId, roundId);
        if (updatedAt > atTimestamp) revert RoundAfterTimestamp(assetId, roundId, updatedAt, atTimestamp);

        if (atTimestamp - updatedAt > config.staleAfter) {
            revert StaleRoundForTimestamp(assetId, roundId, updatedAt, config.staleAfter, atTimestamp);
        }

        if (answer <= 0) revert NonPositivePrice(assetId, answer);

        if (roundId != type(uint80).max) {
            (, uint256 nextUpdatedAt) = _readRound(config.aggregator, roundId + 1);
            if (nextUpdatedAt != 0 && nextUpdatedAt <= atTimestamp) {
                revert LaterRoundAvailable(assetId, roundId, nextUpdatedAt, atTimestamp);
            }
        }

        return _normalize(answer, config.aggregator.decimals());
    }

    /// @inheritdoc IPriceResolver
    function isSupported(bytes32 assetId) external view returns (bool supported) {
        return address(_feeds[assetId].aggregator) != address(0);
    }

    /// @notice Read the stored configuration for `assetId`.
    /// @dev Exposed for deployment verification and for the frontend. Returns
    ///      zero values for an unconfigured asset rather than reverting, because
    ///      callers use it precisely to find out whether an asset is configured.
    /// @param assetId Identifier to look up.
    /// @return aggregator Configured aggregator address, or `address(0)`.
    /// @return staleAfter Configured freshness threshold in seconds, or `0`.
    function getFeedConfig(bytes32 assetId) external view returns (address aggregator, uint32 staleAfter) {
        FeedConfig memory config = _feeds[assetId];
        return (address(config.aggregator), config.staleAfter);
    }

    // --------------------------------------------------------------------
    // Internal
    // --------------------------------------------------------------------

    /// @dev Read one historical round, reporting absence as `updatedAt == 0`
    ///      rather than as a revert.
    ///
    ///      Aggregators disagree about how a missing round fails: the current
    ///      implementations revert with `"No data present"`, older ones return a
    ///      zeroed tuple. `getPriceAt` has to distinguish "no such round" from
    ///      "bad round" in two different places — once to reject the round the
    ///      caller supplied, once to accept the *absence* of a successor as proof
    ///      the round is the latest — so both shapes are collapsed here into the
    ///      single sentinel the caller can branch on.
    function _readRound(
        AggregatorV3Interface aggregator,
        uint80 roundId
    ) private view returns (int256 answer, uint256 updatedAt) {
        try aggregator.getRoundData(roundId) returns (uint80, int256 a, uint256, uint256 u, uint80) {
            return (a, u);
        } catch {
            return (0, 0);
        }
    }

    /// @dev Rescale `answer` from `feedDecimals` to `PRICE_DECIMALS`.
    ///
    ///      `decimals()` is read live on every call rather than cached at
    ///      registration. Caching would save one `STATICCALL` per settlement,
    ///      but a cache that disagreed with the feed would misprice by orders of
    ///      magnitude and settle stakes against the wrong number without
    ///      reverting. Paying a few thousand gas once per reveal to remove a
    ///      silent-corruption path is the right side of that trade.
    ///
    ///      Scaling down truncates: a feed with more than 8 decimals loses the
    ///      excess precision. That is acceptable here because targets are quoted
    ///      in USD at 8 decimals, so the discarded digits are far below any
    ///      price a human would name. Scaling up cannot lose information, and
    ///      overflows revert under checked arithmetic.
    function _normalize(int256 answer, uint8 feedDecimals) private pure returns (int256) {
        if (feedDecimals == PRICE_DECIMALS) return answer;

        if (feedDecimals < PRICE_DECIMALS) {
            return answer * int256(10 ** uint256(PRICE_DECIMALS - feedDecimals));
        }

        return answer / int256(10 ** uint256(feedDecimals - PRICE_DECIMALS));
    }
}
