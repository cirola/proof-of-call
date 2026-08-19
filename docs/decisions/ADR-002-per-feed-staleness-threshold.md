---
id: ADR-002
title: Configure the staleness threshold per feed, not globally
status: accepted
date: 2026-08-19
phase: F0
tags: [adr, oracle, chainlink, security]
---

# ADR-002 — Configure the staleness threshold per feed, not globally

## Context

A Chainlink aggregator that stops updating keeps answering `latestRoundData()`
with its last known round. Consuming that value without checking `updatedAt`
settles predictions against a price that may be hours old — this is attack C in
the project brief.

The check needs a threshold, and the correct threshold is the feed's heartbeat
plus margin. Heartbeats are **per feed**, not per network: different pairs are
configured with different deviation thresholds and heartbeat intervals, and
testnet feeds are updated less regularly than their mainnet counterparts.

A single global threshold therefore has no correct value. Set to the fastest
feed's heartbeat, the slower feed reverts constantly on healthy data. Set to the
slowest, the faster feed accepts data that is long dead.

## Options

**A. One `stalenessThreshold` state variable for the whole resolver.** One
setter, one number. Wrong by construction for any resolver holding more than one
feed.

**B. Threshold stored alongside each feed.** `setFeed(assetId, aggregator, staleness)`
writes both, so a feed can never be registered without a threshold.

**C. Threshold read from the aggregator.** Not possible — `AggregatorV3Interface`
exposes no heartbeat getter.

## Decision

Option B. The resolver stores a `FeedConfig { address aggregator; uint32 staleAfter; }`
per `assetId`. Registering a feed and setting its threshold is one atomic admin
operation, which removes the "feed registered, threshold still zero" state
entirely.

Also decided here, from the same review: the classic
`require(answeredInRound >= roundId)` check is **not** included. That field is a
leftover from the pre-OCR `FluxAggregator` design; on every current OCR feed
`answeredInRound == roundId` unconditionally, so the check can never fire and
provides false assurance. It is replaced by `updatedAt != 0`, which does catch a
genuine failure mode (a round that was started but never answered).

## Consequences

- `setFeed` takes three arguments; the deployment module must supply a
  researched heartbeat per pair rather than one constant.
- Thresholds must be verified against `docs.chain.link` at deploy time (F4) and
  recorded in the deployment module, not guessed.
- Because `getPrice` reverts on stale data, `revealCall` reverts too and the call
  stays `Committed` — the analyst retries once the feed recovers. This is
  invariant 8 and must be tested explicitly.

## Links

[[ADR-008-oracle-adapter-layer]] · [[ADR-003-pause-blocks-commit-only]]
