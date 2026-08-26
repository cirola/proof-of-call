---
id: ADR-013
title: Salt custody is browser-local, with export offered at commit time
status: accepted
date: 2026-08-26
phase: F5
tags: [adr, frontend, ux, security, keys]
supersedes: []
---

# ADR-013 — Salt custody is browser-local

## Context

The commitment is `keccak256(assetId, direction, targetPrice, deadline, salt,
analyst)`. Five of those six fields are public or trivially recoverable. The
salt is 256 bits that exist nowhere on-chain, and without it the call cannot be
opened: the reveal window closes, the call is recorded as a forfeit, and the
stake goes to the treasury.

That makes the salt a secret worth exactly the stake behind it, and it makes salt
custody a security decision rather than a UI detail. The options:

1. **Browser storage only.** No infrastructure, no third party, no exfiltration
   surface. A cleared profile, a second machine, or a private window is a total
   loss.
2. **A backend that stores salts.** Recoverable, and it reintroduces exactly the
   trust assumption the protocol exists to remove — an operator who holds every
   analyst's salts can open their calls, or refuse to.
3. **Derive the salt deterministically from a wallet signature.** Recoverable
   from the wallet alone and genuinely elegant, but it makes the salt only as
   unpredictable as the signing scheme, ties reveal to a signature the user must
   reproduce exactly, and silently breaks for any wallet with non-deterministic
   signatures. It also means one compromised signature exposes every commitment
   the account ever made, rather than one.

## Decision

Option 1, with the loss mode treated as a first-class part of the interface
rather than as a disclaimer.

- The salt is generated with `crypto.getRandomValues` and **never**
  `Math.random`. If the platform CSPRNG is missing, committing is blocked rather
  than falling back — a weak salt looks exactly like a strong one, and the
  failure would only surface when somebody's prediction was read early.
- The salt is written to `localStorage` **before the transaction is signed**.
  Signing first leaves a window in which a closed tab loses the salt for a call
  that is already on-chain and already holding money.
- The commit success screen leads with a download button, not a tooltip.
- There is a dedicated Vault page in the top-level navigation, with export,
  import, per-call download and delete. Import merges rather than replaces, so
  restoring a backup on a machine that already has live calls does not delete
  them.
- Entries are keyed by commitment and scoped by chain id and registry address,
  so a redeploy does not mix two protocols' salts in one list.

## Consequences

- **The failure mode is real and is stated in plain language**, in three places:
  the commit form, the commit success screen, and the vault. "Nothing recovers
  it — not you, not an admin, not the chain."
- **A user on two machines must move a file.** That is the honest cost of not
  holding their secrets, and the import flow exists to make it a file picker
  rather than a support ticket.
- **A reveal from a browser with no salt is a dead end** that the UI names
  explicitly and links to the import screen, rather than a generic
  `CommitmentMismatch` from the contract.
- **The salt sits in `localStorage` in plaintext**, readable by any script on the
  origin. That is the same trust boundary as the page itself, so an XSS on this
  origin is already game over; encrypting at rest with a passphrase would raise
  the cost of a stolen backup file and is the obvious next iteration.

## Links

[[ADR-012-generated-abi-committed-to-the-frontend]] ·
[[ADR-014-leaderboard-weights-calls-off-chain]]
