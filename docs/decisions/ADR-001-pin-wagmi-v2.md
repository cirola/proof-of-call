---
id: ADR-001
title: Pin wagmi to 2.19.5 even though 3.x is the current release
status: accepted
date: 2026-08-19
phase: F0
tags: [adr, frontend, dependencies, wagmi, rainbowkit]
---

# ADR-001 — Pin wagmi to 2.19.5 even though 3.x is current

## Context

`wagmi@3.7.6` is the current release. The wallet-connection UI libraries have not
followed. Verified against the registry:

- `@rainbow-me/rainbowkit@2.2.11` declares `peerDependencies: { wagmi: "^2.9.0" }`
- `connectkit@1.9.2` declares `wagmi: "2.x"`

RainbowKit publishes no 3.x-compatible line at all (`dist-tags` are
`latest: 2.2.11`, `legacy-v1`, `legacy-v0`). So "wagmi v2 + RainbowKit v2", as
specified in the project brief, is still correct — but only if the version is
pinned, because `npm install wagmi` now resolves to 3.x and breaks the peer
range.

## Options

**A. Pin `wagmi@2.19.5` (last 2.x) + `@rainbow-me/rainbowkit@2.2.11`.** Fully
supported combination. Frozen on a maintenance line.

**B. Install `wagmi@3` and force the tree with `--legacy-peer-deps`.** Ships a
build whose dependency graph the package manager has been told to stop checking.
RainbowKit calls wagmi internals; a v3 breaking change surfaces as a runtime
error in a wallet flow, not at install time.

**C. Drop RainbowKit, use wagmi v3 connectors directly.** Modern stack, but the
wallet-selection modal, chain switcher, and account UI become hand-written work
that is not what this project is demonstrating.

## Decision

Option A. Exact pins in `frontend/package.json`, no caret:
`wagmi@2.19.5`, `@rainbow-me/rainbowkit@2.2.11`, `viem@2.x`,
`@tanstack/react-query@^5`.

## Consequences

- The frontend stack is on a maintenance line and will need a coordinated
  migration once RainbowKit ships wagmi v3 support.
- `viem` stays on `2.x` on both sides of the repo, so contract-derived types are
  shared between tests and frontend without a version skew — which was the point
  of choosing viem in the first place.
- Renovate/Dependabot must not auto-bump `wagmi`. If dependency automation is
  added, wagmi is pinned in its ignore list.

## Links

[[ADR-005-viem-assertions-over-chai]]
