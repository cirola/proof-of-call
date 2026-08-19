---
id: ADR-007
title: Name the prediction direction Above/Below, not Long/Short
status: accepted
date: 2026-08-19
phase: F0
tags: [adr, naming, domain-model]
---

# ADR-007 — Name the direction `Above` / `Below`

## Context

The brief specified `enum Direction { Long, Short }` with the resolution rule
"Long wins if `price >= targetPrice`, Short wins if `price <= targetPrice`".

The rule is right; the names are not. "Long" and "Short" denote a _position_ —
directional exposure, held over time, with a P&L that scales with how far the
price moves. This contract has none of that. It stores a single boolean claim
about where a price sits at one timestamp, and pays a fixed stake back on a
binary outcome.

The mismatch is not cosmetic. A reader who sees `Direction.Short` reasonably
expects "profits when the price falls" and has to read the settlement code to
discover the semantics are "was below this level at the deadline" — which is a
different claim, and true or false regardless of where the price started.

## Options

**A. Keep `Long` / `Short`.** Familiar vocabulary to a crypto audience.
Systematically misdescribes what the contract stores.

**B. `Above` / `Below`.** Names the predicate exactly: the claim is that the
settlement price is above (or below) `targetPrice`. Self-documenting next to the
comparison operator it controls.

## Decision

Option B. `enum Direction { Above, Below }`. `Above` wins when
`settlementPrice >= targetPrice`; `Below` wins when `settlementPrice <= targetPrice`.

Done now because it is free before deployment: enum values are ABI-level
constants, so changing them after F4 means a redeploy and a frontend that has
been silently sending the wrong integer.

## Consequences

- Frontend copy can stay user-facing ("I think ETH will be above $4,000") — the
  UI label and the contract enum finally mean the same thing.
- Equality settles as a win for both directions. Deliberate, and documented: an
  exact tie is astronomically unlikely at 8 decimals, and letting it fall through
  to a loss on both sides would create a case where no direction wins.
- Any brief or diagram still showing `Long`/`Short` is stale and must be updated.

## Links

[[ADR-006-drop-committedat-from-struct]]
