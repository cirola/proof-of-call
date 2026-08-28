# Checkpoint — what is done, what is left

Written 2026-08-28, after the first push. This is the single page to read before
picking the project back up. [`worklog.md`](./worklog.md) is the narrative of how
it got here; this is the state it is in and the work still owed.

---

## Where it stands

Everything in the plan is built. The protocol has never been deployed to a
public chain, and that is the only thing between here and finished.

| Piece              | State                                                                 |
| ------------------ | --------------------------------------------------------------------- |
| Contracts          | Done. 1,027 lines across the registry, the resolver and the interface |
| Tests              | Done. 122 passing — 116 TypeScript scenarios, 6 Solidity fuzz         |
| Coverage           | 100% lines and statements on both production contracts                |
| Deployment module  | Written and exercised by a test on the simulated network              |
| Frontend           | Done. Four routes, type-checked, builds clean                         |
| Local demo         | Done. `npm run demo`, one command, no keys                            |
| CI                 | Green. Two jobs, both passing on GitHub Actions                       |
| Sepolia deployment | **Not done.** Needs a funded faucet wallet — see below                |

Verify all of it in one command:

```bash
npm run build && npm test && npm run lint && npm run format:check && npm run export-abi:check
```

If that passes and `npm run demo` shows a call going from committed to revealed,
nothing is broken.

---

## What each piece is, and why it exists

Read this part once. Every entry answers "why is this here" rather than "what
does this do" — the code says what it does.

### The contracts

**`CallRegistry.sol`** holds one idea: a prediction that can be edited after the
outcome is known is not a prediction. An analyst submits a hash plus a stake, and
can later open it — but only into the shape they fixed before they knew how it
turned out.

The parts worth understanding:

- **The commitment is `keccak256(abi.encode(assetId, direction, targetPrice, deadline, salt, analyst))`.**
  `abi.encode`, never `encodePacked`: packed encoding concatenates without length
  information, so distinct tuples can flatten to identical bytes. `analyst` is in
  the preimage so a watcher who sees a reveal in the mempool cannot open a
  commitment they copied earlier.
- **`forfeit` is callable by anyone.** This is the whole answer to selective
  reveal. If only the analyst could record their own forfeit, a hundred-call
  spray would sit in `Committed` forever and the visible record would stay
  flawless. Anyone can close an overdue call; the stake goes to the treasury and
  the forfeit lands in the analyst's public counters.
- **`revealWindow` is snapshotted per call at commit time**, not read live. An
  admin who shortened the global window would otherwise retroactively close the
  window on calls already open, forcing forfeits on people who did nothing wrong.
- **Pause blocks commits only.** A pause that could reach `revealCall` would let
  an admin run out the reveal window and strand user funds — a confiscation
  switch, not an emergency brake.
- **The struct is three slots**, and the first is exactly full: 20 + 8 + 3 + 1 =
  32 bytes. `committedAt` is deliberately not stored — no on-chain path reads it,
  and a cold `SSTORE` to a fourth slot would cost every analyst 20,000 gas to
  serve readers who are reading the event anyway.

**`PriceOracleResolver.sol`** is the Chainlink adapter, and the registry never
learns what an oracle is. It handles three things Chainlink gets wrong if you
trust it naively: staleness (per feed, not global — a feed's heartbeat is a
property of that feed), decimal normalization to 8, and rejecting non-positive
answers.

Its hard part is `getPriceAt(assetId, deadline, roundId)`. Settlement reads the
**last round at or before the deadline**, not the latest round. Settling against
the latest round would settle against whatever moment the analyst chose to send
the reveal, which hands them a free option over the entire reveal window. The
round id is passed in but **verified, not trusted**: the round must exist,
predate the deadline, sit inside the staleness window relative to the deadline,
and have no successor that also predates it. Exactly one round satisfies all
four.

**`IPriceResolver.sol`** is the seam. Everything Chainlink-specific lives on one
side of it, which is what makes a different oracle a new adapter rather than a
rewrite.

### The off-chain half

Finding that round id is the frontend's job, and it is the reason the contract is
not usable from a block explorer alone. Chainlink publishes no
timestamp-to-round index, so `frontend/src/lib/roundSearch.ts` binary-searches
`getRoundData` — sound because `updatedAt` is monotonic within a phase. A round
id is `(phaseId << 64) | aggregatorRoundId`; rotating the aggregator behind a
proxy bumps the phase and restarts the inner counter, so the search stays inside
the current phase and reports the boundary case rather than silently returning
the wrong round.

### The frontend

Four routes. Three of them do work the contracts cannot do for themselves.

- **Commit** — the asset picker is limited to assets that actually have a feed on
  the connected deployment. `commitCall` takes a hash and cannot check, so this
  list is the only thing standing between a user and a call that can never be
  revealed. The commitment is computed by calling the contract's own `pure`
  `computeCommitment` rather than re-implementing `abi.encode` in TypeScript,
  where a divergence would surface as a lost stake and no error message.
- **Vault** — salt custody, given a page rather than a tooltip. Losing a salt is
  unrecoverable, and the UI says so in those words.
- **Calls** — reveal and forfeit. Reveal runs the round search as an explicit
  step because it makes a dozen RPC calls and can legitimately fail.
