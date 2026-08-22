---
title: Worklog
status: living
tags: [worklog, progress, handoff]
updated: 2026-08-21
---

# Worklog

Session-by-session record of what was built, what was decided, and what the next
session picks up. Architecture decisions live in [[decisions]]; this file is the
narrative and the handoff.

**Current position: F1 complete and committed. F2 not started.**

---

## Status board

| Phase | Scope                                         | State                                                    |
| ----- | --------------------------------------------- | -------------------------------------------------------- |
| F0    | Scaffold, hygiene, docs                       | done — 4 commits                                         |
| F1    | Oracle layer                                  | done — 1 commit, 30 tests, 100% coverage on the resolver |
| F2    | `commitCall`, state, events                   | **next**                                                 |
| F3    | `revealCall`, `forfeit`, settlement, fuzzing  | pending                                                  |
| F4    | Ignition deploy to Sepolia + Etherscan verify | pending                                                  |
| F5    | Frontend                                      | pending                                                  |
| F6    | CI + final docs                               | pending                                                  |

## Verify the current state in one command

```bash
npm run build && npm test && npm run lint && npm run format:check
```

Expected today: compiles, **30 passing**, solhint silent, prettier clean.
Coverage: `npx hardhat test --coverage` reports `PriceOracleResolver.sol` at
100.00 line / 100.00 statement.

---

## Session 1 — 2026-08-19 to 2026-08-21

### Before any code: the brief was reviewed and six things were changed

The original brief was treated as a proposal, not as gospel. Each override has
its own ADR; the short version:

| #                                        | Change                             | Why it mattered                                                                                                                                                                           |
| ---------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [[ADR-001-pin-wagmi-v2]]                 | Pin `wagmi@2.19.5`                 | `wagmi@3.7.6` is current, but RainbowKit 2.2.11 declares `wagmi: "^2.9.0"` and ships no v3 line. `npm install wagmi` would break the peer range.                                          |
| [[ADR-002-per-feed-staleness-threshold]] | Staleness per feed, not global     | Heartbeats differ per feed; one global value is too strict for the slow feed or too loose for the fast one. Also dropped the `answeredInRound >= roundId` check — dead code on OCR feeds. |
| [[ADR-003-pause-blocks-commit-only]]     | `Pausable` gates `commitCall` only | A pause reaching `revealCall` lets an admin run out the reveal window and destroy user stakes. That is a confiscation switch, not an emergency brake.                                     |
| [[ADR-005-viem-assertions-over-chai]]    | Drop Chai                          | The contracts use custom errors exclusively. Chai would degrade to substring-matching formatted messages; `hardhat-viem-assertions` decodes against the ABI.                              |
| [[ADR-006-drop-committedat-from-struct]] | `committedAt` out of storage       | It occupied a whole 4th slot (20,000 gas per commit) and no on-chain path reads it. It lives in `CallCommitted` instead.                                                                  |
| [[ADR-007-above-below-not-long-short]]   | `Direction { Above, Below }`       | "Long/Short" names a position with scaling P&L. This contract stores a binary claim about where a price sits at one timestamp.                                                            |

**A fourth attack was added to the threat model.** The brief covered selective
reveal, commit brute force and stale oracles. It did not cover the _trivial
target_: commit "ETH above $1" a hundred times and every call reveals as a win.
[[ADR-004-trivial-target-measured-off-chain]] records why the defence is
computed off-chain for the MVP, and it ships as known limitation #5 in the
README rather than being quietly omitted.

**Protocol parameters were fixed** in [[ADR-009-initial-protocol-parameters]]:
`minStake` 0.001 ETH, `minHorizon` 1 hour, `maxHorizon` 30 days, `revealWindow`
48 hours, assets BTC/USD and ETH/USD.

### F0 — Scaffold

Installed, with versions verified against the registry at install time rather
than taken from the brief:

```
hardhat 3.13.0   @nomicfoundation/hardhat-toolbox-viem 5.0.7
@openzeppelin/contracts 5.6.1   @chainlink/contracts 1.5.0
solhint 6.2.4   prettier + prettier-plugin-solidity 2.4.1
```

