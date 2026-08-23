// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {IPriceResolver} from "./interfaces/IPriceResolver.sol";

/// @title CallRegistry
/// @author Ciro Urrustarazu
/// @notice Commit-reveal registry for market predictions, settled by an oracle.
/// @dev The contract holds one idea: a prediction that can be edited after the
///      outcome is known is not a prediction. An analyst submits the hash of
///      their call plus a stake, and can later open it — but only into the shape
///      they fixed before they knew how it turned out.
///
///      The registry never learns what an oracle is. It holds an
///      `IPriceResolver` and asks it for the price at a timestamp; everything
///      Chainlink-specific lives behind that seam.
contract CallRegistry is AccessControl, Pausable {
    /// @notice Lifecycle position of a call.
    /// @dev `None` is the zero value and therefore means "no such call", which is
    ///      what makes an unwritten mapping slot distinguishable from a real one
    ///      without a separate existence flag.
    enum Status {
        None,
        Committed,
        RevealedWin,
        RevealedLoss,
        Forfeited
    }

    /// @notice Which side of the target price the analyst claimed.
    /// @dev Deliberately not `Long`/`Short`. Those name a position with scaling
    ///      P&L; this is a binary claim about where a price sits at one instant.
    enum Direction {
        Above,
        Below
    }

    /// @param analyst Account that committed, and the only one that can reveal.
    /// @param deadline Unix second the prediction is about, and the earliest reveal.
    /// @param revealWindow Seconds after `deadline` during which a reveal is legal.
    /// @param status Lifecycle position.
    /// @param commitment `keccak256` of the prediction, see `computeCommitment`.
    /// @param stake ETH locked behind the call.
    /// @dev Three slots. The first is exactly full: 20 + 8 + 3 + 1 = 32 bytes.
    ///
    ///      `revealWindow` is stored **per call**, snapshotted at commit time,
    ///      rather than read live from the protocol parameter at reveal time. An
    ///      admin who shortened the global window would otherwise retroactively
    ///      close the window on calls that were already open, forcing forfeits on
    ///      analysts who had done nothing wrong. `uint24` caps a window at ~194
    ///      days, which is far past any value worth setting, and is what makes it
    ///      fit in the slot at all.
    ///
    ///      `committedAt` is *not* stored: no on-chain path reads it, and a cold
    ///      `SSTORE` to a fourth slot would cost every analyst 20,000 gas to
    ///      serve readers who are reading `CallCommitted` anyway.
    struct Call {
        address analyst;
        uint64 deadline;
        uint24 revealWindow;
        Status status;
        bytes32 commitment;
        uint256 stake;
    }

    /// @notice Public record of an analyst, including the parts they would omit.
    /// @dev Four `uint32` counters, one slot. `uint32` overflows at 4.3 billion
    ///      calls from a single address; arithmetic stays checked, so the
    ///      theoretical overflow reverts rather than resetting a record.
    struct AnalystStats {
        uint32 committed;
        uint32 wins;
        uint32 losses;
        uint32 forfeited;
    }

    /// @notice Role allowed to pause new commits.
    /// @dev Separated from `DEFAULT_ADMIN_ROLE` so the key that can stop the
    ///      protocol in an incident does not have to be the key that can retarget
    ///      the treasury. A pause is an emergency action and wants a hot key; a
    ///      configuration change is not and does not.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Starting parameters, fixed in ADR-009. All are admin-settable.
    uint256 public constant INITIAL_MIN_STAKE = 0.001 ether;
    uint64 public constant INITIAL_MIN_HORIZON = 1 hours;
    uint64 public constant INITIAL_MAX_HORIZON = 30 days;
    uint24 public constant INITIAL_REVEAL_WINDOW = 48 hours;

    /// @notice Oracle adapter used to settle reveals.
    IPriceResolver public resolver;

    /// @notice Recipient of slashed stakes.
    address public treasury;

    // The three window parameters are declared together on purpose: 8 + 8 + 3
    // bytes share one slot, so `commitCall` validates the deadline and snapshots
    // the reveal window from a single SLOAD instead of three.

    /// @notice Shortest allowed distance from now to a call's deadline.
    uint64 public minHorizon;

    /// @notice Longest allowed distance from now to a call's deadline.
    uint64 public maxHorizon;

    /// @notice Reveal window applied to calls committed from now on.
    uint24 public revealWindow;

    /// @notice Minimum ETH that must accompany a commit.
    uint256 public minStake;

    /// @notice Number of calls ever committed. Call ids are `0 .. callCount - 1`.
    uint256 public callCount;

    mapping(uint256 callId => Call) private _calls;
    mapping(address analyst => AnalystStats) private _stats;

    /// @dev Commitment uniqueness is scoped to the analyst, not global.
    ///
    ///      The analyst's address is inside the preimage, so two honest analysts
    ///      can never produce the same commitment and a global mapping would buy
    ///      nothing extra. It would, however, hand out a griefing move: a
    ///      commitment is public the moment it is broadcast, so a watcher could
    ///      front-run it with the identical hash and make the victim's own commit
    ///      revert. Scoping the mapping removes the move and costs the same
    ///      single `SSTORE`.
    mapping(address analyst => mapping(bytes32 commitment => bool)) private _commitmentUsed;

    /// @notice Emitted when a call is committed.
    /// @dev `committedAt` rides in the event because it is not in storage. The
    ///      frontend countdown and the off-chain boldness metric both need it.
    /// @param callId Id assigned to the call.
    /// @param analyst Account that committed it.
    /// @param commitment Hash of the prediction.
    /// @param stake ETH locked behind it.
    /// @param deadline Unix second the prediction is about.
    /// @param revealWindow Reveal window snapshotted for this call.
    /// @param committedAt Block timestamp of the commit.
    event CallCommitted(
        uint256 indexed callId,
        address indexed analyst,
        bytes32 commitment,
        uint256 stake,
        uint64 deadline,
        uint24 revealWindow,
        uint256 committedAt
    );

    event ResolverUpdated(address indexed previousResolver, address indexed newResolver);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event MinStakeUpdated(uint256 previousMinStake, uint256 newMinStake);
    event HorizonsUpdated(uint64 minHorizon, uint64 maxHorizon);
    event RevealWindowUpdated(uint24 previousRevealWindow, uint24 newRevealWindow);

    error InvalidAdmin();
    error InvalidTreasury();
    error InvalidResolver();
    error InvalidCommitment();
    error InvalidMinStake();
    error InvalidHorizons(uint64 minHorizon, uint64 maxHorizon);
    error InvalidRevealWindow();
    error CommitmentAlreadyUsed(address analyst, bytes32 commitment);
    error StakeBelowMinimum(uint256 stake, uint256 minStake);
    error DeadlineTooSoon(uint64 deadline, uint256 earliest);
    error DeadlineTooLate(uint64 deadline, uint256 latest);
    error CallNotFound(uint256 callId);

    /// @notice Deploy the registry.
    /// @param admin Account receiving `DEFAULT_ADMIN_ROLE` and `PAUSER_ROLE`.
    /// @param treasury_ Recipient of slashed stakes.
    /// @param resolver_ Oracle adapter used at settlement.
    /// @dev Protocol parameters start at their ADR-009 values rather than being
    ///      constructor arguments. They are all settable, so passing them in
    ///      would only add four ways for a deployment script to get them wrong.
    constructor(address admin, address treasury_, IPriceResolver resolver_) {
        if (admin == address(0)) revert InvalidAdmin();
        if (treasury_ == address(0)) revert InvalidTreasury();
        if (address(resolver_) == address(0)) revert InvalidResolver();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);

        treasury = treasury_;
        resolver = resolver_;

        minStake = INITIAL_MIN_STAKE;
        minHorizon = INITIAL_MIN_HORIZON;
        maxHorizon = INITIAL_MAX_HORIZON;
        revealWindow = INITIAL_REVEAL_WINDOW;
    }

    // --------------------------------------------------------------------
    // Commit
    // --------------------------------------------------------------------

    /// @notice Lock a stake behind a hidden prediction.
    /// @dev The contract learns nothing about the prediction here. It cannot
    ///      check that the asset is supported, that the target is plausible, or
    ///      that the call is anything but noise — that opacity is the mechanism,
    ///      not a gap in it. Everything validated below is about the envelope:
    ///      the money, the timing, and whether this analyst has used this exact
    ///      commitment before.
    ///
    ///      Because the asset is hidden, an analyst can commit against an asset
    ///      that has no feed. Such a call can never be revealed and will forfeit.
    ///      The frontend only offers configured assets; the contract cannot help.
    /// @param commitment `keccak256` of the prediction, see `computeCommitment`.
    /// @param deadline Unix second the prediction is about.
    /// @return callId Id assigned to the new call.
    function commitCall(bytes32 commitment, uint64 deadline) external payable whenNotPaused returns (uint256 callId) {
        if (commitment == bytes32(0)) revert InvalidCommitment();
        if (_commitmentUsed[msg.sender][commitment]) revert CommitmentAlreadyUsed(msg.sender, commitment);

        uint256 stake = msg.value;
        uint256 minStake_ = minStake;
        if (stake < minStake_) revert StakeBelowMinimum(stake, minStake_);

        uint256 earliest = block.timestamp + minHorizon;
        uint256 latest = block.timestamp + maxHorizon;
        if (deadline < earliest) revert DeadlineTooSoon(deadline, earliest);
        if (deadline > latest) revert DeadlineTooLate(deadline, latest);

        uint24 window = revealWindow;

        callId = callCount;
        callCount = callId + 1;

        _commitmentUsed[msg.sender][commitment] = true;
        _calls[callId] = Call({
            analyst: msg.sender,
            deadline: deadline,
            revealWindow: window,
            status: Status.Committed,
            commitment: commitment,
            stake: stake
        });
        _stats[msg.sender].committed += 1;

        emit CallCommitted(callId, msg.sender, commitment, stake, deadline, window, block.timestamp);
    }

    // --------------------------------------------------------------------
    // Administration
    // --------------------------------------------------------------------

    /// @notice Point settlement at a different oracle adapter.
    /// @dev The sharpest admin power in the system: a hostile resolver controls
    ///      every future settlement. Named as such in the README's trust model
    ///      rather than hidden behind a neutral setter.
    /// @param resolver_ New adapter.
    function setResolver(IPriceResolver resolver_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(resolver_) == address(0)) revert InvalidResolver();

        emit ResolverUpdated(address(resolver), address(resolver_));
        resolver = resolver_;
    }

    /// @notice Change where slashed stakes are sent.
    /// @param treasury_ New recipient.
    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (treasury_ == address(0)) revert InvalidTreasury();

        emit TreasuryUpdated(treasury, treasury_);
        treasury = treasury_;
    }

    /// @notice Change the minimum stake required to commit.
    /// @dev Zero is rejected: a free commit makes spraying commitments costless,
    ///      which is the exact behaviour the stake exists to price.
    /// @param minStake_ New minimum, in wei.
    function setMinStake(uint256 minStake_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (minStake_ == 0) revert InvalidMinStake();

        emit MinStakeUpdated(minStake, minStake_);
        minStake = minStake_;
    }

    /// @notice Change the allowed distance from commit to deadline.
    /// @dev Set as a pair, because they are only meaningful against each other
    ///      and two separate setters admit an intermediate state where
    ///      `minHorizon > maxHorizon` and every commit reverts.
    /// @param minHorizon_ New lower bound in seconds. Must be non-zero.
    /// @param maxHorizon_ New upper bound in seconds. Must be at least the lower bound.
    function setHorizons(uint64 minHorizon_, uint64 maxHorizon_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (minHorizon_ == 0 || maxHorizon_ < minHorizon_) revert InvalidHorizons(minHorizon_, maxHorizon_);

        minHorizon = minHorizon_;
        maxHorizon = maxHorizon_;

        emit HorizonsUpdated(minHorizon_, maxHorizon_);
    }

    /// @notice Change the reveal window applied to calls committed from now on.
    /// @dev Open calls keep the window they were committed with. That is a
    ///      property of the storage layout, not of this function: the window is
    ///      copied into the call at commit time, so there is no code path by
    ///      which this setter can reach one.
    /// @param revealWindow_ New window in seconds. Must be non-zero.
    function setRevealWindow(uint24 revealWindow_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (revealWindow_ == 0) revert InvalidRevealWindow();

        emit RevealWindowUpdated(revealWindow, revealWindow_);
        revealWindow = revealWindow_;
    }

    /// @notice Stop new commits.
    /// @dev Reveals and forfeits are deliberately unaffected. A pause that could
    ///      reach `revealCall` would let an admin run out the reveal window and
    ///      strand user funds, which is a confiscation switch rather than an
    ///      emergency brake.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resume new commits.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // --------------------------------------------------------------------
    // Views
    // --------------------------------------------------------------------

    /// @notice The commitment for a given prediction.
    /// @dev `public` and `pure` so the frontend hashes through the contract
    ///      itself rather than reimplementing the encoding in TypeScript, where a
    ///      divergence would surface as an unrevealable call and a lost stake.
    ///
    ///      `abi.encode`, not `abi.encodePacked`: packed encoding concatenates
    ///      without length information, so distinct tuples can flatten to the
    ///      same bytes. The gas saved is not worth introducing ambiguity into the
    ///      one value the entire protocol rests on.
    ///
    ///      `analyst` is in the preimage so a commitment can only be opened by
    ///      the account that made it. Without it, a watcher who sees a reveal in
    ///      the mempool could take the plaintext parameters and open a commitment
    ///      they had copied earlier, claiming someone else's call.
    /// @param assetId Feed identifier, e.g. `keccak256("BTC/USD")`.
    /// @param direction Side of the target being claimed.
    /// @param targetPrice Target, at 8 decimals.
    /// @param deadline Unix second the prediction is about.
    /// @param salt 256 bits from a CSPRNG.
    /// @param analyst Account that will commit.
    /// @return commitment Hash to pass to `commitCall`.
    function computeCommitment(
        bytes32 assetId,
        Direction direction,
        int256 targetPrice,
        uint64 deadline,
        bytes32 salt,
        address analyst
    ) public pure returns (bytes32 commitment) {
        return keccak256(abi.encode(assetId, direction, targetPrice, deadline, salt, analyst));
    }

    /// @notice Read a call.
    /// @dev Returns a zeroed struct with `status == Status.None` for an id that
    ///      was never used, rather than reverting: callers use this precisely to
    ///      find out whether a call exists.
    /// @param callId Id to read.
    /// @return call The stored call.
    function getCall(uint256 callId) external view returns (Call memory call) {
        return _calls[callId];
    }

    /// @notice Read an analyst's public record.
    /// @param analyst Account to look up.
    /// @return stats Commit, win, loss and forfeit counts.
    function getStats(address analyst) external view returns (AnalystStats memory stats) {
        return _stats[analyst];
    }

    /// @notice Last second at which a call may still be revealed.
    /// @param callId Id to look up.
    /// @return revealDeadline Unix second after which the call is forfeitable.
    function revealDeadlineOf(uint256 callId) external view returns (uint256 revealDeadline) {
        Call memory call = _calls[callId];
        if (call.status == Status.None) revert CallNotFound(callId);
        return uint256(call.deadline) + call.revealWindow;
    }

    /// @notice Whether `analyst` has already used `commitment`.
    /// @param analyst Account to check.
    /// @param commitment Hash to check.
    /// @return used True if the commitment is already taken for that analyst.
    function isCommitmentUsed(address analyst, bytes32 commitment) external view returns (bool used) {
        return _commitmentUsed[analyst][commitment];
    }
}
