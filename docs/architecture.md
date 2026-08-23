---
title: Architecture
status: living
phase: F0
tags: [architecture, contracts, oracle]
---

# Architecture

Working document. Sections are filled in as the phase that builds them closes;
anything marked _planned_ is specification, not implemented code.

## Layers

```mermaid
flowchart TB
    UI["Frontend (React + wagmi)<br/>salt generation, commitment hashing,<br/>local salt custody"]
    REG["CallRegistry.sol<br/>commit-reveal lifecycle, stakes,<br/>settlement, analyst stats"]
    IFACE["IPriceResolver<br/><i>the seam</i>"]
    RES["PriceOracleResolver.sol<br/>feed registry, per-feed staleness,<br/>decimal normalization"]
    CL["Chainlink AggregatorV3<br/>BTC/USD, ETH/USD"]
    MOCK["MockV3Aggregator<br/><i>tests only</i>"]

    UI -->|commitCall / revealCall / forfeit| REG
    REG -->|getPrice| IFACE
    IFACE --> RES
    RES --> CL
    RES -.-> MOCK
```

The registry depends on `IPriceResolver`, never on Chainlink. Everything
Chainlink-specific — the interface import, `latestRoundData()`, decimals,
staleness — lives in the adapter. Rationale and the rejected alternative are in
[[ADR-008-oracle-adapter-layer]].

`MockV3Aggregator` deliberately implements the _Chainlink_ interface, not
`IPriceResolver`. Mocking one level lower means tests exercise the adapter's real
normalization and staleness code instead of stubbing it out — which is the code
most worth testing.

## Call lifecycle

```mermaid
stateDiagram-v2
    [*] --> None
    None --> Committed: commitCall + stake >= minStake

    Committed --> RevealedWin: revealCall, hash matches, prediction correct
    Committed --> RevealedLoss: revealCall, hash matches, prediction wrong
    Committed --> Forfeited: forfeit, window elapsed, callable by anyone

    RevealedWin --> [*]: stake returned to analyst
    RevealedLoss --> [*]: stake sent to treasury
    Forfeited --> [*]: stake sent to treasury
```

Both terminal transitions out of `Committed` are one-way. There is no path from
`Forfeited` back to a revealed state — invariant 5 — and the reveal window is
snapshotted per call at commit time so that an admin lowering `revealWindow`
cannot retroactively push open calls past their deadline
([[ADR-009-initial-protocol-parameters]]).

## Timeline of a single call

```
  commit                        deadline                    window closes
    |                               |                              |
    |<------ minHorizon .. -------->|<------ revealWindow -------->|
    |         .. maxHorizon         |          (48h)               |
    |                               |                              |
  stake locked            reveal becomes legal            forfeit becomes legal
  params hidden           price is read here              stake goes to treasury
```

Revealing before the deadline always reverts — invariant 2. If that check fails,
the analyst could wait for the price to move and reveal only when it favours
them, and the whole scheme is decorative.

## Commitment construction

```
commitment = keccak256(abi.encode(
    assetId,      // bytes32   keccak256("BTC/USD")
    direction,    // Direction Above | Below
    targetPrice,  // int256    8 decimals
    deadline,     // uint64    unix seconds
    salt,         // bytes32   256 bits from a CSPRNG
    analyst       // address   msg.sender at commit time
))
```

Two of these six fields are load-bearing beyond the obvious.

**`salt`** defends against brute force. The other five fields have a small, very
guessable joint domain; without the salt an attacker hashes every plausible
prediction and reads the call before it is revealed. See attack B in the README.

**`analyst`** binds the commitment to one address. A commitment is public from
the moment it is submitted, so without this field an attacker who observes a
reveal in the mempool could take the plaintext parameters, submit them against a
commitment they had copied earlier, and claim someone else's call. Including the
address makes any commitment only openable by the account that created it, and
the copied hash unrevealable by anyone.

`abi.encode` is used rather than `abi.encodePacked`: packed encoding of
variable-length or adjacent same-type fields admits collisions between distinct
tuples. The gas saved is not worth introducing a class of ambiguity into the one
value the entire protocol depends on.

## Storage layout — `Call`

| slot | packed contents                                                                 | bytes used |
| ---- | ------------------------------------------------------------------------------- | ---------- |
| 0    | `address analyst` + `uint64 deadline` + `uint24 revealWindow` + `Status status` | 32 / 32    |
| 1    | `bytes32 commitment`                                                            | 32         |
| 2    | `uint256 stake`                                                                 | 32         |

Three slots, the first one exactly full.

`revealWindow` is stored **per call**, copied from the protocol parameter at
commit time. Reading the global value live at reveal time would let an admin who
shortened it retroactively close the window on calls that were already open, and
force forfeits on analysts who had done nothing wrong. `uint24` caps a window at
roughly 194 days — far past any value worth setting — and is what makes the
snapshot fit in the slot instead of costing a fourth one.

`committedAt` is _not_ stored: no on-chain path reads it, and a cold `SSTORE` to
a fourth slot would cost every analyst 20,000 gas to serve readers who are
reading event logs anyway ([[ADR-006-drop-committedat-from-struct]]). The same
argument is why the sum of open stakes is not tracked in storage either — it is
derivable from the calls themselves, and invariant 6 is asserted by summing them.

## Trust boundaries

| Actor                | Can do                                                             | Cannot do                                                                                    |
| -------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Analyst              | Commit, reveal their own calls                                     | Reveal early, alter a revealed call, reveal another analyst's call, avoid the forfeit record |
| Anyone               | Call `forfeit` on an expired call                                  | Move funds anywhere except the treasury                                                      |
| `DEFAULT_ADMIN_ROLE` | Swap the resolver, set treasury, set parameters, pause new commits | Touch an open call's stake, block a reveal, block a forfeit                                  |
| Chainlink            | Supply prices                                                      | Return a stale or non-positive price without the adapter reverting                           |

The admin row is the weakest one and is stated as such in the README: swapping in
a hostile resolver would control every future settlement. No timelock in the MVP.

Pausing is limited to `commitCall` on purpose — a pause that could reach
`revealCall` would let an admin run out the reveal window and strand user funds
([[ADR-003-pause-blocks-commit-only]]).

## Off-chain surface

- **Leaderboard ranking** is computed from event logs, not from chain state. It
  weights each call by the distance between its target and the spot price at
  commit time, which the chain cannot know
  ([[ADR-004-trivial-target-measured-off-chain]]). The ranking is a claim by this
  frontend; the raw win/loss/forfeit counts are chain data.
- **Salt custody** is entirely client-side. The contract never sees a salt before
  the reveal, and losing it is unrecoverable.
