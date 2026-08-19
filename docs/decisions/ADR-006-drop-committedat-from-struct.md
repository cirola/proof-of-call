---
id: ADR-006
title: Keep committedAt in events only, not in the Call struct
status: accepted
date: 2026-08-19
phase: F0
tags: [adr, gas, storage-layout, solidity]
---

# ADR-006 — Keep `committedAt` in events only

## Context

The struct as originally specified occupies four storage slots:

| slot | contents                                       | bytes   |
| ---- | ---------------------------------------------- | ------- |
| 0    | `analyst` (20) + `deadline` (8) + `status` (1) | 29 / 32 |
| 1    | `commitment`                                   | 32      |
| 2    | `stake`                                        | 32      |
| 3    | `committedAt` (8)                              | 8 / 32  |

Slot 3 exists for one 8-byte value. A cold `SSTORE` to a zero slot costs 20,000
gas, paid by every analyst on every commit.

No on-chain code path reads `committedAt`. It was there for the trivial-target
defence, which [[ADR-004-trivial-target-measured-off-chain]] moved off-chain.

## Options

**A. Keep it.** Any future feature needing commit time reads it directly.
20,000 gas per commit for a value nothing currently reads.

**B. Drop it; `CallCommitted` carries `block.timestamp`.** Off-chain consumers —
the leaderboard, the indexer, the reveal countdown — read logs anyway, and a log
entry costs ~375 gas plus data instead of 20,000.

## Decision

Option B. The struct is three slots. `CallCommitted` emits the timestamp.

The general rule this follows: storage is for values that on-chain logic reads;
events are for values that only humans and indexers read. Writing to storage for
an off-chain reader is paying for random access nobody uses.

## Consequences

- Reintroducing on-chain commit time (the option B path of
  [[ADR-004-trivial-target-measured-off-chain]]) is a storage-layout change, so
  it requires a redeploy rather than an upgrade. Acceptable: these contracts are
  non-upgradeable by design.
- The frontend's reveal countdown must derive its start from event logs, not from
  a view call. This shapes the indexing strategy in F5.
- `deadline` stays `uint64`. It is read on-chain by both `revealCall` and
  `forfeit`, and it packs into slot 0 for free.

## Links

[[ADR-004-trivial-target-measured-off-chain]] · [[ADR-007-above-below-not-long-short]]