- **Leaderboard** — counts come from chain state; the ranking is weighted by how
  far each target sat from spot at commit time, computed off-chain, with the
  formula printed under the table and labelled as a claim by this frontend. A raw
  win count is gameable — "ETH above $1" resolves correct every time, and the
  contract cannot notice, because it received a hash.

### The demo

`npm run demo` runs the **real** Ignition module against mock aggregators, drives
the price, and simulates three analysts. It exists because the alternative first
impression was a faucet and an hour of waiting. It found three real frontend
defects that the test suite could not have caught, all chain-shaped rather than
logic-shaped — the worst of them failed completely silently. See
[ADR-015](./decisions/ADR-015-local-demo-harness-with-simulated-analysts.md).

---

## What is left

Four items. Only the first is blocking.

### 1. Deploy to Sepolia — blocking, needs a human

Nothing in this list is a code change. It is credentials and one careful run.

- [ ] **A dedicated, disposable wallet.** Created fresh, funded only from a
      faucet. Never one that has touched mainnet or holds real funds.
- [ ] **Faucet ETH.** ~0.05 Sepolia ETH is plenty — the deployment is two
      contracts and two `setFeed` calls.
- [ ] **An RPC endpoint that answers `eth_getLogs` over a wide range.** Alchemy
      or Infura on the free tier. The public Sepolia endpoint is rate-limited and
      will make the round search crawl and the leaderboard fail to load.
- [ ] **An Etherscan API v2 key.** One key covers every supported chain.
- [ ] **The three secrets in the keystore**, never in a file:

      ```bash
          npx hardhat keystore set SEPOLIA_RPC_URL
          npx hardhat keystore set SEPOLIA_PRIVATE_KEY
          npx hardhat keystore set ETHERSCAN_API_KEY
          ```

- [ ] **Confirm the two Chainlink proxy addresses** in
      `ignition/modules/ProofOfCall.ts` are still the current Sepolia ones. They
      are proxies precisely so they survive aggregator rotations, but a
      deprecated feed is a protocol that cannot settle.
- [ ] **Deploy.** `npm run deploy:sepolia` — deploys the resolver, registers both
      feeds, deploys the registry pointed at it, and verifies on Etherscan, in
      that order. It builds with `--build-profile production`, so the optimizer
      is on.

**Acceptance:** both contracts verified on Etherscan, and
`resolver.isSupported(BTC_USD)` and `isSupported(ETH_USD)` both return true.

### 2. Point the frontend at it

- [ ] Copy `frontend/.env.example` to `frontend/.env.local` and fill in
      `VITE_REGISTRY_ADDRESS`, `VITE_RESOLVER_ADDRESS`, `VITE_DEPLOY_BLOCK` (the
      block the registry landed in) and `VITE_RPC_URL`.
- [ ] Paste the addresses and the Etherscan links into the README status block,
      and record the feed addresses actually used, so a future deprecation can be
      traced.

**`VITE_DEPLOY_BLOCK` is the one that fails quietly.** Left at zero, log queries
start at genesis; against a rate-limited endpoint that means the leaderboard
never loads and nothing anywhere reports an error.

### 3. Walk one call end to end on Sepolia

- [ ] Commit a call with a short horizon.
- [ ] Wait out the deadline.
- [ ] Run the round search and reveal.

This is the single highest-value test left. It is the first time the binary
search meets a real Chainlink feed rather than a mock this repository controls,
and the first time settlement reads a round nobody here published.

### 4. Smaller things, in value order

- [ ] **A WalletConnect project id** (free, cloud.reown.com) in
      `VITE_WALLETCONNECT_PROJECT_ID`. Without one the client is
      injected-wallets-only, which the footer states rather than hides.
- [ ] **Frontend tests.** There are none. The two worth writing are `roundSearch`
      against a mock aggregator and the `parsePrice` boundary — both are places
      where being wrong is silent.
- [ ] **Exclude `contracts/mocks/` from coverage** so the number reported is
      about the protocol. The mocks are the only thing below 100%.
- [ ] **A gas snapshot.** `hardhat test --gas-stats` exists; a committed baseline
      would make the storage-layout arguments in the ADRs checkable rather than
      asserted.
- [ ] **A recorded walkthrough of `npm run demo`** in the README, so a reader can
      see the commit → reveal loop without cloning anything.

---

## Things that are true and easy to forget

- **The history is public now.** The `Co-Authored-By` and `Claude-Session`
  trailers were stripped from all 14 commits immediately before the first push,
  with the trees verified byte-identical. A second rewrite would break every
  clone; do not do it.
- **Tests and coverage run on the `default` build profile with the optimizer
  off**, on purpose, so line hit-counts and stack traces stay accurate. Only
  deployments use `production`.
- **`forge-std` comes from GitHub**, not from the npm package of that name — that
  one is an unofficial mirror pinned at 1.1.2. `npm ci` therefore needs git.
- **ABIs are generated and committed.** After any contract change: rebuild, then
  `npm run export-abi`, then commit. CI fails on drift.
- **The repository path contains a space.** Nothing has broken, but it is the
  first suspect for any strange path error.
