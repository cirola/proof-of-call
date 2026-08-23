// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CallRegistry} from "../CallRegistry.sol";

/// @title EthRejecter
/// @author Ciro Urrustarazu
/// @notice Test-only analyst account that cannot receive ETH.
/// @dev No `receive` and no `fallback`, plus forwarders so it can commit and
///      reveal a call of its own. Stands in for the realistic version: a
///      contract wallet or multisig whose fallback happens to revert.
///
///      What it proves is that the payout failure is loud. An unchecked
///      `call{value:}` would mark the call settled and quietly keep the money;
///      here the whole reveal reverts and the call stays open.
///
///      The real registry is imported rather than a hand-written interface, so
///      a change to the reveal signature breaks the compile instead of silently
///      encoding the wrong calldata.
contract EthRejecter {
    function commit(
        CallRegistry registry,
        bytes32 commitment,
        uint64 deadline
    ) external payable returns (uint256 callId) {
        return registry.commitCall{value: msg.value}(commitment, deadline);
    }

    function reveal(CallRegistry registry, uint256 callId, CallRegistry.RevealParams calldata params) external {
        registry.revealCall(callId, params);
    }
}
