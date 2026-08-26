---
title: Worklog
status: living
tags: [worklog, progress, handoff]
updated: 2026-08-26
---

# Worklog

Session-by-session record of what was built, what was decided, and what the next
session picks up. Architecture decisions live in [[decisions]]; the properties
the protocol claims live in [[invariants]]; the attacks and residual risks live
in [[threat-model]]. This file is the narrative and the handoff.

**Current position: contracts and frontend complete. F0–F6 done and committed.
What is left is not code — it is a Sepolia deployment, which needs a funded
wallet, and a first push to a remote, which needs a decision about commit
trailers.**

---

## Status board

| Phase | Scope                                        | State                                                     |
| ----- | -------------------------------------------- | --------------------------------------------------------- |
| F0    | Scaffold, hygiene, docs                      | done — 4 commits                                          |
| F1    | Oracle layer                                 | done — 1 commit                                           |
| F1.5  | Settlement at the deadline (`getPriceAt`)    | done — 1 commit. Not planned; see below                   |
| F2    | `commitCall`, state, events                  | done — 1 commit                                           |
| F3    | `revealCall`, `forfeit`, settlement, fuzzing | done — 1 commit                                           |
| F4    | Ignition deploy module                       | done — module written and tested on the simulated network |
| F6    | CI + docs                                    | done — GitHub Actions, invariants doc, threat model       |
| F5    | Frontend                                     | done — 1 commit. Four screens, type-checked and built     |
| —     | Actual Sepolia deployment + Etherscan verify | **next** — needs a funded faucet wallet                   |
| —     | First push to a remote                       | pending — CI has still never executed                     |

## Verify the current state in one command

```bash
npm run build && npm test && npm run lint && npm run format:check
```

Expected today: compiles, **122 passing** (116 node:test, 6 Solidity fuzz),
solhint silent, prettier clean.

The frontend is a separate package with its own lockfile:

```bash
npm run export-abi:check && npm --prefix frontend ci && npm run frontend:build
```

Expected: ABIs up to date, `tsc --noEmit` silent under `strict` plus
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, vite build green.
The chunk-size warning on the wallet bundle is RainbowKit and WalletConnect and
is expected.

`npm run coverage` reports `CallRegistry.sol` and `PriceOracleResolver.sol` at
**100.00 line / 100.00 statement**, 97.51% overall — the remainder is unexercised
branches in the test mocks.

---

## Session 1 — 2026-08-19 to 2026-08-21

Scaffold, docs, and the oracle layer. Six overrides to the original brief, each
with an ADR: pinned wagmi 2 against RainbowKit's peer range, per-feed staleness
instead of a global threshold, `Pausable` on commits only, viem assertions
instead of Chai, `committedAt` out of storage, `Above`/`Below` instead of
`Long`/`Short`. A fourth attack — the trivially safe target — was added to the
threat model and shipped as a known limitation rather than quietly omitted.

`PriceOracleResolver` landed with 30 tests and 100% coverage: `setFeed` probes
`decimals()` through `try/catch` so a mistyped aggregator fails at configuration
rather than at settlement, `getPrice` validates freshness before content, and
`decimals()` is read live on every call rather than cached — a cache that
disagreed with the feed would misprice by orders of magnitude **without
reverting**.

Full detail is in the git history; the parts still worth knowing are below under
_Environment facts_.

---

## Session 2 — 2026-08-23

Four commits: `getPriceAt`, `commitCall`, the reveal half, and deployment + CI.
The docs were rewritten to match.

### The thing that changed the design

F3 opened by writing `revealCall`, which was specified to call
`IPriceResolver.getPrice()` — `latestRoundData()`. That is wrong, and not in a
subtle way.

The reveal window is 48 hours. Reading the latest price at reveal time does not
settle a prediction at its deadline; it settles it at **whatever moment the
analyst chooses to send the transaction**. Commit "ETH above $3,000" for Friday
noon, watch it come in at $2,900, do nothing, and reveal on Sunday when it ticks
to $3,010. Every losing call is a free two-day option on being right later, and
the flawless-track-record problem the whole project exists to solve walks back in
through the settlement path.

Shortening the window does not fix it — it only prices it.

The fix is [[ADR-010-settlement-reads-the-round-covering-the-deadline]]:
`IPriceResolver` gained `getPriceAt(assetId, atTimestamp, roundId)`. Chainlink
has no timestamp-to-round index, so the round id comes from the caller and is
**verified rather than trusted** — it must exist, predate the timestamp, sit
inside the feed's staleness window relative to it, and have no successor that
also predates it. That last check is the one that closes the attack: without it
the revealer scans backwards and settles against whichever historical price
flatters them. Exactly one round satisfies all four for a given deadline.

