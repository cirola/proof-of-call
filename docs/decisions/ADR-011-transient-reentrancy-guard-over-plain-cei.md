---
id: ADR-011
title: Keep a transient reentrancy guard even though strict CEI already closes the hole
status: accepted
date: 2026-08-23
phase: F3
tags: [adr, security, reentrancy, gas]
supersedes: []
---

# ADR-011 — Transient reentrancy guard on top of strict CEI

## Context

`revealCall` and `forfeit` both end by sending ETH to an address the protocol
does not control: the analyst on a win, the treasury on a loss or a forfeit.
That is the only point in the system where an outside contract runs code in the
middle of a settlement, and it is the classic shape of a reentrancy bug.

F0 left this as an open question to answer with reasoning rather than reflex:
_is a reentrancy guard actually needed here, or is it cargo cult?_

The honest answer to the narrow question is **no, it is not needed.** Both
functions follow checks-effects-interactions strictly:

1. Every check runs first, including the status check.
2. `status` is written away from `Committed` before `_payout` is called.
3. Only then does control leave the contract.

And the state machine has no path back: `RevealedWin`, `RevealedLoss` and
`Forfeited` are terminal, so a re-entrant call on the same `callId` hits
`CallNotOpen`. A re-entrant call on a _different_ call is not an attack — it is
an ordinary settlement of an unrelated call whose own invariants still hold,
because nothing in either function reads aggregate state. There is no accounting
total to desynchronise, deliberately: the sum of open stakes is derived, not
stored.

So the guard buys nothing against the code as written.

## Decision

Inherit `ReentrancyGuardTransient` anyway, and put `nonReentrant` on both
functions.

The argument is not that the ordering is wrong. It is that **the ordering is the
only thing holding it up**, and its correctness is invisible at the call site. A
future edit that moves the `status` write below the payout, or adds a running
total, or introduces a settlement that touches two calls, reintroduces the bug
silently — nothing about the code announces that its safety depends on line
order.

What makes this cheap enough to be worth it is EIP-1153. The Cancun target is
already set in `hardhat.config.ts`, so `ReentrancyGuardTransient` uses `TSTORE`
and `TLOAD` rather than the 20,000-gas cold `SSTORE` the classic guard costs on
first use. The price of the belt is roughly 100 gas per settlement.

At 20,000 gas this would be a real trade and the answer might be different. At
100 gas, refusing it to make a point about CEI is the expensive choice.

## Consequences

- **The test asserts both layers, and says so.** `ReentrantTreasury` re-enters
  `forfeit` while being paid for a loss, wrapped in `try/catch` so the callback
  failure does not simply bubble up as `StakeTransferFailed`. The test then
  asserts the re-entrant call was rejected, the call reached `RevealedLoss`, and
  the stake moved exactly once. If the guard were removed, `CallNotOpen` would
  still reject it — which is the point: two independent reasons, and the test
  survives either being removed alone.
- **Transient storage carries a composability caveat**, which solc warns about:
  transient slots clear at the end of the _transaction_, not at the end of the
  outer call frame. The OpenZeppelin implementation clears the flag before
  returning, which is the documented safe pattern for exactly this use, so the
  warning does not apply here.
- **This binds the contract to a Cancun-or-later chain.** Sepolia and mainnet
  both qualify. An L2 that has not shipped EIP-1153 would need the classic
  `ReentrancyGuard`, which is a one-line import change and a gas note, not a
  redesign.

## Links

[[ADR-010-settlement-reads-the-round-covering-the-deadline]] ·
[[ADR-003-pause-blocks-commit-only]]
