---
title: Invariants
status: living
phase: F3
tags: [invariants, security, testing]
updated: 2026-08-23
---

# Invariants

Eight properties the protocol claims. Each one names the code that enforces it
and the test that would fail if it stopped being true, so "we tested that" is a
file and a test name rather than an assertion.

Run them with `npm test`.

---

## 1. A commitment is spent once

An analyst cannot submit the same commitment twice.

**Why it matters.** Two calls sharing a commitment share a preimage, which means
they share a salt. Opening the first publishes the salt, and the second becomes
openable by anyone watching — and openable into a shape its author never chose.

**Enforced by** `_commitmentUsed[msg.sender][commitment]` in `commitCall`.

Uniqueness is scoped **per analyst**, not globally. The analyst's address is in
the preimage, so two honest analysts cannot collide and a global mapping adds
nothing; it would, however, let a watcher front-run a broadcast commitment with
the identical hash and make the victim's own transaction revert.

**Pinned by** `CallRegistry.commit.test.ts` — _"rejects the same commitment twice
from the same analyst"_, _"lets a different analyst use a hash the first analyst
already used"_, and the fuzz property
`testFuzz_aCommitmentCannotBeSpentTwice`.

## 2. A call cannot be revealed before its deadline

**Why it matters.** This is the whole mechanism. If an early reveal were legal
the analyst could watch the price and open only once it already favoured them,
and the commitment would be decorative.

**Enforced by** `if (block.timestamp < deadline) revert TooEarlyToReveal(...)`.

**Pinned by** `CallRegistry.reveal.test.ts` — _"refuses a reveal before the
deadline"_.

## 3. Every committed call lands in exactly one terminal bucket

Once nothing is open, `committed == wins + losses + forfeited` for every analyst.

**Why it matters.** This is what makes selective reveal visible. An analyst who
sprays a hundred calls and opens three cannot show a record of three wins — the
other ninety-seven are counted, as forfeits, in the same struct.

**Enforced by** the counter updates in `commitCall`, `_settle` and `forfeit`,
each of which runs exactly once per call because the status transition guarding
it is one-way (invariant 5).

**Pinned by** `CallRegistry.reveal.test.ts` — _"counts every committed call in
exactly one terminal bucket"_ and _"never pays out more than the stakes it holds
across mixed outcomes"_, which drives all three terminal paths in one test.

## 4. A revealed call matches the commitment exactly

No field of a prediction can be changed between commit and reveal.

**Why it matters.** It is the difference between a prediction and a
recollection.

**Enforced by** recomputing `keccak256(abi.encode(assetId, direction,
targetPrice, deadline, salt, analyst))` at reveal and comparing it to the stored
commitment. `deadline` and `analyst` are read from **storage**, not from
calldata, so they cannot be made to disagree with what was committed.

**Pinned by** `CallRegistry.reveal.test.ts` — the four _"commitment binding"_
tests (target, direction, asset, salt) and the fuzz property
`testFuzz_revealRejectsAnAlteredTarget`, which searches for a pair of distinct
targets that open the same commitment.

## 5. Terminal states are terminal

There is no path from `RevealedWin`, `RevealedLoss` or `Forfeited` back to
`Committed`.

**Why it matters.** A stake that could be settled twice is a stake that can be
withdrawn twice. It is also what makes the public record permanent: a forfeit
cannot be walked back by a late reveal.

**Enforced by** the `status != Status.Committed` check at the top of both
`revealCall` and `forfeit`, and by the absence of any assignment of
`Status.Committed` outside `commitCall`.

**Pinned by** `CallRegistry.reveal.test.ts` — _"refuses to reveal the same call
twice"_, _"refuses a call that was already revealed"_ (forfeit side), and
_"refuses to be undone by a late reveal"_.

## 6. The contract is solvent

`address(this).balance >= sum of the stakes of all calls still in Committed`.

**Why it matters.** Every open stake is owed to somebody — the analyst if they
win, the treasury otherwise. A shortfall means one of those settlements will
fail.

Stated as `>=` and not `==` on purpose: `selfdestruct` and block rewards can push
ETH into a contract without executing any of its code, so equality is falsifiable
by an outsider while solvency is not. In the other direction the contract has no
`receive` and no `fallback`, so every wei that arrived through code arrived
through `commitCall`.

**Enforced by** paying out exactly `stored.stake` on each terminal transition,
once, after the status has moved.

**Pinned by** `CallRegistry.commit.test.ts` — _"holds at least the sum of every
open stake"_ and _"refuses plain ETH transfers"_; `CallRegistry.reveal.test.ts`
— _"never pays out more than the stakes it holds across mixed outcomes"_; and
the `assertGe` in `testFuzz_commitStoresWhatWasSubmitted`.

## 7. Settlement uses the price at the deadline

The price a call is judged against is the last Chainlink round at or before its
deadline — not the price when the reveal transaction happens to be mined.

**Why it matters.** With a 48-hour reveal window, settling against the latest
round would hand the analyst a free 48-hour option: wait, and open the call only
if the price crosses back. Written out in full in
[[ADR-010-settlement-reads-the-round-covering-the-deadline]].

**Enforced by** `PriceOracleResolver.getPriceAt`, which verifies the supplied
`roundId` rather than trusting it: the round must exist, predate the deadline,
sit inside the feed's staleness window relative to the deadline, and have no
successor that also predates it.

**Pinned by** `CallRegistry.reveal.test.ts` — _"ignores a later price that would
have flipped the outcome"_, _"refuses a round from after the deadline"_,
_"refuses a cherry-picked earlier round when a later one also covers the
deadline"_; and the twelve `getPriceAt` cases in `PriceOracleResolver.test.ts`.

## 8. An admin can never touch an open call

`DEFAULT_ADMIN_ROLE` and `PAUSER_ROLE` can stop new commits and change
parameters for future calls. Neither can move an open stake, block a reveal, or
block a forfeit.

**Why it matters.** It is the difference between an emergency brake and a
confiscation switch. It is also the weakest row in the trust model, so it is the
one worth stating precisely rather than generally.

**Enforced by** three separate things:

- `whenNotPaused` is on `commitCall` **only** — a pause that reached `revealCall`
  would let an admin run out the reveal window and strand user funds
  ([[ADR-003-pause-blocks-commit-only]]).
- `revealWindow` is snapshotted into each call at commit time, so `setRevealWindow`
  has no code path to an open call.
- No function transfers a stake anywhere except to the call's own analyst or to
  the treasury, and neither destination is chosen by the caller.

**Pinned by** `CallRegistry.reveal.test.ts` — _"stays available while the
protocol is paused"_ and _"stays available for a reveal while the protocol is
paused"_; `CallRegistry.commit.test.ts` — _"keeps the reveal window a call was
committed with when the parameter changes"_.

---

## What is not an invariant

Worth naming, because their absence is a design choice rather than an oversight.

- **The record is not weighted.** "ETH above $1" counts as a win. The chain has
  no notion of how bold a call was, and cannot: `commitCall` does not know the
  asset. Boldness is computed off-chain
  ([[ADR-004-trivial-target-measured-off-chain]]).
- **A stake is not always recoverable by its owner.** A winning analyst whose
  address rejects ETH cannot be paid, and their call eventually forfeits to the
  treasury. So does a call whose feed had no round covering its deadline. Both
  are limitations in the README, not bugs.
- **The treasury is not a pool.** Slashed stakes are not redistributed to the
  analysts who were right in the same window. That is a better design and it
  needs pool accounting that adds no insight for the effort.
