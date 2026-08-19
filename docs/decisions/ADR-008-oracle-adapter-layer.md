---
id: ADR-008
title: Isolate Chainlink behind IPriceResolver
status: accepted
date: 2026-08-19
phase: F0
tags: [adr, architecture, oracle, testability]
---

# ADR-008 — Isolate Chainlink behind `IPriceResolver`

## Context

`CallRegistry` needs one thing from the outside world: the price of an asset at
settlement. It could call `AggregatorV3Interface` directly and save a contract,
an interface, and an external call.

Two reasons not to.

**Testability.** Settlement logic is the part of this system that must be proven
correct, and proving it means driving exact prices at exact timestamps — a win by
one wei, a loss by one wei, a feed that stopped updating an hour ago. Against a
live feed none of that is reachable. Without an interface to substitute, there is
no seam to inject a mock through, and settlement stays untested.

**Replaceability.** Feeds get deprecated, especially on testnets. With the
registry coupled to Chainlink, changing oracle means redeploying the registry and
abandoning every existing call and every reputation record — the immutable track
record, which is the product, would be lost to an infrastructure change.

## Options

**A. Registry calls `AggregatorV3Interface` directly.** One less contract, one
less external call per reveal. Untestable settlement, and oracle changes destroy
history.

**B. `IPriceResolver` interface + `PriceOracleResolver` adapter, address held by
the registry and swappable by admin.** Costs one deployment and roughly 2,600 gas
per reveal for the extra external call.

## Decision

Option B. `CallRegistry` holds an `IPriceResolver`. `PriceOracleResolver`
implements it over Chainlink and owns everything Chainlink-specific: feed
registry, staleness thresholds ([[ADR-002-per-feed-staleness-threshold]]),
decimal normalization, and the revert conditions.

The gas cost is paid once per reveal, not per commit, and it buys the only
mechanism by which the settlement rules can be tested at all.

## Consequences

- The resolver address is admin-settable, which is a real centralization
  surface: an admin who swaps in a malicious resolver controls every future
  settlement. It must be listed in the README's trust assumptions and eventually
  sit behind a timelock. Not solved in the MVP; named, not hidden.
- Normalization to 8 decimals happens in the adapter, so the registry compares
  two numbers in the same scale and never learns what a feed's `decimals()` is.
- `MockV3Aggregator` implements the Chainlink interface rather than
  `IPriceResolver`, so tests exercise the real adapter code including its
  staleness and normalization logic — mocking at the resolver level would skip
  exactly the code most worth testing.

## Links

[[ADR-002-per-feed-staleness-threshold]] · [[ADR-003-pause-blocks-commit-only]]
