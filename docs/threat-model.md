---
title: Threat model
status: living
phase: F3
tags: [security, threat-model, commitment, oracle]
updated: 2026-08-23
---

# Threat model

The README states the four attacks the design exists to answer. This file goes
one level down on the questions where "because that's how commit-reveal works"
is not an answer — the ones an interviewer asks second.

---

## 1. What if `analyst` were removed from the commitment preimage?

The commitment is

```
keccak256(abi.encode(assetId, direction, targetPrice, deadline, salt, analyst))
```

`analyst` looks redundant: the registry already stores who committed each call,
and `revealCall` already refuses anyone but that address. Drop it and the hash
gets cheaper to explain.

Here is the theft it enables, step by step.

**Setup.** Alice commits call #7. Her commitment `H` is a public `bytes32` in
the `CallCommitted` log the moment her transaction is mined. Mallory reads it.

**Step 1.** Mallory commits her own call #8 with the _same_ hash `H`. She has no
idea what it means. She stakes the minimum. (Commitment uniqueness is scoped per
analyst — invariant 1 — precisely because a global mapping would turn this step
into a griefing move instead of merely a wasted stake.)

**Step 2.** Both calls share a deadline, because the deadline is inside `H`.
Mallory watches the mempool.

**Step 3.** After the deadline Alice reveals. Her transaction sits in the public
mempool for a few seconds before inclusion, carrying `assetId`, `direction`,
`targetPrice`, `salt` in the clear.

**Step 4.** Mallory reads those four values out of Alice's pending transaction
and submits `revealCall(8, ...)` with the identical parameters and a higher
priority fee. Without `analyst` in the preimage, the recomputed hash equals `H`,
and it matches call #8's stored commitment. Her reveal is valid.

**Result.** Mallory now owns an identical, identically-timestamped call. If
Alice's prediction was right, so is Mallory's — she is paid her stake back and
her public record gains a win she did not earn. She has been copying Alice's
calls without ever making one, and the chain says otherwise.

The theft is of **reputation**, which is the only thing this protocol produces.
Alice's stake is untouched, and that is exactly why the attack is easy to miss
when auditing for fund loss.

**With `analyst` in the preimage**, step 1 still works — Mallory can copy any
hash she likes — but step 4 cannot: recomputing with `analyst = Mallory` yields
a different hash, and no set of parameters she can discover will ever open a
commitment built around Alice's address. Mallory's copied call is unopenable by
construction and forfeits her stake. She has paid to add a forfeit to her own
record.

Pinned by `testFuzz_analystSeparatesIdenticalPredictions` and by
_"separates two analysts making the identical prediction"_.

Note what this does **not** fix: front-running Alice's reveal of her _own_ call.
Anyone can submit that transaction, and it settles Alice's call to Alice's
address either way. `revealCall` still requires `msg.sender == analyst`, but
that check is for a clear error message, not for safety.

## 2. Why `abi.encode` and not the cheaper `abi.encodePacked`?

`encodePacked` concatenates arguments without padding and without length
prefixes. For a tuple of purely fixed-size types — which this one is:
`bytes32, uint8, int256, uint64, bytes32, address` — the encoding is
unambiguous, and the two would be equally safe today. `encodePacked` would save
roughly 100 gas of memory expansion and hashing on a function that is already
dominated by two cold `SSTORE`s.

It is still the wrong choice, for three reasons that all point the same way.

**The ambiguity is a property of the type list, not of the call.** Packed
encoding collides as soon as any argument becomes variable-length or two
adjacent arguments of the same type are reordered in a later version. Adding a
`string memory note` to a call, or an array of asset ids for a multi-leg
prediction, silently turns a safe encoding into one where distinct predictions
can hash alike. The failure would not be a compile error or a failing test — it
would be a live collision in the one value the whole protocol rests on.

**The saving is not on a path anyone feels.** A commit already pays ~45,000 gas
in storage. A hundred gas is inside the noise of the block base fee.

