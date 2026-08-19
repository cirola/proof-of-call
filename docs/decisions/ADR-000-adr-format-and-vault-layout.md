---
id: ADR-000
title: Record decisions as one file per ADR, wikilinked, Obsidian-compatible
status: accepted
date: 2026-08-19
phase: F0
tags: [adr, process, documentation]
---

# ADR-000 — Record decisions as one file per ADR, wikilinked

## Context

Architecture decisions written at the end of a project are reconstructed fiction:
you remember the choice, not the alternative you rejected or why. The rejected
option is the interesting half. The project also needs to be readable later from
a local knowledge vault (Obsidian), not only from GitHub.

## Options

**A. Single `docs/decisions.md` with all ADRs appended.** One file to open, no
index to maintain. Grows to thousands of lines, no per-decision metadata, and a
knowledge vault sees it as one undifferentiated note.

**B. One file per ADR under `docs/decisions/`, plus an index.** Each decision is
addressable, taggable, and linkable. Costs an index file that must be kept in
sync.

## Decision

Option B. Each ADR is `docs/decisions/ADR-NNN-slug.md` with YAML front matter
(`id`, `status`, `date`, `phase`, `tags`) and cross-references written as
`[[ADR-NNN-slug]]` wikilinks. `docs/decisions.md` is a hand-maintained index.

Front matter and wikilinks are chosen specifically so that pointing an Obsidian
vault at `docs/` yields a working graph, tag search, and backlinks with zero
migration. The cost of adopting this format on day one is zero; adopting it in
F6 would mean rewriting every document.

## Consequences

- Wikilinks do not render as links on GitHub — they show as literal `[[text]]`.
  Accepted inside `docs/`. The README uses ordinary relative links, because the
  README is the public face of the repository.
- Every phase must close by writing its ADRs before the phase commit, or the
  index drifts.
- ADRs are immutable once `accepted`. A reversal is a new ADR with
  `supersedes: [ADR-NNN]`, never an edit.

## Links

Index: `docs/decisions.md`
