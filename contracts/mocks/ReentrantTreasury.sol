// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CallRegistry} from "../CallRegistry.sol";

/// @title ReentrantTreasury
/// @author Ciro Urrustarazu
/// @notice Test-only treasury that re-enters the registry while being paid.
/// @dev Settlement hands control to the treasury on every loss and every
///      forfeit. That is the one window in which an external address runs code
///      mid-settlement, and this contract uses it to call `forfeit` on the very
///      call being settled.
///
///      The callback is wrapped in `try/catch` on purpose. Letting it bubble
///      would only prove that *something* failed, and the outer transaction
///      would revert with `StakeTransferFailed` either way - including in a
///      world where the re-entry had succeeded and been rolled back with it.
///      Swallowing it lets the test assert the settlement completed exactly
///      once *and* that the re-entrant call was rejected.
contract ReentrantTreasury {
    CallRegistry public registry;
    uint256 public target;
    bool public armed;

    /// @notice True once a re-entrant `forfeit` has been attempted and rejected.
    bool public reentryReverted;

    /// @notice True if a re-entrant `forfeit` ever succeeded. Must stay false.
    bool public reentrySucceeded;

    /// @notice Point the treasury at a registry and a call to re-enter on.
    function arm(CallRegistry registry_, uint256 callId) external {
        registry = registry_;
        target = callId;
        armed = true;
    }

    receive() external payable {
        if (!armed) return;

        // Disarm first: the forfeit path pays this contract too, so without
        // this the callback recurses until the block gas limit and the test
        // stops proving anything about the guard.
        armed = false;

        try registry.forfeit(target) {
            reentrySucceeded = true;
        } catch {
            reentryReverted = true;
        }
    }
}
