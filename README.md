# Proof of Call

An on-chain registry for market predictions, where the track record includes the
losses because the protocol will not let you delete them.

> **Status:** in development. Phase F0 (scaffold) complete.
> Deployment links, coverage and CI badges land in F4 and F6.

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

## The three attacks the design exists to answer

The mechanism above is easy. What makes it hold up is what happens when someone
tries to game it. These are the attacks that shaped the contracts.

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

## Architecture

| Contract                  | Responsibility                                                            |
| ------------------------- | ------------------------------------------------------------------------- |
| `CallRegistry.sol`        | Commit-reveal lifecycle, stakes, settlement, analyst stats                |
| `PriceOracleResolver.sol` | Chainlink adapter: feed registry, staleness, decimal normalization        |
| `IPriceResolver.sol`      | The seam between them — the registry never learns what an oracle is       |
| `MockV3Aggregator.sol`    | Test-only feed that lets tests drive an exact price at an exact timestamp |

Detail in [`docs/architecture.md`](./docs/architecture.md). Every non-obvious
choice is recorded in [`docs/decisions.md`](./docs/decisions.md), and
[`docs/worklog.md`](./docs/worklog.md) tracks what is built so far and what
comes next.

## Stack

Solidity 0.8.28 · OpenZeppelin 5.6 · Chainlink Data Feeds · Hardhat 3 ·
viem 2 · Hardhat Ignition · React + Vite + wagmi 2 + RainbowKit 2

## Local development

```bash
npm install
npm run build      # compile contracts
npm test           # node:test + viem
npm run coverage   # built-in coverage (Hardhat 3; not solidity-coverage)
npm run lint       # solhint
```

Secrets never live in `.env`. Deployment credentials go in Hardhat 3's encrypted
keystore and are read through `configVariable()`:

```bash
npx hardhat keystore set SEPOLIA_RPC_URL
npx hardhat keystore set SEPOLIA_PRIVATE_KEY
npx hardhat keystore set ETHERSCAN_API_KEY
```

Use a dedicated, disposable deploy wallet funded from a faucet. Never one that
has touched mainnet.

## License

MIT