Residual gap, named rather than hidden: `roundId + 1` cannot cross a Chainlink
phase boundary, because a round id is `(phaseId << 64) | aggregatorRoundId`. The
staleness bound caps the exploitable window at one heartbeat, on the single call
whose deadline lands inside an aggregator rotation.

### F2 — commit

Three storage decisions carry the weight, and all three are in the contract's
NatSpec:

- **`revealWindow` is snapshotted into each call at commit time.** Read live at
  reveal, an admin lowering it would retroactively close the window on open
  calls and force forfeits on analysts who did nothing wrong. `uint24` (~194
  days) is what makes the snapshot fit: `address` + `uint64` + `uint24` +
  `Status` is exactly 32 bytes, so the slot is full rather than a fourth slot
  being opened.
- **Commitment uniqueness is scoped per analyst, not globally.** The analyst is
  in the preimage, so two honest analysts cannot collide and a global mapping
  buys nothing — but it would hand a watcher a griefing move: front-run a
  broadcast commitment with the identical hash and the victim's own transaction
  reverts. Same single `SSTORE` either way.
- **The sum of open stakes is not stored**, for the same reason `committedAt` is
  not: derivable, and a cold `SSTORE` per commit to serve readers who can sum
  the calls themselves. Invariant 6 is asserted by summing in the tests.

`PAUSER_ROLE` is separate from `DEFAULT_ADMIN_ROLE` so the key that stops the
protocol in an incident need not be the key that can retarget the treasury. No
`receive` and no `fallback`: every wei in the contract arrived through
`commitCall`.

### F3 — reveal, forfeit, settlement

`revealCall` takes its plaintext as one `calldata` struct. That is partly
ergonomics and partly a hard constraint: with five separate parameters the
function does not fit in the EVM's sixteen stack slots, and the default build
profile deliberately leaves the optimizer off so coverage and stack traces stay
accurate.

`deadline` and `analyst` come from storage rather than calldata, so they cannot
be made to disagree with what was committed. `roundId` never enters the preimage
— it is a lookup key, not a prediction.

**On reentrancy, asked rather than reflexed.** Strict CEI already closes it:
`status` leaves `Committed` before any ETH moves, and no path returns a call to
`Committed`, so a re-entrant reveal or forfeit hits `CallNotOpen`. The guard is
kept anyway because the ordering is the _only_ thing holding it up and nothing at
the call site announces that — and under EIP-1153 (Cancun is already the target)
`ReentrancyGuardTransient` costs roughly 100 gas rather than a 20,000-gas cold
`SSTORE`. At 20,000 the answer might have gone the other way.
[[ADR-011-transient-reentrancy-guard-over-plain-cei]].

`forfeit` is permissionless because attack A depends on it: if only the analyst
could record their own forfeit, a hundred-call spray would leave the unrevealed
ninety-seven sitting in `Committed` and the visible record would still be
flawless.

ETH leaves through `call{value:}` with a checked return, never `transfer()` —
the 2,300-gas stipend is a hard-coded assumption about opcode pricing that has
already been invalidated once, and it would lock out a multisig treasury.

### Tests worth knowing about

- **The ADR-010 attack is a test, not a claim.** _"ignores a later price that
  would have flipped the outcome"_ commits a call, settles it wrong at the
  deadline, moves the price across the target a day later, and asserts the
  reveal still records a loss.
- **`ReentrantTreasury` wraps its callback in `try/catch`** so the failure does
  not simply bubble up as `StakeTransferFailed`. The test then asserts the
  re-entrant call was rejected _and_ the stake moved exactly once — which is what
  distinguishes "the attack failed" from "the whole transaction reverted".
- **Six Solidity fuzz properties** over the commitment, in `CommitmentFuzz.t.sol`.
  The TypeScript suite asserts named scenarios; the fuzzer searches for the input
  nobody thought to write down, which is exactly the risk profile of a hash.
- **The Ignition module is executed by a test** on the simulated network, with
  mock aggregators substituted for the two Sepolia proxies. A deploy script that
  has never run is a guess, and the place it fails is Sepolia, after gas.

### Problems hit, and the fixes

| Symptom                                                                   | Cause                                                                                    | Fix                                                                                  |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `CompilerError: Stack too deep` in `revealCall`                           | Six parameters stay live to the end of the frame; the optimizer is off in `default`      | Group the plaintext into a `calldata` struct — one stack slot instead of five        |
| Fuzz test reverted with `NotAnalyst`, caller was the test contract        | `registry.minStake()` **inside** `commitCall{value: ...}` spends the one-shot `vm.prank` | Read `minStake()` into a local before the prank                                      |
| `vm.expectPartialRevert` also spends a pending `vm.prank`                 | Same one-shot semantics                                                                  | `vm.startPrank` / `vm.stopPrank` around the pair                                     |
| Access-control test failed with an unhandled rejection before any `await` | Building an array of promises fires every transaction eagerly                            | Store thunks, call them inside the loop                                              |
| solhint `ordering` errors                                                 | HH3/solhint want external → public → private                                             | `computeCommitment` after the external views; `_requireOpenAndOwned` after `_settle` |
| solhint `use-natspec` on admin events and constants                       | Every declaration needs `@notice`, events need `@param` per field                        | Written out; they are the audit trail for admin actions anyway                       |

