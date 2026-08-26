---
id: ADR-014
title: The leaderboard weights calls off-chain, and labels the result as a claim
status: accepted
date: 2026-08-26
phase: F5
tags: [adr, frontend, leaderboard, incentives]
supersedes: []
---

# ADR-014 — Off-chain boldness weighting, labelled as a claim

## Context

[[ADR-004-trivial-target-measured-off-chain]] established _that_ boldness is
measured off-chain and why it cannot be measured on-chain: `commitCall` receives
a hash, so the contract does not know the asset and cannot read a spot price to
compare the target against. That opacity is the mechanism.

What ADR-004 did not fix is the formula, because there was no frontend to put it
in. Ranking analysts by raw wins makes "ETH at or above $1" a perfect record, so
the leaderboard needs a weight — and every weight is a value judgement that the
chain did not make.

## Decision

Rank by a score computed in the frontend, from the spot price at commit time:

```
edge    = |target − spot at commit| / spot at commit
weight  = min(edge / 0.05, 3)
score  += +weight on a win, −weight on a loss
score  −= 1.00 per forfeit
```

with three supporting choices:

- **The reference edge is 5%.** A call that needs a 5% move is worth 1.00. The
  cap at 3 stops one lottery ticket carrying an entire record.
- **The forfeit penalty is flat at 1.00**, equal to the reference weight, because
  a forfeited call never disclosed a target and there is nothing to weight it by.
  Setting it lower would make silence the cheap exit from a bad prediction, which
  is precisely the behaviour attack A exists to price.
- **The spot price at commit time is fetched**, not stored: `CallCommitted`
  carries `committedAt` for exactly this reason ([[ADR-006-drop-committedat-from-struct]]),
  and the price is recovered by the same binary search the reveal flow uses. A
  call whose spot price cannot be recovered is **counted but left unweighted**,
  and the count of unweighted calls is shown, rather than guessed at or dropped.

And one presentation rule that is not negotiable: **the counts and the score are
labelled differently on the page.** Committed, won, lost and forfeited are chain
data. The score is this frontend's opinion, the formula is printed underneath the
table, and the footer says so on every page.

## Consequences

- **Anyone can disagree with the weighting and recompute it.** The inputs are all
  public — the counts from contract state, the targets from `CallRevealed`, the
  spot prices from the same Chainlink feed. A different frontend can rank the
  same record differently, which is the correct property for a protocol whose
  premise is that the record does not depend on who is showing it.
- **The score costs RPC calls.** One binary search per revealed call, run
  serially so a public endpoint does not rate-limit the page, with results cached
  in `localStorage` because a past price never changes. The counts render
  immediately and the score fills in.
- **It is manipulable at the margin** by an analyst who commits when the spot
  price is briefly far from their target. The manipulation is visible in the same
  public data, and pricing it properly would need a volatility-adjusted edge —
  more machinery than an MVP leaderboard earns.
- **Presenting the weighted number as protocol output would be the single
  dishonest thing** in an application whose entire premise is an auditable
  record. Hence the labelling rule above.

## Links

[[ADR-004-trivial-target-measured-off-chain]] ·
[[ADR-006-drop-committedat-from-struct]] ·
[[ADR-010-settlement-reads-the-round-covering-the-deadline]]
