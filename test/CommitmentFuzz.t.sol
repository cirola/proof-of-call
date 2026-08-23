// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {CallRegistry} from "../contracts/CallRegistry.sol";
import {IPriceResolver} from "../contracts/interfaces/IPriceResolver.sol";
import {PriceOracleResolver} from "../contracts/PriceOracleResolver.sol";

/// @title CommitmentFuzzTest
/// @author Ciro Urrustarazu
/// @notice Property tests over the commitment, run in Solidity so the fuzzer
///         drives the same code path a caller would.
/// @dev The TypeScript suite asserts named scenarios: this asset, that price,
///      that boundary. It cannot say anything about the inputs nobody thought
///      to write down, and the commitment is exactly the value where an
///      unthought-of input matters — a collision there is a stolen call, and a
///      binding that is weaker than advertised is an editable prediction.
///
///      Every test here states a property that must hold for all inputs, and
///      lets the fuzzer look for the counterexample.
contract CommitmentFuzzTest is Test {
    CallRegistry private registry;

    address private constant ANALYST = address(0xA11CE);
    address private constant TREASURY = address(0xBEEF);

    function setUp() public {
        PriceOracleResolver resolver = new PriceOracleResolver(address(this));
        registry = new CallRegistry(address(this), TREASURY, IPriceResolver(address(resolver)));
    }

    /// @dev The salt is the entire defence against brute force (attack B in the
    ///      README): the other five fields have a small, very guessable joint
    ///      domain. If two salts could produce one commitment, an attacker who
    ///      guessed the prediction could confirm the guess.
    function testFuzz_saltAloneSeparatesIdenticalPredictions(bytes32 saltA, bytes32 saltB) public view {
        vm.assume(saltA != saltB);

        bytes32 a = registry.computeCommitment(
            keccak256("BTC/USD"),
            CallRegistry.Direction.Above,
            3_500e8,
            uint64(block.timestamp + 1 days),
            saltA,
            ANALYST
        );
        bytes32 b = registry.computeCommitment(
            keccak256("BTC/USD"),
            CallRegistry.Direction.Above,
            3_500e8,
            uint64(block.timestamp + 1 days),
            saltB,
            ANALYST
        );

        assertTrue(a != b, "distinct salts collided");
    }

    /// @dev What stops a watcher from lifting the plaintext out of somebody
    ///      else's reveal in the mempool and opening a commitment they copied
    ///      earlier. If the analyst did not separate two otherwise identical
    ///      commitments, the copy would be openable by the copier.
    function testFuzz_analystSeparatesIdenticalPredictions(address analystA, address analystB) public view {
        vm.assume(analystA != analystB);

        bytes32 salt = keccak256("fixed");

        bytes32 a = registry.computeCommitment(
            keccak256("BTC/USD"),
            CallRegistry.Direction.Above,
            3_500e8,
            uint64(block.timestamp + 1 days),
            salt,
            analystA
        );
        bytes32 b = registry.computeCommitment(
            keccak256("BTC/USD"),
            CallRegistry.Direction.Above,
            3_500e8,
            uint64(block.timestamp + 1 days),
            salt,
            analystB
        );

        assertTrue(a != b, "distinct analysts collided");
    }

    /// @dev A prediction is only unforgeable if the target it names is part of
    ///      what was fixed. Two targets that hashed alike would let an analyst
    ///      reveal a number they never committed to.
    function testFuzz_targetPriceIsBound(int256 targetA, int256 targetB) public view {
        vm.assume(targetA != targetB);

        bytes32 salt = keccak256("fixed");
        uint64 deadline = uint64(block.timestamp + 1 days);

        bytes32 a = registry.computeCommitment(
            keccak256("BTC/USD"),
            CallRegistry.Direction.Above,
            targetA,
            deadline,
            salt,
            ANALYST
        );
        bytes32 b = registry.computeCommitment(
            keccak256("BTC/USD"),
            CallRegistry.Direction.Above,
            targetB,
            deadline,
            salt,
            ANALYST
        );

        assertTrue(a != b, "distinct targets collided");
    }

    /// @dev Commit accepts anything inside the envelope and stores it verbatim.
    ///      The fuzzer roams over the stake and the horizon, which are the two
    ///      fields a caller controls numerically.
    function testFuzz_commitStoresWhatWasSubmitted(bytes32 commitment, uint96 stake, uint32 horizon) public {
        vm.assume(commitment != bytes32(0));
        stake = uint96(bound(stake, registry.minStake(), 100 ether));
        horizon = uint32(bound(horizon, registry.minHorizon(), registry.maxHorizon()));

        uint64 deadline = uint64(block.timestamp + horizon);

        vm.deal(ANALYST, stake);
        vm.prank(ANALYST);
        uint256 callId = registry.commitCall{value: stake}(commitment, deadline);

        CallRegistry.Call memory stored = registry.getCall(callId);

        assertEq(stored.analyst, ANALYST, "analyst");
        assertEq(stored.commitment, commitment, "commitment");
        assertEq(stored.stake, stake, "stake");
        assertEq(stored.deadline, deadline, "deadline");
        assertEq(uint8(stored.status), uint8(CallRegistry.Status.Committed), "status");

        // Invariant 6, in its `>=` form: `selfdestruct` and block rewards can
        // push ETH in without touching any code here, so solvency is the real
        // property and equality is merely the usual case.
        assertGe(address(registry).balance, stored.stake, "solvency");
    }

    /// @dev The point of the whole contract, as a property rather than a
    ///      scenario: whatever the analyst committed to, revealing a *different*
    ///      target cannot open it. The commitment check runs before the oracle
    ///      is touched, so this needs no price feed.
    function testFuzz_revealRejectsAnAlteredTarget(int256 committedTarget, int256 revealedTarget) public {
        vm.assume(committedTarget != revealedTarget);

        bytes32 assetId = keccak256("BTC/USD");
        bytes32 salt = keccak256("fixed");
        uint64 deadline = uint64(block.timestamp + 1 days);

        bytes32 commitment = registry.computeCommitment(
            assetId,
            CallRegistry.Direction.Above,
            committedTarget,
            deadline,
            salt,
            ANALYST
        );

        // `minStake()` is read before the prank on purpose: an external call in
        // the argument list would spend the one-shot prank, and the commit would
        // silently be made by this test contract instead of by ANALYST.
        uint256 stake = registry.minStake();

        vm.deal(ANALYST, 1 ether);
        vm.prank(ANALYST);
        uint256 callId = registry.commitCall{value: stake}(commitment, deadline);

        vm.warp(deadline);

        CallRegistry.RevealParams memory params = CallRegistry.RevealParams({
            assetId: assetId,
            direction: CallRegistry.Direction.Above,
            targetPrice: revealedTarget,
            salt: salt,
            roundId: 1
        });

        // `startPrank`, not `prank`: a one-shot prank is spent by the
        // `expectPartialRevert` cheatcode call that has to come first.
        vm.startPrank(ANALYST);
        vm.expectPartialRevert(CallRegistry.CommitmentMismatch.selector);
        registry.revealCall(callId, params);
        vm.stopPrank();
    }

    /// @dev An analyst cannot spend the same salt twice. A reuse means the
    ///      second call is openable by whoever opened the first.
    function testFuzz_aCommitmentCannotBeSpentTwice(bytes32 commitment) public {
        vm.assume(commitment != bytes32(0));

        uint64 deadline = uint64(block.timestamp + 1 days);
        uint256 stake = registry.minStake();

        vm.deal(ANALYST, 10 ether);

        vm.prank(ANALYST);
        registry.commitCall{value: stake}(commitment, deadline);

        vm.startPrank(ANALYST);
        vm.expectPartialRevert(CallRegistry.CommitmentAlreadyUsed.selector);
        registry.commitCall{value: stake}(commitment, deadline);
        vm.stopPrank();
    }
}