### Answers to the three control questions owed from F0

All three are written up in [[threat-model]]:

1. **Removing `analyst` from the preimage** — a step-by-step reputation theft:
   Mallory copies Alice's commitment hash into her own call, waits for Alice's
   reveal to hit the mempool, lifts the four plaintext fields and opens _her_
   call with them at a higher priority fee. She ends up with an identical,
   identically-timestamped winning call she never made. The stake is untouched,
   which is why the attack is easy to miss when auditing for fund loss.
2. **`abi.encode` over `abi.encodePacked`** — the tuple is all fixed-size today,
   so both are safe _today_. The ambiguity is a property of the type list, not of
   the call: adding one variable-length field later turns a safe encoding into a
   collidable one with no compile error and no failing test. ~100 gas against a
   ~45,000-gas commit.
3. **Reverting on a stale feed** — a flag has to be checked, and the failure mode
   of an unchecked flag is silence. If a feed dies permanently while a call is
   open, **the analyst loses the stake and it is not fair**: an oracle outage is
   written into their public record as evasion. Bounded by `maxHorizon` and a
   swappable resolver; the real fix is a `Voided` state, which needs a governance
   answer the MVP does not have. Shipped as limitation 7.

---

---

## Session 3 — 2026-08-26

F5. One commit: the whole frontend, plus the ABI generator and a second CI job.

### Shape

`frontend/` is a separate npm package with its own lockfile, not a workspace —
one less build-system concept in a repository whose primary toolchain is
Hardhat, and CI installs the two independently anyway. React + Vite + wagmi
2.19.5 + RainbowKit 2, four routes: Commit, Calls, Leaderboard, Vault.

No CSS framework. The whole surface is four pages of forms and tables, and a
utility framework would have added a build step and a class vocabulary in
exchange for markup that reads worse than one stylesheet with tokens at the top.

### The three places a mistake costs a stake rather than an error

1. **The commitment is hashed by the contract.** `computeCommitment` is `public
pure` precisely so the frontend never re-implements `abi.encode`. A divergence
   between the two encodings does not throw and does not fail a test — it
   produces a commitment nobody can open.
2. **The salt is written to the vault before the transaction is signed.** Signing
   first leaves a window in which a closed tab loses the salt for a call that is
   already on-chain and already holding money. `crypto.getRandomValues` only; a
   missing CSPRNG blocks the commit rather than falling back, because a weak salt
   looks exactly like a strong one.
   [[ADR-013-salt-custody-is-browser-local]].
3. **The asset picker only offers assets with a feed on this deployment**,
   checked against `isSupported`. `commitCall` takes a hash and cannot check; a
   call against an unconfigured asset commits fine and can never be revealed.

### The round search

`lib/roundSearch.ts` is the off-chain half of ADR-010 and the reason the contract
is not usable from a block explorer alone. Binary search over `getRoundData`,
sound because `updatedAt` is monotonic within a phase.

Details worth not rediscovering:

- A round id is `(phaseId << 64) | aggregatorRoundId`. The search decomposes
  `latestRoundData().roundId`, searches `[1, latestInPhase]`, and recomposes.
- If the feed has not published since the deadline, the latest round _is_ the
  answer and there is no successor to reject it — a separate branch, not a
  degenerate case of the search.
- A `getRoundData` that reverts is treated as "not found" and the search moves
  left. Same normalization `PriceOracleResolver._readRound` does on-chain; within
  a live phase the gaps are at the top, not the bottom.
- The phase boundary is not crossed. The reveal form exposes a manual round id
  for that case rather than silently returning the wrong round — ADR-010's
  residual gap, surfaced instead of hidden.

### State versus events

`useCalls` fetches contract state by multicall over `getCall` — authoritative,
cannot be missed — and the reveal plaintext and `committedAt` from logs, because
neither is stored. The log half is best-effort and wrapped in a `try`: a public
Sepolia endpoint that refuses the range costs the leaderboard its weighting, not
the app its correctness, and `logsAvailable` tells the UI which happened. Log
queries are chunked and halve on a range error, since an over-wide range returns
an error rather than partial data.

### Leaderboard

Counts from chain state. The ranking weights each call by
`|target - spot at commit| / spot at commit`, capped, minus a flat penalty per
forfeit set equal to the reference weight — silence should cost about what an
ordinary loss costs, or it becomes the cheap exit.
[[ADR-014-leaderboard-weights-calls-off-chain]].

