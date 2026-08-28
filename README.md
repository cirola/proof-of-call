# Proof of Call

An on-chain registry for market predictions, where the track record includes the
losses because the protocol will not let you delete them.

> **Status:** contracts and frontend complete, and runnable locally in one
> command — see [See it running](#see-it-running). Scaffold, oracle layer, full
> commit-reveal lifecycle, Ignition deployment module, CI, the React client and
> the demo harness are done. 122 tests, 100% line and statement coverage on both
> production contracts. Deployment links land when the Sepolia deployment is run.

---

## See it running

```bash
npm install
npm run frontend:install
npm run demo
```

One command. It starts a Hardhat node, deploys the real Ignition module against
mock Chainlink aggregators, publishes a new price round every five seconds, and
serves the frontend already pointed at the addresses it just deployed —
`http://localhost:5173`. Ctrl-C stops all three.

Three simulated analysts commit calls, reveal most of them, and abandon some, so
the registry, the leaderboard and the forfeit path have something in them within
a few minutes. To make your own call, add the network to MetaMask
(`http://127.0.0.1:8545`, chain id `31337`) and import one of the private keys
the node prints.

Two protocol parameters are relaxed for the demo: the minimum horizon drops from
one hour to two minutes, and the reveal window from 48 hours to one, so the
commit → wait → reveal loop fits inside a coffee break. Everything else is the
deployment Sepolia gets. The contracts, the resolver, the round search and
settlement are the production ones; the only fiction is who publishes the rounds.

Nothing here touches a public chain, and the state disappears when the node
stops.

---

## The problem

Every crypto analyst publishes the calls they got right. Screenshots of the wins,
silence on the rest. There is no way to audit anyone's track record, because the
record is whatever the person showing it chose to keep, and the deleted half is
exactly the half that would tell you whether to listen to them.

Proof of Call makes the record immutable **including the mistakes**, and does not
ask you to trust anybody — not the analyst, and not the people running the site.

## How it works

An analyst does not publish a prediction. They publish a _commitment_ to one, put
money behind it, and are forced to open it later.

```
COMMIT                        REVEAL                       SETTLE

keccak256(                    reveal the plaintext         contract reads
  assetId, direction,   -->   parameters; contract   -->   a Chainlink feed
  targetPrice, deadline,      re-hashes and checks         and decides
  salt, analyst               they match the commit        win / loss
)
+ ETH stake                                                      |
                                                                 v
prediction is timestamped                            win     ->  stake returned
but unreadable                                       loss    ->  stake slashed
                                                     silence ->  stake slashed
```

1. **Commit.** The analyst submits `keccak256` of their prediction — asset,
   direction, target price, deadline, a random salt, and their own address — plus
   an ETH stake. The prediction is timestamped on-chain and unreadable to
   everyone, including the analyst's followers.
2. **Reveal.** After the deadline, the analyst submits the parameters in the
   clear. The contract re-computes the hash and rejects anything that does not
   match the original commitment. The prediction cannot be edited after the fact,
   because the hash was fixed before the outcome was known.
3. **Resolution.** The contract reads a Chainlink price feed and decides the
   outcome itself. Nobody adjudicates, and there is nothing to appeal.
4. **Settlement.** Right: the stake comes back. Wrong, or never revealed: the
   stake is gone.

## The four attacks the design exists to answer

The mechanism above is easy. What makes it hold up is what happens when someone
tries to game it. These are the attacks that shaped the contracts. The first
three come from the brief; the fourth was found while writing the settlement
code, and it would have quietly undone all three.

### A. Selective reveal — lying by omission

Nothing forces an analyst to open a commitment. So: commit a hundred calls,
reveal the three that came in, walk away from the rest. The visible record is
flawless.

**Answer.** Silence has a price and leaves a mark. Missing the reveal window
costs the entire stake, and the unrevealed commitment stays on-chain and is
counted in the analyst's public stats as a forfeit. `forfeit()` is callable by
_anyone_, not just the analyst, so the settlement does not depend on the loser
showing up to record their own loss.

A hundred-call spray now costs a hundred stakes and produces a track record with
ninety-seven visible forfeits. The strategy still exists — it is just no longer
free, and no longer invisible.

### B. Brute-forcing the commitment

A commitment only hides a prediction while the input space is large. The input
space here is tiny: a handful of assets, two directions, target prices that
humans pick as round numbers, deadlines on hour boundaries. Without a salt, an
attacker enumerates every plausible prediction, hashes each one, and reads the
call off the chain before the analyst reveals it.

**Answer.** A 256-bit salt generated with a CSPRNG — `crypto.getRandomValues` in
the browser, never `Math.random`, which is deterministic, seeded from a small
state, and predictable from its own output.

The salt does not make the prediction harder to guess. It makes _confirming_ a
guess impossible: with 2^256 unknown bits in the preimage, an attacker who
guesses the exact prediction still cannot produce the matching hash.

The cost of that guarantee is that the salt becomes a secret worth as much as the
stake. Lose it and the commitment can never be opened, and the stake is
forfeited. The UI stores it locally, offers it as a download, and says this in
plain language rather than in a tooltip.

### C. A stale or manipulated oracle

A price feed that has stopped updating does not report an error. It answers
`latestRoundData()` with its last known round, indefinitely. Consuming that value
settles predictions against a price that may be hours dead — and an attacker who
can predict a feed outage can commit calls that settle against a price they
already know.

**Answer.** The oracle adapter treats every read as untrusted. It reverts if the
price is non-positive, if the round was never answered, or if `updatedAt` is
older than a staleness threshold **configured per feed** — because heartbeats
differ between feeds, and one global threshold is either too strict for the slow
feed or too loose for the fast one.

When the feed is unhealthy the reveal reverts and the call stays open, so the
analyst retries once the feed recovers. Failing closed costs a retry. Failing
open would settle real money against a fabricated price.

### D. Settling at a moment of your choosing

This one is not in the usual commit-reveal writeups, and it is the mistake this
project nearly shipped.

The reveal window is 48 hours wide. If the contract read the _latest_ price when
the reveal transaction was mined, the analyst would not be settling against the
price at their deadline — they would be settling against the price at whatever
moment they chose to press the button, anywhere inside two days.

So: commit "ETH above $3,000" for Friday noon. Friday noon arrives and ETH is at
$2,900; the call is wrong. Do nothing. Sunday at 3am ETH ticks to $3,010 —
reveal, and the contract records a win. Every losing call becomes a free
two-day option on being right later, and the flawless track record is back.

**Answer.** Settlement reads the last Chainlink round at or before the deadline.
The round id is supplied by the caller, because Chainlink has no
timestamp-to-round index, and the resolver **verifies** it instead of trusting
it: the round must exist, predate the deadline, sit inside that feed's staleness
window relative to the deadline, and have no successor that also predates it.
That last check is what leaves nothing to cherry-pick — for a given deadline
exactly one round is accepted.

Written up in [ADR-010](./docs/decisions/ADR-010-settlement-reads-the-round-covering-the-deadline.md),
and there is a test that runs the attack: a call that is wrong at its deadline,
a price that crosses a day later, and a reveal that still records a loss.

## Known limitations

Stated here rather than discovered later.

1. **Settlement is at the deadline, not on touch.** The outcome is decided by the
   price _at the moment of the deadline_. A call whose target was hit an hour
   earlier and retraced settles as a loss. Resolving "did it ever touch" would
   mean scanning historical feed rounds on-chain, which is expensive and fragile.
   Deliberate.
2. **Only assets with a Chainlink feed.** BTC/USD and ETH/USD on Sepolia. Adding
   an asset is one admin transaction, but there is no path to anything without a
   feed.
3. **Slashed stakes go to a configurable treasury.** Redistributing them among
   the analysts who were right in the same window is a better design, and it
   requires pool accounting that adds no insight for the effort.
4. **The commitment hides the call until the deadline. That is all it does.**
   After the reveal everything is public and permanent. This is not a privacy
   system.
5. **A trivially safe target still scores as a win.** "ETH above $1" resolves
   correct every time. The chain records raw win/loss counts and has no notion of
   how bold a call was — `commitCall` cannot know the spot price, because it does
   not know the asset yet; that is the point of the commitment. The leaderboard
   therefore weights calls by their distance from the spot price at commit time,
   computed **off-chain**. Treat the on-chain record as trustworthy and the
   ranking as a claim by this frontend. Verifying the boldness of a call on-chain
   is the main planned extension, and the trade-off is written up in
   [ADR-004](./docs/decisions/ADR-004-trivial-target-measured-off-chain.md).
6. **Admin keys are a real trust assumption.** The account holding
   `DEFAULT_ADMIN_ROLE` can swap the price resolver, retarget the treasury and
   change protocol parameters. No timelock in the MVP. Named, not hidden.
7. **A dead feed can cost an analyst their stake.** If no Chainlink round exists
   within the staleness window of a call's deadline, settlement fails closed and
   the call cannot be revealed. Once the window shuts it forfeits, and an oracle
   outage is written into a human's public record as evasion. `maxHorizon` of 30
   days bounds the exposure and the resolver is swappable, but the fix — a
   `Voided` state that returns the stake and counts as neither win nor forfeit —
   needs a governance answer the MVP does not have. Reasoning in
   [`docs/threat-model.md`](./docs/threat-model.md).
8. **A winner whose address rejects ETH cannot be paid.** Their reveal reverts
   and the call eventually forfeits to the treasury. A pull-payment escrow would
   fix it and would add a second balance to reason about; for an MVP whose users
   are EOAs, the trade is not worth it.
9. **Revealing requires off-chain work.** The frontend has to locate the
   settlement round by binary search over the feed's history before it can build
   the reveal transaction. Standard for anything that settles at an expiry, but
   it means the contract is not usable from a block explorer alone.

## The frontend

Four screens under [`frontend/`](./frontend), React + Vite + wagmi 2 +
RainbowKit 2. Three of them do work the contracts cannot do for themselves.

- **Commit.** Asset picker limited to assets that actually have a feed on the
  connected deployment — `commitCall` takes a hash and cannot check, so this list
  is the only thing standing between a user and a call that can never be
  revealed. The salt comes from `crypto.getRandomValues`, and the commitment is
  computed by calling the contract's own `pure` `computeCommitment` rather than
  re-implementing `abi.encode` in TypeScript, where a divergence would surface as
  a lost stake and no error message.
- **Vault.** Salt custody, given a page of its own rather than a tooltip. The
  salt is written to browser storage _before_ the transaction is signed, the
  commit success screen leads with a download button, and import merges rather
  than replaces so restoring a backup does not delete live calls. Losing a salt
  is unrecoverable and the UI says so in those words
  ([ADR-013](./docs/decisions/ADR-013-salt-custody-is-browser-local.md)).
- **Calls.** Reveal and forfeit. Revealing needs the settlement round id, which
  means a binary search over the feed's history before the transaction can even
  be built; the search is an explicit step because it makes a dozen RPC calls and
  can legitimately fail. `LaterRoundAvailable`, `RoundAfterTimestamp` and the rest
  are translated into messages that say whether retrying will help. Forfeit is
  offered on every overdue call, by anyone — that is what makes attack A cost
  something.
- **Leaderboard.** Counts from chain state; ranking weighted by how far each
  target was from the spot price at commit time, computed off-chain, with the
  formula printed under the table and labelled as a claim by this frontend
  ([ADR-014](./docs/decisions/ADR-014-leaderboard-weights-calls-off-chain.md)).

```bash
npm run frontend:install
cp frontend/.env.example frontend/.env.local   # fill in the deployed addresses
npm run frontend:dev
```

The ABIs the frontend imports are generated from the compiled artifacts by
`npm run export-abi` and committed, so the frontend builds on a machine that has
never compiled the contracts. CI recompiles and re-runs the generator with
`--check`, which turns ABI drift into a red build rather than an unnamed revert
([ADR-012](./docs/decisions/ADR-012-generated-abi-committed-to-the-frontend.md)).

## Architecture

| Contract                  | Responsibility                                                              |
| ------------------------- | --------------------------------------------------------------------------- |
| `CallRegistry.sol`        | Commit-reveal lifecycle, stakes, settlement, analyst stats                  |
| `PriceOracleResolver.sol` | Chainlink adapter: feed registry, per-feed staleness, decimal normalization |
| `IPriceResolver.sol`      | The seam between them — the registry never learns what an oracle is         |
| `MockV3Aggregator.sol`    | Test-only feed that lets tests drive an exact price at an exact timestamp   |
| `EthRejecter.sol`         | Test-only analyst that cannot receive ETH                                   |
| `ReentrantTreasury.sol`   | Test-only treasury that calls back into the registry while being paid       |

Detail in [`docs/architecture.md`](./docs/architecture.md). The eight properties
the protocol claims, each mapped to the test that pins it, are in
[`docs/invariants.md`](./docs/invariants.md); the attacks and the residual risks
are in [`docs/threat-model.md`](./docs/threat-model.md). Every non-obvious choice
is recorded in [`docs/decisions.md`](./docs/decisions.md), and
[`docs/worklog.md`](./docs/worklog.md) tracks what is built so far and what comes
next.

## Stack

Solidity 0.8.28 · OpenZeppelin 5.6 · Chainlink Data Feeds · Hardhat 3 ·
viem 2 · Hardhat Ignition · React + Vite + wagmi 2 + RainbowKit 2

## Local development

```bash
npm install
npm run build          # compile contracts
npm test               # both runners: node:test + viem, and Solidity fuzz
npm run test:nodejs    # TypeScript scenarios only
npm run test:solidity  # Solidity fuzz properties only
npm run coverage       # built-in coverage (Hardhat 3; not solidity-coverage)
npm run lint           # solhint
npm run format:check   # prettier

npm run export-abi     # regenerate frontend/src/contracts/abis.ts
npm run frontend:build # type-check and build the client

npm run demo           # node + deployment + price keeper + frontend, one command
npm run demo:deploy    # just the deployment and keeper, against a node you started
```

CI runs all of the above on every push and pull request.

Secrets never live in `.env`. Deployment credentials go in Hardhat 3's encrypted
keystore and are read through `configVariable()`:

```bash
npx hardhat keystore set SEPOLIA_RPC_URL
npx hardhat keystore set SEPOLIA_PRIVATE_KEY
npx hardhat keystore set ETHERSCAN_API_KEY
```

Use a dedicated, disposable deploy wallet funded from a faucet. Never one that
has touched mainnet.

Then deploy and verify in one command:

```bash
npm run deploy:sepolia
```

The Ignition module deploys the resolver, registers BTC/USD and ETH/USD against
the Chainlink proxies, and deploys the registry pointed at it — in that order,
so there is never a window where the protocol is live and settlement would
revert on a missing feed. Everything network-specific is a parameter with a
Sepolia default. The module is exercised by a test on the simulated network
before it is ever pointed at a real one.

## License

MIT
