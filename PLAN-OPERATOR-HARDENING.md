# PublicMachina — Operator Hardening Plan

> **Status as of 2026-03-17**: Phases 1, 4, 5 largely completed through commits `0de80f0` through `a4ef139`. Tests now at **474 passing, 39 test files**. Phases 2-3 remain open. See issue-by-issue status below.

## Current State (audit of what you just shipped)

**426 tests, 33 test files, all green. TypeScript compiles clean.**

You implemented the full conversational orchestrator with tool-calling in one push:

```
User input
    ↓
assistant-operator.ts  (conversational REPL, slash commands via regex)
    ↓
assistant-planner.ts   (LLM decides: respond | tool_call)
    ↓
assistant-tools.ts     (8 typed tools → dispatch to services)
    ↓
simulation-service.ts  (thin pipeline: ingest → analyze → generate → simulate)
    ↓
engine.ts              (simulation logic, now with EngineRoundProgress callbacks)
```

Seven new files (+2778 lines), three new test files, index.ts and shell.ts significantly slimmed.
The architecture is exactly right. What follows are the issues I found and the hardening needed.

---

## Issues Found in Audit

### P0 — Bugs

1. **`startedAt` overwritten on completion** (`assistant-tools.ts:387-388`)
   - `setCompletedRunState` sets `startedAt: new Date().toISOString()` AFTER the run finishes.
   - Should preserve the original `startedAt` from `setActiveRunState` (line 310).
   - Fix: capture `const startedAt = new Date().toISOString()` before `executePipeline()` and thread it through.

2. **Non-null assertion on nullable workspace** (`assistant-tools.ts:234`)
   - `runtime.workspace!` — will throw if workspace is null.
   - `designSimulationTool` should guard: if `!runtime.workspace` return error.

### P1 — Security / Safety

3. **No path validation on tool outputs**
   - `exportAgentTool` writes to `dirname(target.dbPath)/ckp-export-*` — could be anywhere.
   - `generateReportTool` writes to `dirname(target.dbPath)/report.md`.
   - Need: `assertInsideWorkspace(outputPath, workspaceDir)` check in each writing tool.

4. **`rmSync` in production code** (`simulation-service.ts:205`)
   - Deletes temp directory after copying artifacts to workspace. Acceptable but should be audited.
   - The temp dir is created by `mkdtempSync` and only contains files this process wrote.
   - No action needed, but worth a comment explaining why it's safe.

5. **No session token/cost budget**
   - The planner loop allows up to 4 tool calls per user input, but no global budget.
   - A user saying "run" 20 times could trigger 20 full simulations.
   - Need: per-session cost accumulator with configurable cap.

### P2 — UX / Robustness

6. **Operator re-asks name and context every session** (`assistant-operator.ts:123-149`)
   - Even if `preferredName` is already in the user profile from a previous session.
   - Should load profile first: `const profile = loadUserProfile(workspace); preferredName = profile.preferredName ?? "there";`
   - Only ask context if no `lastContext` exists.

7. **In-memory conversation array grows unbounded** (`assistant-operator.ts:63`)
   - The `conversation` array never gets trimmed. For very long sessions, memory grows.
   - The planner already caps at last 10 messages (line 121 of planner). Safe for LLM context.
   - But the array itself should be trimmed to e.g. 50 entries for memory hygiene.

8. **No tool call result shown after multi-step chain** (`assistant-operator.ts:246-249`)
   - If the planner chains 4 tool calls and the last one succeeds, the result is shown.
   - But intermediate successes (steps 0-2) are only in `toolTrace`, never shown to the user.
   - The user sees progress from `onProgress` callback, but not the tool completion summaries.

### P3 — Code Quality / Missing Tests

9. **Zero test coverage for `executeAssistantTool()`**
   - Only `assistant-planner.test.ts` (2 tests) and `assistant-state.test.ts` (2 tests) exist.
   - No tests for: `designSimulationTool`, `runSimulationTool`, `querySimulationTool`, `interviewActorTool`, etc.
   - Need at minimum: mock-mode tests for design → run → query → report flow.

10. **`simulation-service.ts` pipeline not directly tested**
    - Tested indirectly through `index.test.ts` CLI tests.
    - Need: dedicated `simulation-service.test.ts` testing `executePipeline()` with mock backend.

11. **No test for operator loop** (`assistant-operator.ts`)
    - The full conversational loop (greeting → context → design → confirm → run) has no test.
    - Need: integration test with mock prompt session + mock LLM.

12. **README not updated**
    - Module Map missing 7 new files.
    - Test count should be 426 (not 419 or 420).
    - Line counts outdated for shell.ts (now 274), index.ts (reduced).

### P4 — Minor

