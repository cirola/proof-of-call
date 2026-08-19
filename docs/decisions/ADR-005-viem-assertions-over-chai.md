---
id: ADR-005
title: Use hardhat-viem-assertions instead of Chai for contract assertions
status: accepted
date: 2026-08-19
phase: F0
tags: [adr, testing, tooling]
supersedes: []
---

# ADR-005 — Use hardhat-viem-assertions instead of Chai

## Context

The brief specified `node:test` + viem + Chai. Installing
`@nomicfoundation/hardhat-toolbox-viem@5.0.7` showed it already bundles
`@nomicfoundation/hardhat-viem-assertions`, which provides first-class matchers
for the things this contract actually does.

The contract uses **custom errors exclusively** — no `require` strings. Asserting
on a custom error is the single most common assertion in the whole test suite.

## Options

**A. Chai + `chai-as-promised`.** Assert rejection, then match the revert data by
inspecting the error message string. Custom errors arrive as ABI-encoded
selectors, so the assertion degrades into substring matching on a formatted
message. It passes for the wrong reasons: a test asserting `InvalidDeadline` also
passes if the call reverts with an unrelated error whose formatting happens to
contain that text, and it breaks whenever a library changes its error text.

**B. `hardhat-viem-assertions`.** Provides `revertWithCustomError(contract, name)`
and argument-level variants, decoding revert data against the ABI. A test that
expects `InvalidDeadline` fails if the contract reverts with anything else.

## Decision

Option B, with `node:assert/strict` for plain value assertions. Chai is not
installed at all.

This overrides the brief, which named Chai before the toolbox contents were
checked. Testing a custom-errors codebase through string matching would make the
suite's revert coverage decorative.

## Consequences

- One fewer direct dependency; assertion matchers stay version-locked to the
  toolbox and to viem.
- Assertions are ABI-aware, so renaming a custom error breaks the tests that
  reference it — which is the desired behaviour.
- Solidity fuzz tests (F3) use a separate mechanism and are unaffected.

## Links

[[ADR-001-pin-wagmi-v2]]