One toolbox package instead of individually installed plugins: it version-locks
ignition, keystore, viem, verify, network-helpers and the `node:test` runner
against each other.

`hardhat.config.ts` carries two solc profiles. `default` leaves the optimizer
**off** so stack traces and coverage line maps stay accurate; `production`
enables it. Running coverage against optimized bytecode produces hit-counts that
do not match the source.

Secrets go through `configVariable()`, which resolves from the encrypted Hardhat
keystore before falling back to the environment. `.env.example` documents names
only.

`contracts/interfaces/IPriceResolver.sol` was written in F0 rather than F1 — it
defines the boundary F1 implements, and it makes `hardhat build` verify
something real instead of compiling an empty directory.

### F1 — Oracle layer

Three files: `PriceOracleResolver.sol`, `mocks/MockV3Aggregator.sol`, and
`test/PriceOracleResolver.test.ts`.

**Storage.** `FeedConfig { AggregatorV3Interface aggregator; uint32 staleAfter; }`
is 20 + 4 bytes, so a feed configuration is exactly one slot. Registering a feed
and setting its threshold is one atomic call, which makes the "registered but
threshold still zero" state — which would refuse every price — unreachable.

**`setFeed` probes `decimals()` through `try/catch`.** A mistyped aggregator
address is a realistic deployment error. Without the probe it stays invisible
until the first reveal, where it surfaces as a failed settlement with money on
the line instead of a failed configuration transaction.

**`getPrice` validates freshness before content**, in this order:
`RoundNotComplete` (`updatedAt == 0`), `FutureTimestamp`, `StalePrice`,
`NonPositivePrice`. The future-timestamp check exists so the staleness
subtraction cannot underflow into an anonymous arithmetic panic.

**`decimals()` is read live on every call, not cached at registration.** Caching
saves one `STATICCALL` per settlement; a cache that disagreed with the feed would
misprice by ten orders of magnitude and settle stakes against the wrong number
_without reverting_. Asymmetric trade, so the gas is paid.

**The mock is hand-written**, not imported from the Chainlink package. Their own
mock stamps `block.timestamp` on every update, which makes the staleness path
unreachable in tests. Ours exposes `setUpdatedAt` and `setRoundData`. It
implements the _Chainlink_ interface rather than `IPriceResolver`, so tests
exercise the real adapter's normalization and freshness code instead of stubbing
it out.

**Tests worth knowing about:**

- The staleness boundary is asserted on both sides — age `== threshold` passes,
  age `== threshold + 1` reverts — so an off-by-one cannot cause spurious
  settlement failures on a healthy feed.
- Two feeds at the same age with different thresholds produce opposite outcomes.
  That test is the per-feed argument made executable; a global threshold could
  not produce it.
- `setFeedAge()` pins the observing block timestamp with
  `time.setNextBlockTimestamp` + `mine`. Writing `now - age` and reading back
  drifts, because every transaction mines a block and moves the clock.

### Problems hit, and the fixes

| Symptom                                                                | Cause                                                                     | Fix                                                                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DocstringParsingError: Documentation tag ... not valid for contracts` | solc parses a package name beginning with `@` inside NatSpec as a doc tag | Never write `@scope/package` in a NatSpec comment                                                                                                             |
| `assertions.revert` failed on `InvalidAdmin()`                         | `revert` asserts a _non_-custom error by design                           | Use `revertWithCustomError`, passing an already-deployed instance purely as the ABI                                                                           |
| `hre.network.connect() is deprecated`                                  | HH3 API moved                                                             | `await network.getOrCreate()` in test files                                                                                                                   |
| Long `cat > file <<'EOF'` heredocs failed with `unexpected EOF`        | The shell bridge truncates long commands                                  | Write files over roughly 150 lines with the editor tool, not shell heredocs                                                                                   |
| solhint `gas-indexed-events`, `gas-strict-inequalities` warnings       | Micro-gas rules that hurt readability                                     | Turned off in `.solhint.json`. Indexing a `uint32` nobody filters by costs gas on every write; `answer <= 0` is clearer than `answer < 1` for a signed value. |

### Environment facts worth not rediscovering

- Repo path contains a space (`04_PROYECTOS/Proof of Call`). Nothing has broken
  so far, but it is the first suspect for any strange path error.
- Git identity is **repo-local**, not global: `Ciro Urrustarazu`,
  `67176499+cirola@users.noreply.github.com` (GitHub noreply, so the real address
  never lands in a public history).
- Commits carry a `Co-Authored-By: Claude Opus 5` trailer. Open question for a
  portfolio repo — trivial to strip **before** a remote exists, painful after.
- Coverage counts `contracts/mocks/`, which sits around 57% because parts of the
  mock are not exercised yet. F3 uses more of it. If the F3 global target of 90%
  is missed only because of the mock, exclude mocks from coverage rather than
  writing tests for a test double.
- No remote is configured. Nothing has been pushed anywhere.

---

## Next session — start here

### F2 — `commitCall`

Design already settled, so this is implementation rather than decision-making.

```solidity
enum Status {
  None,
  Committed,
  RevealedWin,
  RevealedLoss,
  Forfeited
}
enum Direction {
  Above,
  Below
}