The spot price at commit is fetched by the same binary search, serially so a
public endpoint does not rate-limit the page, cached in `localStorage` because a
past price never changes. Calls whose spot cannot be recovered are counted and
shown as unweighted rather than guessed at.

### Problems hit, and the fixes

| Symptom                                                        | Cause                                                                                                 | Fix                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `vite build` failed: `"sendCallsSync" is not exported by viem` | viem pinned at 2.37.6; the `@wagmi/core` 2.22.1 that wagmi 2.19.5 resolves needs a newer one          | viem pinned to 2.56.0. wagmi stays on the 2.x line per ADR-001             |
| Blank page, `Uncaught Error: No projectId found`               | RainbowKit's `connectorsForWallets` validates the project id even with no WalletConnect wallet listed | Fall back to wagmi's own `injected()` connector when the env var is absent |
| `exactOptionalPropertyTypes` rejected the vault merge          | Spreading a `number \| undefined` into a field typed `number?`                                        | Spread conditionally instead of unconditionally                            |

Verified by loading the built bundle in a real browser: all four routes render
with an empty console.

## Environment facts worth not rediscovering

- Repo path contains a space (`04_PROYECTOS/Proof of Call`). Nothing has broken,
  but it is the first suspect for any strange path error.
- Git identity is **repo-local**, not global: `Ciro Urrustarazu`,
  `67176499+cirola@users.noreply.github.com`.
- Commits carry a `Co-Authored-By: Claude Opus 5` trailer. Still trivial to strip
  while no remote exists, painful after.
- **No remote is configured.** Nothing has been pushed anywhere. CI is written
  and will run on the first push to GitHub, but has never executed.
- `forge-std` is installed from **GitHub** (`foundry-rs/forge-std#v1.9.7`), not
  from the `forge-std` npm package — that one is an unofficial third-party
  mirror pinned at 1.1.2. `npm ci` therefore needs git, which the CI runner has.
- Files over roughly 150 lines have to be written with the editor tool; long
  `cat <<'EOF'` heredocs get truncated by the shell bridge.
- Never write `@scope/package` inside a NatSpec comment — solc parses the `@` as
  a doc tag and fails with `DocstringParsingError`.

---

## Next session — start here

There is no code left in the plan. Two things stand between this and done, and
both need a decision rather than a keyboard.

### 1. Decide about the remote, before there is one

- **Strip the `Co-Authored-By: Claude Opus 5` trailers** if this is going public.
  Trivial while no remote exists, painful afterwards.
- Then add a remote and push. **CI has never executed.** It is written and now
  has two jobs — contracts, and the frontend build with the ABI drift check — and
  the first push is the first time either runs.

### 2. The Sepolia deployment

`npm run deploy:sepolia` is wired and the module is exercised by a test on the
simulated network, but it has never been pointed at a real chain. It needs:

- A dedicated, disposable wallet funded from a faucet. Never one that has touched
  mainnet.
- The three keystore secrets set (`SEPOLIA_RPC_URL`, `SEPOLIA_PRIVATE_KEY`,
  `ETHERSCAN_API_KEY`).
- A check that the two Chainlink proxy addresses in the module are still the
  current Sepolia ones before spending gas.
- A decision on the build profile: the module currently deploys the `default`
  profile, which has the optimizer **off** on purpose so coverage and stack
  traces stay accurate. Anything real should go out with `production`.

Afterwards:

- Paste the deployed addresses and the Etherscan links into the README status
  block, and record the feed addresses actually used so a future deprecation can
  be traced.
- Fill `frontend/.env.local` with the two addresses, `VITE_DEPLOY_BLOCK` (the
  block the registry landed in — log queries start there instead of at zero), and
  an RPC URL that answers `eth_getLogs`.
- Walk one call end to end on Sepolia: commit, wait out a short horizon, run the
  round search, reveal. That is the first time the binary search meets a real
  Chainlink feed, and it is the single highest-value test left.

### Smaller things, if time allows

- **A WalletConnect project id.** Without one the client is injected-wallets-only,
  which the footer states rather than hides.
- **Gas snapshot.** `hardhat test --gas-stats` exists; a committed baseline would
  make the storage-layout arguments in the ADRs checkable rather than asserted.
- **Exclude `contracts/mocks/` from coverage** so the number reported is about the
  protocol. The mocks are the only thing below 100%.
- **Encrypt the vault at rest** with a passphrase. It would raise the cost of a
  stolen backup file; it does not change the XSS story, which is already the
  origin's problem.
- **Frontend tests.** There are none. The two worth writing are `roundSearch`
  against a mock aggregator, and the `parsePrice` boundary — both are places
  where being wrong is silent.
