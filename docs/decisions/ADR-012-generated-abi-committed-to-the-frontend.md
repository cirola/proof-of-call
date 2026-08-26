---
id: ADR-012
title: The frontend imports a generated ABI file that is committed to the repository
status: accepted
date: 2026-08-26
phase: F5
tags: [adr, frontend, build, tooling]
supersedes: []
---

# ADR-012 — Generated ABI, committed

## Context

The frontend has to encode calls to `CallRegistry` and `PriceOracleResolver`.
There are three ways to give it their ABIs, and they fail differently.

1. **Hand-write the ABI in TypeScript.** It drifts the moment a parameter is
   added or reordered, and nothing catches the drift: the app encodes a call the
   contract does not implement, and the user sees an unnamed revert after paying
   for gas.
2. **Import `artifacts/` directly.** Accurate by construction, but `artifacts/`
   is gitignored, so the frontend only builds on a machine that has compiled the
   contracts first. A Vercel build or a fresh clone fails at `vite build` with a
   missing module.
3. **Generate a TypeScript module and commit it.** Accurate by construction and
   standalone, at the cost of a file in the tree that is not hand-edited.

There is a fourth requirement that rules out the "just be careful" version of
option 1: wagmi's type inference works off a `const`-asserted ABI. Without `as
const` every entry widens to `string`, argument types collapse to `unknown`, and
the compile-time check that a call passes the right arguments quietly disappears.

## Decision

`scripts/export-abi.js` reads the compiled artifacts and writes
`frontend/src/contracts/abis.ts` with `as const`. The file is committed. CI runs
the same script with `--check` after compiling, and fails if the committed copy
differs from what the contracts produce.

The Chainlink aggregator ABI is the one exception: it is hand-written in
`frontend/src/contracts/aggregator.ts`, holds three signatures, and belongs to a
dependency this project does not otherwise build. Nothing is trusted from it —
the round id it helps locate is verified on-chain by `getPriceAt` — so a wrong
entry produces a revert, not a wrong settlement.

## Consequences

- **Drift becomes a red build rather than a lost stake.** The check step is the
  whole value of the decision; without it this is just a stale file.
- **The generated file is in `.prettierignore`.** Formatting it would make
  `npm run export-abi` produce a diff on every run, which would make the CI check
  fail for cosmetic reasons.
- **A contract change is a two-command follow-up**: rebuild, then
  `npm run export-abi`, then commit. That is a real papercut and it is the price
  of the frontend being independently buildable.
- **The frontend stays a separate npm package** with its own lockfile, rather
  than a workspace. One less build-system concept for a repository whose primary
  toolchain is Hardhat, and CI installs the two independently anyway.

## Links

[[ADR-001-pin-wagmi-v2]] · [[ADR-013-salt-custody-is-browser-local]]
