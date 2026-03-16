# Contributing to PublicMachina

PublicMachina is designed to stay auditable, deterministic where it matters, and easy to inspect locally. Contributions should preserve those qualities.

## Getting started

```bash
git clone https://github.com/angelgalvisc/publicmachina.git
cd publicmachina
npm install
npm run build
npm test
```

## Development workflow

```bash
npm run dev         # TypeScript watch mode
npm test            # full test suite
npx vitest          # watch mode
npx tsc --noEmit    # type-check only
npm pack --dry-run  # package smoke check
```

## Docs map for contributors

- [docs/architecture.md](docs/architecture.md) — runtime model, module map, cognition tiers, search internals, CKP bundles
- [DEPLOYMENT.md](DEPLOYMENT.md) — providers, workspace policy, SearXNG, and operational notes
- [PLAN.md](PLAN.md) — active roadmap and design decisions
- [IMPLEMENTATION_HISTORY.md](IMPLEMENTATION_HISTORY.md) — milestone record and historical context

## Engineering rules

- **TypeScript strict mode**: avoid `any` unless there is a strong reason.
- **SQLite is the source of truth**: in-memory state is always a projection.
- **Secrets never go into persisted artifacts**: use the sanitizers already in the repo.
- **Determinism matters**: prefer seeded PRNG paths over ambient randomness.
- **Run isolation matters**: mutable queries should stay scoped by `run_id`.
- **Workspace safety matters**: operator outputs stay inside the configured workspace boundary.

## Test coverage

The suite currently covers:

- ingestion, ontology extraction, graph build, and profile generation
- simulation engine behavior: activation, feed, cognition, propagation, fatigue, events
- deterministic reproducibility and scheduler behavior
- operator workspace, session persistence, and simulation history
- SearXNG client behavior, cutoff filtering, and search cache
- natural-language design, CLI wiring, and packaged binary smoke tests
- CKP export/import, reports, interviews, shell queries, and provider selection

## Real vs mocked integration

The automated suite is intentionally mixed.

Real in tests:

- SQLite
- filesystem I/O
- schema bootstrap
- ingestion fixtures
- report queries
- CLI wiring
- packaged binary smoke checks

Mocked by design:

- LLM-backed extraction
- actor deliberation
- report narrative generation
- shell NL->SQL prompting
- natural-language simulation design

Still manual:

1. live provider execution with your API key
2. live SearXNG integration against your own endpoint

## Pull requests

1. Create a branch from `main`
2. Add or update tests for behavioral changes
3. Run `npm run build` and `npm test`
4. Update docs if the user-facing behavior changed
5. Submit a pull request with a concise explanation of the change and its risk

## Reporting issues

Use GitHub Issues for bugs and feature requests. For security-sensitive issues, follow the repository security channel instead of posting secrets or exploit details publicly.