struct Call {
  address analyst; // slot 0, packed with the two below
  uint64 deadline;
  Status status;
  bytes32 commitment; // slot 1
  uint256 stake; // slot 2
}

struct AnalystStats {
  uint32 committed;
  uint32 wins;
  uint32 losses;
  uint32 forfeited;
}
```

`commitCall(bytes32 commitment, uint64 deadline) external payable whenNotPaused`

Reverts when: `msg.value < minStake`; `deadline` outside
`[block.timestamp + minHorizon, block.timestamp + maxHorizon]`; the commitment
was already used. Custom errors only, no `require` strings.

Decisions to carry in from F0:

- **Snapshot the reveal window per call at commit time** — store the deadline
  plus the window rather than reading `revealWindow` live at reveal, so an admin
  shortening it cannot retroactively force forfeits on open calls
  ([[ADR-009-initial-protocol-parameters]]).
- **Commitment uniqueness needs its own mapping** (`bytes32 => bool`), which is
  a second cold `SSTORE` per commit. Worth stating explicitly in the commit
  message: it buys invariant 1.
- `CallCommitted` must carry `block.timestamp`, because `committedAt` is not in
  storage ([[ADR-006-drop-committedat-from-struct]]) and the frontend countdown
  plus the off-chain edge metric both need it.
- Index `analyst` and `callId` on the events; the leaderboard filters by analyst.

Acceptance: invariants 1 and 6 tested. **Invariant 6 is `>=`, not `==`** —
`selfdestruct` and block rewards can force ETH into the contract without touching
`receive()`, so `balance == sum(stakes)` is falsifiable while
`balance >= sum(stakes)` is the real property.

### F3 — reveal, forfeit, settlement

`revealCall(uint256 callId, bytes32 assetId, Direction dir, int256 targetPrice, bytes32 salt)`
and `forfeit(uint256 callId)`.

- Strict checks-effects-interactions: write `status` **before** transferring ETH.
- ETH out with `call{value:}` and a checked return `bool`, never `transfer()`.
- `Above` wins on `price >= targetPrice`, `Below` on `price <= targetPrice`.
  Equality is a win for both — deliberate, documented in
  [[ADR-007-above-below-not-long-short]].
- `forfeit` is public on purpose: a third party can settle an abandoned call, so
  the record never depends on the loser showing up to log their own loss.
- Open question to answer with reasoning, not reflex: is `ReentrancyGuard`
  actually needed given strict CEI, or is it defence in depth? Write the answer
  into the commit message either way.
- At least one Solidity fuzz test in `test/solidity/` over commitment
  verification.

Acceptance: all 8 invariants from the brief's section 4.2, global coverage 90% or
better.

### Owed from F0 — three control questions, still unanswered

Per the working agreement these gate the next phase. They are the ones an
interviewer will ask about this project.

1. Remove `analyst` from the commitment preimage. Describe the concrete theft,
   step by step: who watches what, when, and what they submit. (The reveal sits
   in the mempool before it is mined.)
2. Why `abi.encode` and not the cheaper `abi.encodePacked` here?
3. Why does the resolver revert on a stale feed instead of returning the last
   known price with a warning flag — and if a feed dies permanently while a call
   is open, who loses the stake, and is that fair?
