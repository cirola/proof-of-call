---
id: ADR-015
title: A local demo harness with mock feeds and simulated analysts
status: accepted
date: 2026-08-28
phase: F6
tags: [adr, tooling, demo, frontend]
supersedes: []
---

# ADR-015 — Local demo harness

## Context

Until now the only way to see this protocol work was Sepolia: a disposable
wallet, a faucet, three keystore secrets, and then a one-hour minimum horizon
before the first call could even be revealed. That is the right target for a
deployment and the wrong one for a first look. Anyone opening the repository —
a reviewer, an interviewer, the author six months from now — pays twenty minutes
of setup before finding out whether the thing runs at all.

Three things stood in the way of a shorter path.

1. **The frontend was pinned to Sepolia.** `CHAIN` was a constant, and every
   hook, every explorer link and the wallet transport keyed off it.
2. **Chainlink has no local deployment.** The resolver probes `decimals()` and
   walks round history, so a local run needs something that implements
   `AggregatorV3Interface` and can be driven.
3. **An empty registry looks like a broken build.** A Calls page with no rows and
   a leaderboard with no analysts is indistinguishable from a client that failed
   to connect.

## Decision

`npm run demo` starts a Hardhat node, deploys the **real Ignition module**
against two `MockV3Aggregator` instances, publishes a new round every five
seconds, and serves the frontend already pointed at the addresses it just wrote
to `frontend/.env.local`. One command, three processes, one Ctrl-C.

The frontend picks its chain from `VITE_CHAIN_ID`, out of a two-entry table:
Sepolia and the local node. A build still targets exactly one chain.

Three Hardhat test accounts commit calls through the same public functions the
browser uses, reveal most of them, and abandon roughly one in five so the forfeit
path is visible without waiting for a stranger to misbehave.

Two protocol parameters are relaxed by an admin transaction after deployment:
the minimum horizon drops from one hour to two minutes, and the reveal window
from 48 hours to one.

## Consequences

- **The demo exercises the deployment, not a substitute for it.** It runs
  `ignition/modules/ProofOfCall.ts` with two parameters overridden, so a broken
  module breaks the demo. The resolver, the round search and settlement are the
  production paths reading a real `AggregatorV3Interface`.
- **The relaxed parameters are a real difference and are named in the UI.** A
  banner says the build is talking to a local node with mock feeds. The
  alternative — a demo that silently behaves unlike the deployment — is worse
  than one that explains itself.
- **The simulated analysts know one thing a browser does not:** which round ids
  this process published, so they skip the binary search. That is a shortcut in
  the _bots_, not in the protocol; the frontend's own reveal path still searches
  the aggregator for real, which is exactly the code worth exercising.
- **Explorer links had to become optional.** A local chain has no explorer, and
  an Etherscan link for an address that exists on one laptop looks live and
  lands on a 404. `explorerTx`/`explorerAddress` return `undefined` and
  `ExplorerLink` degrades to plain text.
- **`frontend/.env.local` is moved to `.env.local.bak` rather than overwritten.**
  It is where a real deployment's addresses and a WalletConnect project id live,
  and losing those to a demo run would be a bad trade.
- **The demo is not a test and does not gate CI.** It is a long-running process
  with randomness in it. The properties it appears to demonstrate are pinned by
  the suite in `test/`, which is what CI runs.

## Links

[[ADR-009-initial-protocol-parameters]] ·
[[ADR-010-settlement-reads-the-round-covering-the-deadline]] ·
[[ADR-012-generated-abi-committed-to-the-frontend]]