**`encode` is self-documenting to a reviewer.** Anyone auditing a hashing
function looks first for `encodePacked` and then for whether it can collide.
Using `encode` makes that question not arise.

The rule this follows: **do not spend safety margin on gas that nobody is
counting.** The place to optimise is the storage layout — where three slots
versus four is 20,000 gas per commit, two hundred times the saving — and that is
where it was optimised.

## 3. Why revert on a stale feed instead of returning the last known price?

A price feed that has stopped updating does not report an error. It answers
`latestRoundData()` with its last round, indefinitely, and the answer looks
exactly like a healthy one.

The tempting alternative is to return that value with a `bool stale` flag and
let the caller decide. It is a bad trade for two reasons.

**A flag has to be checked.** The failure mode of a flag is silence: a caller
that forgets it settles real stakes against a price that may be hours dead, and
nothing reverts, and nothing logs. The failure mode of a revert is a transaction
that does not execute. One of those is recoverable by retrying.

**A stale price is not a degraded price, it is a different price.** Settlement is
a binary comparison against a target. A price two hours old is not "roughly
right" — it is precisely wrong for calls near their target, which is where every
interesting call is. Worse, an attacker who can anticipate a feed outage knows
the settlement price in advance and can commit calls that are guaranteed to win.
Failing closed removes that entirely.

### So who loses if a feed dies permanently while a call is open?

The analyst does, and it is not fair.

The concrete sequence: the feed publishes no round within `staleAfter` of the
deadline, so `getPriceAt` reverts and `revealCall` reverts with it. The call
stays in `Committed` and the analyst can retry. If the feed never recovers, the
reveal window closes, `forfeit` becomes callable by anyone, and the stake goes to
the treasury — recorded as a forfeit, which in this protocol reads as
_"this analyst went quiet"_. An oracle outage is written into a human's public
record as evasion.

That is a real cost, and it is stated rather than argued away. What bounds it:

- **`maxHorizon` is 30 days** ([[ADR-009-initial-protocol-parameters]]), chosen
  for this reason and not for product feel. A 90-day call can outlive its own
  testnet feed; a 30-day one is inside a window that can be monitored.
- **`staleAfter` is per feed** ([[ADR-002-per-feed-staleness-threshold]]), so a
  slow feed is not judged by a fast feed's heartbeat and outages are not
  manufactured by a badly chosen global constant.
- **The resolver is swappable.** If a feed is deprecated and replaced at a new
  address, one admin transaction re-points the asset and open calls settle
  normally — provided it happens before the windows close.

What would fix it properly, and is deliberately out of scope for the MVP: a
`Voided` terminal state that returns the stake and counts as neither a win nor a
forfeit, entered when the resolver reports "no round covers this deadline" rather
than "the analyst was wrong". The reason it is not here is that voiding is an
admission of an oracle failure, and deciding who may make that admission — the
analyst, an admin, or the resolver itself — is a governance question the MVP does
not have an answer for. An admin-triggered void is a new confiscation-shaped
power pointed the other way, and it would need the timelock this project does not
have.

## Residual risks, named

| Risk                                                                   | Bound                                                                                                                       |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Admin swaps in a hostile resolver and controls every future settlement | None. No timelock in the MVP. Stated in the README's trust model.                                                           |
| Chainlink phase rotation lands inside a call's deadline                | One heartbeat of round-selection freedom on that single call ([[ADR-010-settlement-reads-the-round-covering-the-deadline]]) |
| Feed dies permanently while a call is open                             | `maxHorizon` 30 days; resolver is swappable; otherwise the analyst loses the stake                                          |
| A winning analyst's address rejects ETH                                | Their reveal reverts and the call eventually forfeits to the treasury                                                       |
| An analyst commits against an asset that has no feed                   | Unrevealable, forfeits. The contract cannot check — it does not know the asset yet                                          |
| A trivially safe target scores as a win                                | Off-chain weighting only ([[ADR-004-trivial-target-measured-off-chain]])                                                    |
| Salt lost                                                              | Unrecoverable. Client-side custody, stated in plain language in the UI                                                      |
