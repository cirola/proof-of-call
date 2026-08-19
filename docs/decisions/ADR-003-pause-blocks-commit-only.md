---
id: ADR-003
title: Pausing blocks new commits only; reveal and forfeit are never pausable
status: accepted
date: 2026-08-19
phase: F0
tags: [adr, security, access-control, funds-safety]
---

# ADR-003 — Pausing blocks new commits only

## Context

The registry holds user ETH, and every stake has a hard deadline: an analyst who
does not reveal within the reveal window loses the stake to the treasury.

Applying OpenZeppelin's `whenNotPaused` to `revealCall` — the reflexive
"pause everything" reading — creates a path where an admin action destroys user
funds. Pause for longer than the reveal window and every open call becomes
unrevealable; on unpause, `forfeit` legitimately slashes analysts who did nothing
wrong. An admin can trigger this by accident, and a compromised admin key can
trigger it on purpose. That is not an emergency brake, it is a confiscation
switch.

## Options

**A. Pause gates `commitCall` only.** `revealCall` and `forfeit` always execute.
No accounting, no edge cases. An emergency stop still does the thing that
matters: it stops new money entering a contract suspected of being broken.

**B. Pause everything, and track paused duration to extend reveal windows.**
Preserves fairness while allowing a full freeze. Requires cumulative
paused-seconds accounting, correct handling of a pause that begins before a
deadline and ends after it, and nested/repeated pauses. Every one of those is a
place to introduce the bug the pause was meant to contain.

## Decision

Option A. `commitCall` carries `whenNotPaused`. `revealCall` and `forfeit` do
not, and a code comment states that this is deliberate so nobody "fixes" it later.

Option B buys fairness during a freeze that this system does not need: the only
realistic emergency is "a bug was found", and the correct response to that is to
stop new deposits while letting existing positions settle under the rules they
were entered under. Complexity that guards user funds is worth it; complexity
that only smooths an admin workflow is not.

## Consequences

- A discovered bug cannot be contained by freezing settlement. If settlement
  itself is the bug, the response is a migration, not a pause. Accepted.
- `forfeit` remains callable by anyone at all times, so pausing can never strand
  a call in `Committed` forever.
- Tests must assert that `revealCall` and `forfeit` still succeed while paused.
  A future refactor that adds `whenNotPaused` to either must fail CI.

## Links

[[ADR-002-per-feed-staleness-threshold]]
