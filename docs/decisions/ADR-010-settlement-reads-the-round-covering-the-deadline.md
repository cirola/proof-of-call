---
id: ADR-010
title: Settlement reads the Chainlink round covering the deadline, not the price at reveal time
status: accepted
date: 2026-08-23
phase: F3
tags: [adr, oracle, settlement, security]
supersedes: []
---

# ADR-010 — Settlement reads the round covering the deadline

## Context

The design up to F1 assumed settlement would call `IPriceResolver.getPrice()` —
`latestRoundData()` — inside `revealCall`. Writing F3 exposed that this is not a
detail of the oracle layer. It breaks the mechanism the whole protocol exists to
provide.

The reveal window is 48 hours wide ([[ADR-009-initial-protocol-parameters]]).
Reading the latest price at reveal time means the analyst does not settle against
"the price at the deadline". They settle against **the price at a moment of their
own choosing, anywhere inside a 48-hour window**.

The attack is trivial and needs no capital:

1. Commit `ETH above $3,000`, deadline Friday 12:00.
2. Friday 12:00 arrives, ETH is at $2,900. The call is wrong.
3. Do nothing. Watch.
4. Sunday 03:00, ETH ticks to $3,010. Reveal. The contract reads the latest
   round, sees $3,010, records a win.

Every losing call becomes a free 48-hour American option on being right later.
An analyst who reveals only when the tape agrees with them produces a flawless
record — which is precisely the "screenshots of the wins" problem in the README,
reintroduced by the settlement path. The commitment would still hide the
prediction, the stake would still be locked, and the record would still be
worthless.

Note that shortening the reveal window does not fix this, it only prices it.
Any window wide enough to be usable is wide enough to be gamed on a volatile
asset, and a window narrow enough to be safe forfeits honest analysts who were
asleep.

## Decision

Settlement reads the **last Chainlink round whose `updatedAt` is at or before
the call's deadline**, and the resolver proves that the round supplied is that
one.

`IPriceResolver` gains:

```solidity
function getPriceAt(
  bytes32 assetId,
  uint256 atTimestamp,
  uint80 roundId
) external view returns (int256 price);
```

`PriceOracleResolver.getPriceAt` accepts `roundId` from the caller — Chainlink
exposes no timestamp-to-round index, and a binary search on-chain would cost more
than the settlement is worth — and then verifies it rather than trusting it:

| Check                                                           | Rejects                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------- |
| `updatedAt != 0`                                                | A round that does not exist or was never answered             |
| `updatedAt <= atTimestamp`                                      | A round from _after_ the deadline                             |
| `atTimestamp - updatedAt <= staleAfter`                         | A round too old to describe the price at the deadline         |
| round `roundId + 1` is absent, or its `updatedAt > atTimestamp` | An older, cherry-picked round when a later one also qualifies |

The last row is the one that closes the attack. Without it the analyst simply
picks whichever historical round flatters them; with it, exactly one round is
accepted for any given deadline.

`revealCall` therefore takes `uint80 roundId` as a parameter, and the frontend
finds it by binary search over `getRoundData` before submitting. The round id is
**not** part of the commitment preimage: it is not a prediction, it is a lookup
key, and it is not knowable at commit time.

`getPrice()` (latest round) stays on the interface. It is no longer on the
settlement path — it serves the UI's spot-price display and any consumer that
genuinely wants "now".

## Consequences

- **The reveal transaction carries one more argument and one more failure mode.**
  A wrong `roundId` reverts with a named error and costs gas; it cannot settle
  anything incorrectly. That is the right side of the trade.
- **Reveal now depends on off-chain work.** The frontend has to locate the round.
  This is a documented, well-understood binary search over a monotonically
  increasing `updatedAt`, and it is the same technique every options protocol
  that settles at an expiry uses.
- **Phase boundaries are a residual, bounded gap.** A Chainlink `roundId` is
  `(phaseId << 64) | aggregatorRoundId`. When an aggregator is rotated the phase
  increments and `roundId + 1` no longer names the next round, so the
  "is-it-the-latest" check cannot see across the boundary. The
  `atTimestamp - updatedAt <= staleAfter` bound caps the exploitable window at
  one heartbeat, on the one call whose deadline lands inside a rotation. Closing
  it completely means reading the phase aggregators directly, which is Chainlink
  internals leaking into the adapter for a case that has not occurred on the
  Sepolia feeds used here. Named, bounded, not hidden.
- **A dead feed can strand a call.** If no round exists within `staleAfter` of
  the deadline, `getPriceAt` reverts and the call cannot be revealed. Once the
  reveal window closes it is forfeitable and the stake goes to the treasury,
  which punishes an analyst for an oracle outage. This is the same failure mode
  `maxHorizon = 30 days` was chosen to bound in
  [[ADR-009-initial-protocol-parameters]], and it is limitation 7 in the README.
- **The rejected alternative** was making `assetId` public at commit time so that
  anyone could snapshot the price on-chain right after the deadline. It removes
  the historical-round machinery, but it leaks which asset an analyst is calling,
  needs a third transaction, and depends on somebody actually sending it
  promptly — which reintroduces timing discretion for whoever sends it. Strictly
  more moving parts for a weaker guarantee.

## Links

[[ADR-008-oracle-adapter-layer]] · [[ADR-002-per-feed-staleness-threshold]] ·
[[ADR-009-initial-protocol-parameters]]
