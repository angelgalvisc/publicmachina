# Operator Audit — March 16, 2026

> **Note**: This is a historical snapshot from March 16, 2026. The repository has since evolved (474 tests / 39 files as of March 17). For current architecture, see [architecture.md](architecture.md) and the README.

This document records the operator hardening audit for PublicMachina's conversational assistant. The goal was not only to confirm that the code compiles and the tests pass, but to verify that the operator can guide a user from an ambiguous request to a runnable simulation with clear, trustworthy behavior.

## Audit Goals

The audit focused on four practical questions:

1. Does the operator choose the right action at the right time?
2. Do user constraints survive the full path from brief to pipeline?
3. Does the workflow state protect the user from invalid transitions?
4. Does the user experience feel reliable, efficient, and low-friction?

## Success Thresholds

The audit used the following thresholds:

- Structured-brief routing chooses the correct tool in at least 90% of baseline scenarios.
- No invalid run transition occurs in the audited confirmation and stop flows.
- User-specified `rounds`, `actorCount`, and source-document handling reach execution in 100% of covered scenarios.
- Preview output does not contradict runnable state.
- Build stays clean and the full test suite remains green.

## Baseline Scenario Matrix

The baseline used representative operator scenarios rather than synthetic prompt fragments.

| Scenario | Expected behavior | Result after hardening |
| --- | --- | --- |
| Structured Spanish brief with labeled sections | Route directly to `design_simulation` without planner guesswork | Pass |
| Structured English brief with labeled sections | Route directly to `design_simulation` without planner guesswork | Pass |
| Brief includes a URL but no local docs path | Preserve the URL and materialize runnable source docs from the brief | Pass |
| User asks for a specific actor count | Persist the constraint and limit generated actors | Pass |
| User asks for a specific round count | Persist the constraint and render the correct config | Pass |
| User enables web search for named roles | Preserve the search budget and targeting policy | Pass |
| Search roles are written in Spanish | Match equivalent generated English professions through aliases | Pass |
| Search roles are written in English | Match canonical generated professions | Pass |
| An old design is active and the user pastes a new structured brief | Replace the design instead of recycling the old scenario | Pass |
| User confirms a pending run | Require explicit confirmation before execution | Pass |
| User runs a design without an explicit docs path | Run succeeds with auto-materialized source docs | Pass |
| User returns with a remembered name and context | Skip redundant onboarding prompts | Pass |
| User tries to exceed the session budget | Block the run with a clear explanation | Pass |
| Another process holds the run lock | Reject the new run cleanly | Pass |
| Completed run unlocks post-run tools | Query/report/export tools become available only when valid | Pass |

## Findings

### High-priority findings addressed

1. The planner was coupled to the `simulation` provider role instead of a dedicated assistant role.
2. `actorCount` was not a first-class constraint and did not reach profile generation.
3. Search-role targeting depended on fragile string equality.
4. The operator exposed every tool in every state, which gave the planner avoidable ambiguity.
5. The operator preview could still warn that documents were missing even after source docs had been auto-generated.
6. The onboarding flow always asked for name and context even when that information already existed in the workspace profile.

### Positive architectural traits already present

The audit also confirmed that several important robustness patterns were already in place and worth preserving:

- The planner already had a JSON repair pass for malformed model output.
- The operator already persisted conversation state, simulation history, and workspace memory separately.
- The pipeline stages (`ingest -> analyze -> generate -> simulate`) were already cleanly separated.
- Run locking, graceful stop handling, and budget enforcement were already implemented in code rather than delegated to the model.

## Implemented Changes

### Phase 1 — Agent and Tooling

- Added a dedicated `assistant` provider role and resolved planner calls through that role.
- Extended `/model` handling to support the `assistant` role explicitly.
- Introduced dynamic tool exposure through `getAvailableAssistantTools(taskState)` so the planner only sees tools that are valid for the current workflow state.
- Rewrote tool descriptions in clear operational English with explicit usage intent and side-effect expectations.
- Expanded structured-brief detection to support both Spanish and English labels.

### Phase 2 — Contracts and Pipeline Integrity

- Added `actorCount` and `sourceUrls` to the simulation design contract.
- Parsed `actorCount`, source URLs, English round labels, and English search-budget phrasing from structured briefs.
- Passed `actorCount` through the pipeline into `generateProfiles()` so the constraint is now executable, not aspirational.
- Included `actorCount` and source URLs in simulation previews.
- Recomputed the preview after auto-materializing docs so the operator no longer claims the design is missing documents after fixing the issue internally.

### Phase 3 — UX and Workflow Quick Wins

- Reused remembered `preferredName` and `lastContext` during operator startup.
- Improved document-source warnings to reflect actual runtime behavior.
- Added profession alias normalization for cross-language search targeting, including:
  - `markets journalist` <-> `periodistas de mercados`
  - `technology journalist` <-> `periodistas de tecnología`
  - `macro trader` <-> `traders macro`
  - `crypto trader` <-> `traders cripto`

## Validation

Validation was rerun after the hardening pass.

- `npm run build` -> passed
- `npm test` -> passed

Final verification state:

- Test files: `37`
- Passing tests: `452`

New coverage added during this audit includes:

- Dedicated assistant-role provider override behavior
- Structured English brief routing
- Actor-count propagation into the full pipeline
- Search-role alias normalization
- Preview consistency after source-doc auto-materialization
- Dynamic tool availability by workflow state
- Returning-user onboarding reuse

## Remaining Backlog

The following items remain valuable, but they are no longer blockers for a high-quality operator experience:

1. Introduce a first-class `inputSources` contract instead of treating `docsPath` as the dominant source model.
2. Add a broader operator eval harness with curated real-world briefs in both English and Spanish.
3. Consider native tool-calling for supported providers once the current typed-tool contracts are stable enough to justify the migration.
4. Decide whether repeated analysis-output patterns justify a dedicated report contract or remain report-template concerns.

## Verdict

The operator is materially better after this pass. It is now more deterministic, more honest about state, more respectful of user constraints, and more efficient in normal use. The assistant remains agentic, but it now operates over a safer and clearer workflow kernel instead of relying on free-form model behavior for critical transitions.
