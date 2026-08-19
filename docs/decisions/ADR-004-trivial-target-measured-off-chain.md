---
id: ADR-004
title: Defend against trivial targets off-chain, and say so in the README
status: accepted
date: 2026-08-19
phase: F0
tags: [adr, threat-model, product, oracle]
---

# ADR-004 — Defend against trivial targets off-chain

## Context

The brief's threat model (selective reveal, commit brute force, stale oracle)
protects the _integrity_ of the record. None of it protects its _usefulness_.

The gap: commit "ETH above $1" a hundred times. Every call reveals as a win. The
track record is 100-0, cryptographically verifiable, and worth nothing. Any
reviewer finds this in under a minute, so it has to be answered explicitly rather
than left for them to find.

A real defence needs the **spot price at commit time**, to express how far the
target sat from the market when the analyst took the position. But `commitCall`
cannot know the spot price: it does not know the asset. That is the entire point
of the commitment.

## Options

**A. Measure off-chain.** The indexer reads the `CallCommitted` event timestamp,
looks up the spot price at that timestamp, and computes
`edge = |target − spot| / spot`. The leaderboard ranks on edge-weighted accuracy
and shows the raw number alongside. Zero gas, zero contract surface. The ranking
becomes a claim about the frontend rather than a claim about the chain.

**B. Verify on-chain at reveal.** The analyst passes a `roundId` alongside the
reveal; the contract calls `getRoundData(roundId)` and requires that round's
`updatedAt` to fall within a tolerance of `committedAt`, then stores the spot
price at commit. Makes edge trustless. Costs: `committedAt` must stay in storage
(one extra slot per call, see [[ADR-006-drop-committedat-from-struct]]), the
reveal grows a parameter the user must source correctly, and a new failure mode
appears — an unfindable or pruned round makes an otherwise valid call
unrevealable, which costs the analyst their stake.

## Decision

Option A for the MVP. Option B is documented as the primary post-v1 extension.

The deciding factor is not effort, it is blast radius. Option B introduces a way
for a well-behaved analyst to lose money because of an oracle-indexing detail
they do not control. Trading real funds-safety for a stronger reputation metric
is the wrong direction while the metric is not the product.

The README carries this as **known limitation #5**, stated plainly: on-chain
records are trustworthy, the leaderboard _ranking_ is not, and a trivially-safe
target is visible to anyone reading the revealed parameters.

## Consequences

- The registry does not store `committedAt`, which frees a storage slot
  ([[ADR-006-drop-committedat-from-struct]]).
- `CallCommitted` must be indexed richly enough for an off-chain indexer to
  reconstruct commit timestamps per analyst.
- Raw win/loss counts stay on-chain and unweighted. Any edge weighting is a
  frontend computation and must be labelled as such in the UI, not presented as
  chain data.

## Links

[[ADR-006-drop-committedat-from-struct]] · [[ADR-002-per-feed-staleness-threshold]]
