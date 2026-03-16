# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Please report security vulnerabilities by emailing **security@datastrat.co** with:

1. A description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Suggested fix (if any)

You will receive a response within 72 hours. We will work with you to understand and address the issue before any public disclosure.

## Security Design Principles

PublicMachina follows these security principles by design:

### Secrets Never in Persistent Data
- API keys are referenced by environment variable name, never stored as values
- `config.ts sanitizeForStorage()` redacts all secrets before writing to `run_manifest.config_snapshot`
- `telemetry.ts sanitizeDetail()` strips secrets from telemetry action detail
- `ckp.ts scrubSecrets()` removes secrets from export bundles

### Operator Guardrails
- **Session cost budget** — `sessionCostBudgetUsd` caps cumulative LLM spend per operator session (`assistant-tools.ts`)
- **Path validation** — `assertPathInsideWorkspace()` prevents exports and reports from escaping the workspace boundary (`assistant-workspace.ts`)
- **Run locks** — `acquireActiveRunLock()` ensures only one simulation runs at a time, with stale-lock recovery via PID liveness check (`run-control.ts`)
- **Graceful cancellation** — SIGINT triggers cooperative stop through `createGracefulStopController()`; the engine checkpoints after the current round before exiting (`run-control.ts`, `engine.ts`)

### Input Validation
- Config validation rejects invalid ranges before any processing
- Document ingestion uses content hashes (SHA-256) for dedup
- Entity resolution is auditable via `entity_merges` table

### Isolation
- Each simulation run is scoped by `run_id` — queries never mix runs
- The knowledge graph is immutable during simulation (built before, not modified during)
- `RecordedBackend` replays cached decisions without network calls
