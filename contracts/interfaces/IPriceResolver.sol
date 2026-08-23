// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IPriceResolver
/// @author Ciro Urrustarazu
/// @notice Minimal price-lookup surface consumed by `CallRegistry`.
/// @dev This interface exists so the registry never learns what an oracle is.
///
///      Two consequences follow from that, and both are load-bearing:
///
///      1. Swapping Chainlink for another source (a different aggregator, a
///         TWAP, a push oracle) is a resolver redeploy plus one setter call on
///         the registry. No registry logic changes.
///      2. Settlement is testable. A mock implementation lets tests drive an
///         exact price at an exact timestamp, which is the only way to assert
///         win/loss and staleness behaviour deterministically.
///
///      Implementations MUST revert rather than return a degraded value. A
///      resolver that returns a stale or zero price on failure would silently
///      settle calls against garbage; a revert leaves the call in `Committed`
///      so the analyst can retry once the feed recovers.
interface IPriceResolver {
    /// @notice Current price of `assetId`, normalized to 8 decimals.
    /// @dev Normalization is the resolver's job, not the caller's: feeds do not
    ///      agree on `decimals()` (USD pairs are typically 8, ETH pairs 18), and
    ///      a caller that assumed 8 would misprice by ten orders of magnitude.
    ///
    ///      MUST revert if the asset is unsupported, if the underlying data is
    ///      stale past the threshold configured for that feed, or if the source
    ///      reports a non-positive price.
    ///
    ///      Returns `int256` rather than `uint256` because the upstream
    ///      Chainlink interface is signed. The value is asserted positive before
    ///      being returned, so callers may treat it as positive — but the type
    ///      is kept signed to avoid a lossy cast at the boundary.
    /// @param assetId Feed identifier, e.g. `keccak256("BTC/USD")`.
    /// @return price Price scaled to 8 decimals. Always `> 0` on success.
    function getPrice(bytes32 assetId) external view returns (int256 price);

    /// @notice Price of `assetId` as of `atTimestamp`, normalized to 8 decimals.
    /// @dev This is the settlement primitive, and `getPrice` is not. A contract
    ///      that settles a dated prediction against the *latest* price settles it
    ///      against whatever moment the revealer chose to send their transaction,
    ///      which hands them a free option over the entire reveal window. The
    ///      full attack is written out in ADR-010.
    ///
    ///      There is no on-chain index from a timestamp to a Chainlink round, so
    ///      `roundId` is supplied by the caller and found off-chain by binary
    ///      search. Implementations MUST NOT trust it: a conforming
    ///      implementation reverts unless the round is the *last* one at or
    ///      before `atTimestamp`, which makes exactly one round acceptable for a
    ///      given timestamp and leaves the caller nothing to cherry-pick.
    ///
    ///      MUST revert if the asset is unsupported, if the round does not exist
    ///      or was never answered, if it postdates `atTimestamp`, if a later
    ///      round also qualifies, if the round is older than the feed's
    ///      staleness threshold relative to `atTimestamp`, or if the price is
    ///      non-positive.
    /// @param assetId Feed identifier, e.g. `keccak256("BTC/USD")`.
    /// @param atTimestamp Unix seconds the price is being asked about. Must not
    ///        be in the future.
    /// @param roundId Candidate round, verified rather than trusted.
    /// @return price Price scaled to 8 decimals. Always `> 0` on success.
    function getPriceAt(bytes32 assetId, uint256 atTimestamp, uint80 roundId) external view returns (int256 price);

    /// @notice Whether a feed is registered for `assetId`.
    /// @dev A `true` result means a feed address is configured — NOT that
    ///      `getPrice` will succeed right now. A registered feed can still be
    ///      stale. Callers that need a usable price must call `getPrice` and
    ///      handle the revert; this function is for validation and UI only.
    /// @param assetId Feed identifier, e.g. `keccak256("BTC/USD")`.
    /// @return supported True if a feed address is registered for `assetId`.
    function isSupported(bytes32 assetId) external view returns (bool supported);
}
