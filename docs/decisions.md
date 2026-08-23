# Architecture Decision Records

One file per decision under [`decisions/`](./decisions). Format, and why it is
this format, is itself the first record: [[ADR-000-adr-format-and-vault-layout]].

Records are immutable once `accepted`. A reversal is a new ADR carrying
`supersedes: [ADR-NNN]` in its front matter — never an edit to the original.

| ID                                                                                 | Decision                                                          | Phase | Status   |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----- | -------- |
| [ADR-000](./decisions/ADR-000-adr-format-and-vault-layout.md)                      | One file per ADR, wikilinked, vault-compatible                    | F0    | accepted |
| [ADR-001](./decisions/ADR-001-pin-wagmi-v2.md)                                     | Pin wagmi to 2.19.5 despite 3.x being current                     | F0    | accepted |
| [ADR-002](./decisions/ADR-002-per-feed-staleness-threshold.md)                     | Staleness threshold per feed, not global                          | F0    | accepted |
| [ADR-003](./decisions/ADR-003-pause-blocks-commit-only.md)                         | Pausing blocks commits only; reveal and forfeit never pause       | F0    | accepted |
| [ADR-004](./decisions/ADR-004-trivial-target-measured-off-chain.md)                | Trivial-target defence measured off-chain, stated as a limitation | F0    | accepted |
| [ADR-005](./decisions/ADR-005-viem-assertions-over-chai.md)                        | `hardhat-viem-assertions` instead of Chai                         | F0    | accepted |
| [ADR-006](./decisions/ADR-006-drop-committedat-from-struct.md)                     | `committedAt` lives in events, not storage                        | F0    | accepted |
| [ADR-007](./decisions/ADR-007-above-below-not-long-short.md)                       | Direction is `Above`/`Below`, not `Long`/`Short`                  | F0    | accepted |
| [ADR-008](./decisions/ADR-008-oracle-adapter-layer.md)                             | Chainlink isolated behind `IPriceResolver`                        | F0    | accepted |
| [ADR-009](./decisions/ADR-009-initial-protocol-parameters.md)                      | Initial protocol parameters                                       | F0    | accepted |
| [ADR-010](./decisions/ADR-010-settlement-reads-the-round-covering-the-deadline.md) | Settlement reads the round covering the deadline                  | F3    | accepted |
| [ADR-011](./decisions/ADR-011-transient-reentrancy-guard-over-plain-cei.md)        | Transient reentrancy guard on top of strict CEI                   | F3    | accepted |
