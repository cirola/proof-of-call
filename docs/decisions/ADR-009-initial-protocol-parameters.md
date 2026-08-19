---
id: ADR-009
title: Initial protocol parameters for the Sepolia deployment
status: accepted
date: 2026-08-19
phase: F0
tags: [adr, parameters, product, deployment]
---

# ADR-009 — Initial protocol parameters

## Context

Five numbers gate every user interaction and have to be fixed before `commitCall`
can validate anything. All are admin-settable, so these are starting values, not
permanent ones.

## Decision

| Parameter      | Value                | Reasoning                                                                                                                                                                                                                                                                                                |
| -------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minStake`     | `0.001 ETH`          | Must be small enough that a Sepolia faucet drip (~0.05–0.5 ETH) funds dozens of full test cycles, and large enough that the stake is not free. On a testnet the stake is a mechanism demonstration, not an economic deterrent.                                                                           |
| `minHorizon`   | `1 hour`             | Below roughly one hour the commitment stops hiding anything useful: the analyst is predicting the next few blocks, and the reveal follows so closely that a watcher learns nothing they could not infer.                                                                                                 |
| `maxHorizon`   | `30 days`            | Bounded by oracle lifetime, not by product preference. Testnet feeds get deprecated; a 90-day call can outlive its own feed and become permanently unrevealable, costing the analyst their stake through no fault of their own. 30 days keeps that risk inside a window we can monitor.                  |
| `revealWindow` | `48 hours`           | 24h punishes anyone who commits before a weekend and produces forfeits that are logistics, not dishonesty — which would poison the reputation signal. 72h leaves state open long enough to make a live demo awkward. 48h covers a missed day without dragging.                                           |
| MVP assets     | `BTC/USD`, `ETH/USD` | Two feeds prove the multi-feed path (per-asset registration, per-asset staleness, decimal normalization) with the least surface. A third feed adds one more address to verify and one more deprecation risk while proving nothing new. `setFeed` adds LINK/USD in one transaction whenever it is wanted. |

## Consequences

- Every one of these has a setter behind `DEFAULT_ADMIN_ROLE` and is therefore a
  centralization surface. `setRevealWindow` is the sharpest: shortening it while
  calls are open could force forfeits on analysts who were still inside the
  original window. F3 must decide whether the window is snapshotted per call at
  commit time or read live at reveal time — **snapshot per call is the safe
  choice** and the tests should pin it.
- `maxHorizon` of 30 days means the feed-deprecation risk is real but bounded.
  F4 records the feed addresses actually used, so a deprecation can be traced.
- Values are testnet-calibrated. A mainnet deployment would need `minStake`
  re-derived from real gas costs, since a stake worth less than the reveal
  transaction inverts the incentive: forfeiting becomes cheaper than revealing a
  win.

## Links

[[ADR-003-pause-blocks-commit-only]] · [[ADR-002-per-feed-staleness-threshold]]