13. **`sanitizeForStorage` now redacts `workspaceDir`** — confirmed working, test added. Good.

14. **`AssistantSessionMode` type expanded** — `"design" | "shell"`. Clean.

15. **`model-command.ts` switchModel doesn't search across providers** — Unlike the old shell.ts version which iterated `SUPPORTED_PROVIDERS` to find a model. Now it only checks the current provider. This is a behavior regression for cross-provider `/model use kimi-k2` style commands.

---

## The Plan — What To Do

### Phase 1: Fix P0 Bugs (30 min) — COMPLETED

1. **Fix `startedAt` in `runSimulationTool`** — Fixed in commit `6f59d17`.

2. **Guard null workspace in `designSimulationTool`** — Fixed in commit `f927de2`.

### Phase 2: Safety Guardrails (1 hour)

3. **Path validation for output tools**
   - New function: `assertOutputPath(target, workspaceDir)` in `assistant-tools.ts`.
   - Apply to: `exportAgentTool`, `generateReportTool`.
   - Falls back to workspace-relative path if validation fails.

4. **Session cost budget**
   - Add `tokenBudget` and `costBudget` to `AssistantToolRuntime`.
   - Track cumulative tokens/cost from `LLMResponse.meta`.
   - Return error from tools when budget exceeded.
   - Configurable via `assistant.memory.sessionTokenBudget` in config.

### Phase 3: UX Improvements (1 hour)

5. **Load existing profile on startup**
   - Read `profile.json` in `startAssistantOperator`.
   - Skip name/context questions if already captured.
   - Only ask: "What would you like to work on today?"

6. **Trim conversation array**
   - Cap at 50 entries, discard oldest.

7. **Restore cross-provider model search in `model-command.ts`**
   - Re-add the `SUPPORTED_PROVIDERS` iteration loop from old `shell.ts` `switchModel`.

### Phase 4: Test Coverage (2 hours) — PARTIALLY COMPLETED

Tests grew from 426 → 474 across commits `0de80f0` through `a4ef139`. New test files: `concurrency.test.ts`, `cast-design.test.ts`. Existing files expanded: `assistant-tools.test.ts`, `assistant-operator.test.ts`, `simulation-service.test.ts`, `profiles.test.ts`.

8. **`assistant-tools.test.ts`** — Mock-mode flow test:
   - `design_simulation` with mock LLM → verify artifacts created.
   - `run_simulation` with `confirmed: false` → verify `needs_confirmation`.
   - `run_simulation` with `confirmed: true` + mock → verify pipeline completes.
   - `query_simulation` with raw SQL → verify results.
   - `list_history` → verify workspace search.
   - `switch_provider` → verify config updated.

9. **`simulation-service.test.ts`** — Pipeline test:
   - `executePipeline()` with mock backend → verify all phases called.
   - `estimatePipelineRun()` → verify calculation.
   - `designSimulationArtifacts()` → verify files written to workspace.

10. **`assistant-operator.test.ts`** — Integration test:
    - Mock prompt session that feeds answers sequentially.
    - Mock LLM that returns tool_call decisions.
    - Verify: greeting → context → design → confirmation → run → completion.

### Phase 5: README Update (30 min) — COMPLETED

Architecture diagram, module map, CLI table, and capabilities updated in commits `a7841fb` and `a4ef139`.

11. Update Module Map with 7 new files:
    - `assistant-tools.ts` (~705 lines) — Typed tools for the operator planner
    - `assistant-operator.ts` (~379 lines) — Conversational operator REPL
    - `assistant-planner.ts` (~128 lines) — LLM planning: respond vs tool_call
    - `assistant-state.ts` (~237 lines) — Persistent task state machine
    - `simulation-service.ts` (~408 lines) — Thin pipeline orchestrator
    - `model-command.ts` (~217 lines) — Shared /model command handler
    - `query-service.ts` (~101 lines) — Read-only query helpers

12. Update test count: 426 tests, 33 test files.

13. Update line counts for shell.ts (~274 lines), index.ts (reduced).

14. Add operator documentation section describing the tool-calling flow.

---

## Architecture Verdict

The implementation is architecturally sound. The separation is clean:

- **Operator layer** (assistant-operator, planner, tools, state) owns the conversational flow
- **Service layer** (simulation-service, query-service, model-command) owns the business logic
- **Engine layer** (engine, cognition, feed, propagation, etc.) owns the simulation
- **Store layer** (db, schema) owns persistence

The tool-calling pattern works correctly:
- Slash commands → regex, no LLM cost
- Everything else → LLM planner → typed tools → services
- Confirmation gate inside `run_simulation` tool
- Multi-step chaining (up to 4 tools per input)
- State persists to filesystem (survives Ctrl+C)

The 5 phases above take this from "working prototype" to "production-hardened".
