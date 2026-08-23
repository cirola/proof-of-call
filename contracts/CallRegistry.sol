// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

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
contract CallRegistry is AccessControl, Pausable, ReentrancyGuardTransient {
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

    /// @param assetId Feed identifier the call was made against.
    /// @param direction Side of the target that was claimed.
    /// @param targetPrice Target, at 8 decimals.
    /// @param salt Salt used at commit time.
    /// @param roundId Chainlink round covering the deadline, found off-chain.
    /// @dev The plaintext of a call, passed to `revealCall` as one `calldata`
    ///      struct rather than as five arguments.
    ///
    ///      The first four fields are the preimage minus the parts the contract
    ///      already knows — `deadline` and `analyst` come from storage, so they
    ///      cannot be made to disagree with what was committed. `roundId` is not
    ///      part of the preimage at all: it is a lookup key for the settlement
    ///      round, it is not knowable at commit time, and the resolver verifies
    ///      it rather than trusting it (ADR-010).
    ///
    ///      Grouping them is also what keeps `revealCall` inside the EVM's
    ///      sixteen-slot stack limit without turning on the optimizer, which the
    ///      default build profile leaves off so coverage and stack traces stay
    ///      accurate.
    struct RevealParams {
        bytes32 assetId;
        Direction direction;
        int256 targetPrice;
        bytes32 salt;
        uint80 roundId;
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

    /// @notice Starting minimum stake, fixed in ADR-009. Admin-settable afterwards.
    uint256 public constant INITIAL_MIN_STAKE = 0.001 ether;

    /// @notice Starting minimum horizon, fixed in ADR-009. Admin-settable afterwards.
    uint64 public constant INITIAL_MIN_HORIZON = 1 hours;

    /// @notice Starting maximum horizon, fixed in ADR-009. Admin-settable afterwards.
    uint64 public constant INITIAL_MAX_HORIZON = 30 days;

    /// @notice Starting reveal window, fixed in ADR-009. Admin-settable afterwards.
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

    /// @notice Emitted when a call is opened and settled.
    /// @dev Carries the settlement price as well as the outcome, so the record
    ///      can be audited without re-deriving which round the contract read.
    /// @param callId Call that was revealed.
    /// @param analyst Account that made it.
    /// @param assetId Feed the call was made against.
    /// @param direction Side of the target that was claimed.
    /// @param targetPrice Target, at 8 decimals.
    /// @param settlementPrice Price at the deadline, at 8 decimals.
    /// @param won Whether the prediction was correct.
    event CallRevealed(
        uint256 indexed callId,
        address indexed analyst,
        bytes32 indexed assetId,
        Direction direction,
        int256 targetPrice,
        int256 settlementPrice,
        bool won
    );

    /// @notice Emitted when a call is closed unrevealed and its stake slashed.
    /// @param callId Call that was forfeited.
    /// @param analyst Account that let the window close.
    /// @param caller Whoever settled it, which need not be the analyst.
    /// @param stake Stake sent to the treasury.
    event CallForfeited(uint256 indexed callId, address indexed analyst, address indexed caller, uint256 stake);

    /// @notice Emitted for every movement of ETH out of the contract.
    /// @param callId Call the money belonged to.
    /// @param recipient Analyst on a win, treasury on a loss or forfeit.
    /// @param amount Amount transferred, in wei.
    event StakeSettled(uint256 indexed callId, address indexed recipient, uint256 amount);

    /// @notice Emitted when settlement is pointed at a different oracle adapter.
    /// @param previousResolver Adapter in use until this transaction.
    /// @param newResolver Adapter used from now on.
    event ResolverUpdated(address indexed previousResolver, address indexed newResolver);

    /// @notice Emitted when the recipient of slashed stakes changes.
    /// @param previousTreasury Recipient until this transaction.
    /// @param newTreasury Recipient from now on.
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);

    /// @notice Emitted when the minimum stake changes.
    /// @param previousMinStake Minimum until this transaction, in wei.
    /// @param newMinStake Minimum from now on, in wei.
    event MinStakeUpdated(uint256 previousMinStake, uint256 newMinStake);

    /// @notice Emitted when the allowed commit-to-deadline distance changes.
    /// @param minHorizon New lower bound in seconds.
    /// @param maxHorizon New upper bound in seconds.
    event HorizonsUpdated(uint64 minHorizon, uint64 maxHorizon);

    /// @notice Emitted when the reveal window for future commits changes.
    /// @dev Open calls are unaffected: they carry their own snapshot.
    /// @param previousRevealWindow Window until this transaction, in seconds.
    /// @param newRevealWindow Window applied to commits from now on, in seconds.
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
    error CallNotOpen(uint256 callId, Status status);
    error NotAnalyst(uint256 callId, address caller, address analyst);
    error TooEarlyToReveal(uint256 callId, uint64 deadline, uint256 blockTimestamp);
    error RevealWindowClosed(uint256 callId, uint256 revealDeadline, uint256 blockTimestamp);
    error RevealWindowStillOpen(uint256 callId, uint256 revealDeadline, uint256 blockTimestamp);
    error CommitmentMismatch(uint256 callId, bytes32 expected, bytes32 recomputed);
    error StakeTransferFailed(uint256 callId, address recipient, uint256 amount);

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
        ++_stats[msg.sender].committed;

        emit CallCommitted(callId, msg.sender, commitment, stake, deadline, window, block.timestamp);
    }

    // --------------------------------------------------------------------
    // Reveal and settlement
    // --------------------------------------------------------------------

    /// @notice Open a committed call and settle it against the oracle.
    /// @dev The order of the checks is the security model, not housekeeping.
    ///
    ///      **Only the analyst may reveal.** The address is inside the preimage,
    ///      so nobody else can produce a matching hash anyway — but rejecting
    ///      early names the failure instead of surfacing it as a confusing
    ///      commitment mismatch.
    ///
    ///      **Never before the deadline.** If an early reveal were legal the
    ///      analyst could watch the price and open only when it already favoured
    ///      them, and the commitment would be decorative.
    ///
    ///      **`deadline` is read from storage, not from calldata.** It was fixed
    ///      at commit time and is bound by the hash, so taking it from the caller
    ///      would only create a way for the two to disagree.
    ///
    ///      **The price comes from the round covering the deadline**, via
    ///      `getPriceAt`, not from the latest round. Settling against the latest
    ///      round would settle against whatever moment the analyst chose to send
    ///      this transaction, which hands them a free option over the whole
    ///      reveal window. ADR-010 writes the attack out in full.
    ///
    ///      Equality is a win for both directions: `Above` wins on
    ///      `price >= target`, `Below` on `price <= target`. Deliberate, and
    ///      documented in ADR-007 — the alternative silently loses calls that
    ///      landed exactly on their target.
    ///
    ///      Checks-effects-interactions is strict: `status` is written before any
    ///      ETH moves, and no path returns a call to `Committed`, so a re-entrant
    ///      call reverts with `CallNotOpen`. The transient reentrancy guard is
    ///      defence in depth on top of that, not the thing holding it up — it
    ///      costs ~100 gas under EIP-1153 and it protects future edits that might
    ///      not preserve the ordering.
    /// @param callId Call to open.
    /// @param params Plaintext of the call, plus the settlement round id.
    function revealCall(uint256 callId, RevealParams calldata params) external nonReentrant {
        Call storage stored = _calls[callId];

        address analyst = _requireOpenAndOwned(callId, stored);
        uint64 deadline = stored.deadline;

        if (block.timestamp < deadline) revert TooEarlyToReveal(callId, deadline, block.timestamp);

        uint256 revealDeadline = uint256(deadline) + stored.revealWindow;
        if (block.timestamp > revealDeadline) revert RevealWindowClosed(callId, revealDeadline, block.timestamp);

        bytes32 recomputed = computeCommitment(
            params.assetId,
            params.direction,
            params.targetPrice,
            deadline,
            params.salt,
            analyst
        );
        if (recomputed != stored.commitment) revert CommitmentMismatch(callId, stored.commitment, recomputed);

        _settle(callId, stored, analyst, params, resolver.getPriceAt(params.assetId, deadline, params.roundId));
    }

    /// @notice Close a call whose reveal window has elapsed, slashing the stake.
    /// @dev Callable by **anyone**, which is the point. Attack A in the README is
    ///      selective reveal: commit a hundred calls, open the three that came in,
    ///      walk away from the rest. If only the analyst could record their own
    ///      forfeit, the unrevealed calls would sit in `Committed` forever and the
    ///      visible record would still be flawless. A third party — a rival, an
    ///      indexer, a bot earning nothing but the tidiness — can settle them.
    ///
    ///      The stake is not the only penalty. `forfeited` goes up in the
    ///      analyst's public record, so a hundred-call spray reads as ninety-seven
    ///      forfeits rather than as three wins.
    ///
    ///      No `whenNotPaused`. A pause that could reach this function would let
    ///      an admin freeze stakes indefinitely.
    /// @param callId Call to forfeit.
    function forfeit(uint256 callId) external nonReentrant {
        Call storage stored = _calls[callId];

        Status status = stored.status;
        if (status == Status.None) revert CallNotFound(callId);
        if (status != Status.Committed) revert CallNotOpen(callId, status);

        uint256 revealDeadline = uint256(stored.deadline) + stored.revealWindow;
        if (block.timestamp <= revealDeadline) {
            revert RevealWindowStillOpen(callId, revealDeadline, block.timestamp);
        }

        address analyst = stored.analyst;
        uint256 stake = stored.stake;

        stored.status = Status.Forfeited;
        ++_stats[analyst].forfeited;

        emit CallForfeited(callId, analyst, msg.sender, stake);

        _payout(callId, treasury, stake);
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

    /// @dev Decide the outcome, write it, and move the stake.
    ///
    ///      Equality is a win for both directions: `Above` wins on
    ///      `price >= target`, `Below` on `price <= target`. Deliberate, and
    ///      documented in ADR-007 — the alternative silently loses calls that
    ///      landed exactly on their target.
    ///
    ///      Effects before interactions, without exception: `status` leaves
    ///      `Committed` before `_payout` hands control to an external address,
    ///      and no path ever returns a call to `Committed`.
    function _settle(
        uint256 callId,
        Call storage stored,
        address analyst,
        RevealParams calldata params,
        int256 settlementPrice
    ) private {
        bool won =
            params.direction == Direction.Above
                ? settlementPrice >= params.targetPrice
                : settlementPrice <= params.targetPrice;

        uint256 stake = stored.stake;
        stored.status = won ? Status.RevealedWin : Status.RevealedLoss;

        if (won) {
            ++_stats[analyst].wins;
        } else {
            ++_stats[analyst].losses;
        }

        emit CallRevealed(callId, analyst, params.assetId, params.direction, params.targetPrice, settlementPrice, won);

        _payout(callId, won ? analyst : treasury, stake);
    }

    /// @dev Send `amount` to `to` and record it, reverting if the transfer fails.
    ///
    ///      `call{value:}` rather than `transfer()`: the 2,300 gas stipend
    ///      `transfer` forwards is not a safety feature, it is a hard-coded
    ///      assumption about opcode pricing that has already been invalidated
    ///      once. A treasury that is a multisig or a splitter needs more than
    ///      that and would be permanently unable to receive a slashed stake.
    ///
    ///      The return value is checked. `call` reports failure by returning
    ///      `false`, not by reverting, so an unchecked call would mark a call
    ///      settled and quietly keep the money.
    ///
    ///      A winning analyst whose address rejects ETH cannot be paid, so their
    ///      reveal reverts and the call eventually forfeits to the treasury.
    ///      Named in the README's limitations rather than worked around with a
    ///      pull-payment escrow, which trades one edge case for a second balance
    ///      to reason about.
    function _payout(uint256 callId, address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert StakeTransferFailed(callId, to, amount);

        emit StakeSettled(callId, to, amount);
    }

    /// @dev Shared entry checks for `revealCall`: the call exists, is still open,
    ///      and belongs to the caller. Returns the analyst so the caller does not
    ///      pay for a second `SLOAD` of the same slot.
    function _requireOpenAndOwned(uint256 callId, Call storage stored) private view returns (address analyst) {
        Status status = stored.status;
        if (status == Status.None) revert CallNotFound(callId);
        if (status != Status.Committed) revert CallNotOpen(callId, status);

        analyst = stored.analyst;
        if (msg.sender != analyst) revert NotAnalyst(callId, msg.sender, analyst);
    }
}
