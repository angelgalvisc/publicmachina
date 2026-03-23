# PublicMachina Evolution — Implementation Checklist

Reference: [PLAN_PRODUCT_EVOLUTION.md](PLAN_PRODUCT_EVOLUTION.md)

## Dependency Map

```text
Phase 0 ──→ Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 4 ──→ Phase 5
  │                                                             │
  │  (eval harness reused)                                      │
  └─────────────────────────────────────────────────────────────┤
                                                                │
                                                          Phase 6 ──→ Phase 7
                                                                         │
                                                                   Phase 8 ──→ Phase 9
```

## Parallelism Rules

- Within each phase, tasks marked `[P]` can run in parallel with other `[P]` tasks in the same group.
- Tasks marked `[S]` are sequential — they depend on prior tasks completing.
- Tasks marked `[E]` are early-eligible — can be done before their phase if convenient.
- Cross-phase parallelism is noted explicitly where possible.

---

## P1 — Core Memory Evolution

### Phase 0 — Preparation (~1 week)

Goal: baseline and eval criteria ready before building anything.

**Parallel group 0A — Definitions:**

- [x] `0.1` [P] Define eval scenarios (crypto+AI, earnings/market, policy/regulation, rumor vs confirmation, reputational shock) — write as JSON/YAML fixtures in `evals/scenarios/`
- [x] `0.2` [P] Define metrics formally: contradiction rate, stance continuity, relation continuity, narrative coherence, repetition rate, wall time, token usage, cost estimate, interview consistency
- [x] `0.3` [P] Create `evals/` directory structure: `evals/scenarios/`, `evals/baselines/`, `evals/results/`

**Parallel group 0B — Baseline capture (after 0A):**

- [ ] `0.4` [S] Run baseline simulations for each scenario with current engine, save .db files as baselines
- [ ] `0.5` [S] Extract baseline metrics from each .db, store in `evals/baselines/`

**Parallel group 0C — Recommended tech debt (independent of 0A/0B):**

- [ ] `0.6` [P][E] Note tech debt: `src/store.ts` (2422 lines) — consider splitting before Phase 2
- [ ] `0.7` [P][E] Note tech debt: `src/index.ts` (2198 lines) — consider splitting before adding eval CLI command

**Phase 0 exit criteria:**

- [x] At least 3 eval scenarios defined with fixtures (5 defined)
- [x] Metrics list finalized (metrics.yaml with 10 formal metrics)
- [ ] Baseline .db files captured for each scenario

---

### Phase 1 — Graphiti Spike (~1 week)

Goal: verify Graphiti actually improves agent context quality.

**Sequential:**

- [ ] `1.1` [S] Install FalkorDB locally via Docker (`docker run -p 6379:6379 falkordb/falkordb`)
- [ ] `1.2` [S] Install graphiti-core (or equivalent) in a spike branch/script — NOT in main package.json yet
- [ ] `1.3` [S] Pick one completed baseline run .db from Phase 0
- [ ] `1.4` [S] Manually extract 20-30 episodes from that run (posts, follows, belief changes, blocks)
- [ ] `1.5` [S] Ingest episodes into Graphiti
- [ ] `1.6` [S] Query context for 5 actors: Graphiti context vs SQLite memory
- [ ] `1.7` [S] Evaluate coherence: use LLM-as-judge to compare decisions made with each context
- [ ] `1.8` [S] Measure query latency per actor (target: <2s)
- [ ] `1.9` [S] Document setup time (target: <10 min on clean machine)

**Phase 1 exit criteria (go/no-go):**

- [ ] GO: 4/5+ actors produce more coherent decisions with Graphiti context
- [ ] GO: latency <2s per actor
- [ ] GO: setup <10 min
- [ ] NO-GO: discard Graphiti, document why, skip to Phase 6

---

### Phase 2 — Graphiti Integration Base (~1-2 weeks)

Goal: provider, outbox, migrations, feature flags — all wired but not yet writing episodes.

**Parallel group 2A — Interface + config:**

- [x] `2.1` [P] Design `TemporalMemoryProvider` interface in `src/temporal-memory.ts`
  - `healthCheck(): Promise<boolean>`
  - `appendEpisodes(runId, episodes): Promise<void>`
  - `queryActorContext(runId, actorId, query): Promise<string>`
  - `queryNarrativeContext(runId, topics): Promise<string>`
  - `queryRelationshipContext(runId, actorId): Promise<string>`
- [x] `2.2` [P] Implement `NoopTemporalMemoryProvider` (returns empty, always healthy)
- [x] `2.3` [P] Add `temporalMemory` section to `SimConfig` in `config.ts`:
  - `enabled: boolean`
  - `provider: "noop" | "graphiti"`
  - `graphitiEndpoint?: string`
  - `flushStrategy: "end-of-round"`
  - `contextBudget: { tierA: {...}, tierB: {...} }`

**Parallel group 2B — Schema + migrations (parallel with 2A):**

- [x] `2.4` [P] Add `temporal_memory_outbox` table to `schema.ts`
- [x] `2.5` [P] Add `temporal_memory_sync_state` table to `schema.ts`
- [x] `2.6` [P] Add index on outbox `(run_id, round_num, synced_at)`
- [x] `2.7` [S] Create migration v5 in `migrations.ts` for existing databases
- [x] `2.8` [S] Increment `CURRENT_SCHEMA_VERSION` to 5

**Sequential group 2C — Adapter + wiring (after 2A + 2B):**

- [x] `2.9` [S] Implement `GraphitiTemporalMemoryProvider` stub in `src/temporal-memory-graphiti.ts`
  - imports from `src/types.ts` (not `src/db.ts`) ✓
  - connect to FalkorDB/Neo4j (stub — full impl in Phase A2 after spike)
  - implement healthCheck, appendEpisodes, query methods (stub)
- [ ] `2.10` [S] Wire provider creation into `engine.ts` (following searchProvider pattern)
- [ ] `2.11` [S] Add feature flag check: if disabled, use NoopTemporalMemoryProvider
- [x] `2.12` [E] Add `temporalMemoryContext?: string` to `DecisionRequest` in `cognition.ts` (early prep for Phase 4)

**Tests:**

- [x] `2.13` [P] Tests for NoopTemporalMemoryProvider
- [x] `2.14` [P] Tests for migration v5 (upgrade from v4 .db)
- [x] `2.15` [P] Tests for outbox table operations (insert, read pending, mark synced)
- [x] `2.16` [S] Verify `npm run build` passes
- [x] `2.17` [S] Verify `npm test` passes (all existing + new — 42 files, 514 tests)

**Phase 2 exit criteria:**

- [ ] Provider interface exists and is wired
- [ ] Noop provider works as default
- [ ] Outbox tables exist in schema + migration
- [ ] Feature flags control provider selection
- [ ] All tests pass

---

### Phase 3 — Graphiti End-of-Round Sync (~1 week)

Goal: episodes reliably flow from simulation into Graphiti each round.

**Parallel group 3A — Episode derivation:**

- [ ] `3.1` [P] Create `src/temporal-memory-mapper.ts`
  - function `deriveTemporalEpisodes(runId, roundNum, actions, events, narratives): TemporalEpisode[]`
- [ ] `3.2` [P] Map each episode type from simulation actions:
  - `post_created` from post actions
  - `comment_created` from comment actions
  - `repost_created` from repost actions
  - `follow_changed` from follow/unfollow actions
  - `mute_changed` from mute actions
  - `block_changed` from block actions
  - `opinion_expressed` from first-time stance expressions in post content
  - `belief_updated` from belief state changes (comparing before/after)
  - `event_observed` from active events touching actor topics
  - `narrative_shift` from narrative intensity changes

**Sequential group 3B — Outbox write + flush (after 3A):**

- [ ] `3.3` [S] Write derived episodes to `temporal_memory_outbox` in SQLite
- [ ] `3.4` [S] Implement end-of-round flush: read pending outbox → `provider.appendEpisodes()` → mark synced
- [ ] `3.5` [S] Add retry policy: exponential backoff, max 3 attempts per batch
- [ ] `3.6` [S] Update `temporal_memory_sync_state` on success/failure
- [ ] `3.7` [S] Wire `deriveTemporalEpisodes()` call into engine round loop AFTER `persistActorMemories()`

**Tests:**

- [ ] `3.8` [P] Tests for deriveTemporalEpisodes (each episode type)
- [ ] `3.9` [P] Tests for outbox flush + retry logic
- [ ] `3.10` [P] Tests for sync state tracking
- [ ] `3.11` [S] Integration test: full round produces expected outbox rows
- [ ] `3.12` [S] Verify engine still works with Noop provider (no regression)
- [ ] `3.13` [S] `npm run build` + `npm test` pass

**Phase 3 exit criteria:**

- [ ] Episodes flow from round actions → outbox → Graphiti
- [ ] Failures don't break the simulation
- [ ] Sync state is auditable in SQLite

---

### Phase 4 — Graphiti Retrieval for Tier A/B (~1 week)

Goal: agents use Graphiti context when making decisions.

**Sequential (strict dependency chain):**

- [ ] `4.1` [S] Implement `queryActorContext` in GraphitiTemporalMemoryProvider (facts, relationships, contradictions)
- [ ] `4.2` [S] Implement `queryNarrativeContext` (narrative shifts, displaced narratives)
- [ ] `4.3` [S] Implement `queryRelationshipContext` (changed alliances, follows/blocks with temporal provenance)
- [ ] `4.4` [S] Build `composeTemporalMemoryPack(tier, queryResults)` — formats graph results as text within context budget:
  - Tier A: up to 10 facts + 5 relationships + 3 contradictions (~800-1200 tokens)
  - Tier B: up to 3 facts + 2 relationships (~300-500 tokens)
- [ ] `4.5` [S] Wire into engine: query Graphiti BEFORE `backend.decide()`, inject result as `temporalMemoryContext`
- [ ] `4.6` [S] Update `buildDecisionSystemPrompt()` to include temporal memory context when present
- [ ] `4.7` [S] Update `buildDecisionUserPrompt()` to include temporal memory context when present
- [ ] `4.8` [S] Implement fallback: if Graphiti query fails, log error + continue with SQLite-only memory
- [ ] `4.9` [S] Add `temporalMemoryContext` to decision trace for auditability

**Tests:**

- [ ] `4.10` [P] Tests for composeTemporalMemoryPack (budget limits, formatting)
- [ ] `4.11` [P] Tests for fallback path (Graphiti down → graceful degradation)
- [ ] `4.12` [P] Tests for prompt building with temporal context
- [ ] `4.13` [S] Integration test: full round with Graphiti retrieval active
- [ ] `4.14` [S] `npm run build` + `npm test` pass

**Phase 4 exit criteria:**

- [ ] Tier A/B agents receive temporal context before deciding
- [ ] Context budget is respected per tier
- [ ] Fallback to SQLite works when Graphiti is down
- [ ] Decision traces include temporal memory context

---

### Phase 5 — Memory Evaluation (~1 week)

Goal: data-driven decision on whether Graphiti becomes default.

**Sequential:**

- [ ] `5.1` [S] Run all eval scenarios with Graphiti enabled
- [ ] `5.2` [S] Run all eval scenarios with Graphiti disabled (baseline from Phase 0, or re-run)
- [ ] `5.3` [S] Extract metrics from both sets
- [ ] `5.4` [S] Compare: contradiction rate, stance continuity, relation continuity, narrative coherence
- [ ] `5.5` [S] Compare: added latency per round, token usage increase, cost increase
- [ ] `5.6` [S] LLM-as-judge: evaluate interview quality with and without temporal memory
- [ ] `5.7` [S] Write evaluation report in `evals/results/memory-eval.md`

**Phase 5 exit criteria:**

- [ ] Quantitative evidence that Graphiti improves quality metrics
- [ ] Latency within acceptable bounds
- [ ] Cost increase documented and accepted
- [ ] Decision: adopt as opt-in default, keep as experimental, or discard

---

## P2 — Feed & Cast Evolution

### Phase 6 — Feed Experiment / TwHIN-BERT (~2-3 weeks)

Goal: social-representation embeddings improve feed realism.

**Parallel group 6A — Infrastructure:**

- [ ] `6.1` [P] Install `@huggingface/transformers` as dependency
- [ ] `6.2` [P] Create `src/embedding-twhin.ts`:
  - class `TwHINBERTProvider implements EmbeddingProvider`
  - `modelId()` → `"twhin-bert-base"`
  - `embedTexts(texts)` → batch inference via transformers.js
- [ ] `6.3` [P] Add `twhin` sub-section to `FeedConfig` in `config.ts`:
  - `enabled: boolean` (default: false)
  - `model: string` (default: "Twitter/twhin-bert-base")
  - `batchSize: number` (default: 64)
  - `weight: number` (default: 0.3)
- [x] `6.4` [P] Add `"social-hybrid" | "twhin-hybrid"` to `FeedAlgorithm` type in `platform.ts`

**Sequential group 6B — Scoring integration (after 6A):**

- [ ] `6.5` [S] Update `createEmbeddingProvider()` in `embeddings.ts` to return TwHINBERTProvider when twhin is enabled
- [ ] `6.6` [S] Add `social-hybrid` / `twhin-hybrid` case to `scoreByAlgorithm()` in `feed.ts`
- [ ] `6.7` [S] Implement batch pre-compute: embed new posts at end of round (same pattern as current embeddings)
- [ ] `6.8` [S] Implement actor profile re-embed when beliefs change significantly

**Parallel group 6C — Evaluation (after 6B):**

- [ ] `6.9` [P] Run eval scenarios with `algorithm: "hybrid"` (baseline)
- [ ] `6.10` [P] Run eval scenarios with `algorithm: "twhin-hybrid"`
- [ ] `6.11` [S] Compare: diversity of exposure, concentration of reach, superuser dominance, cluster realism
- [ ] `6.12` [S] Compare: latency per round, model download time, embedding batch time
- [ ] `6.13` [S] Write evaluation report in `evals/results/feed-eval.md`

**Tests:**

- [ ] `6.14` [P] Tests for TwHINBERTProvider (mock model, verify interface)
- [ ] `6.15` [P] Tests for new feed algorithm scoring
- [ ] `6.16` [P] Tests for batch pre-compute flow
- [ ] `6.17` [S] `npm run build` + `npm test` pass

**Phase 6 exit criteria:**

- [ ] TwHIN-BERT provider works behind feature flag
- [ ] New feed algorithm produces measurably different exposure patterns
- [ ] Evaluation report documents whether to adopt

---

### Phase 7 — Cast Enrichment (~2-3 weeks)

Goal: actors more grounded in source material and communities more realistic.

**Parallel group 7A — Source grounding (C1):**

- [ ] `7.1` [P] Enhance source document summaries in cast-design.ts:
  - include title, source URL, cleaner summary, key named entities, central claims
- [ ] `7.2` [P] If Graphiti adopted (Phase 5): seed source facts into Graphiti pre-simulation
- [ ] `7.3` [P] Ensure each actor profile has at least 3 verifiable facts from sources

**Parallel group 7B — Profile threading (C2, parallel with 7A):**

- [ ] `7.4` [P] Verify and enforce priority ordering: focusActors > castSeeds > ranked graph entities
- [ ] `7.5` [P] Audit profiles.ts to ensure castSeeds don't get overridden by generic entities

**Sequential group 7C — Graph + community (C3 + C4, after 7A/7B):**

- [ ] `7.6` [S] Use graph to validate entity types (don't assign "journalist" to an entity with no media connections)
- [ ] `7.7` [S] Use graph relationships to enrich actor profiles (known connections, verified claims)
- [ ] `7.8` [S] Strengthen community proposals' impact on follow graph initialization
- [ ] `7.9` [S] Strengthen community proposals' impact on stance distributions
- [ ] `7.10` [S] Add cross-community exposure tuning based on community overlap weights

**Tests:**

- [ ] `7.11` [P] Tests for enhanced source summaries
- [ ] `7.12` [P] Tests for priority ordering enforcement
- [ ] `7.13` [S] Integration test: full design → cast → profiles pipeline with enrichment
- [ ] `7.14` [S] `npm run build` + `npm test` pass

**Phase 7 exit criteria:**

- [ ] Actor profiles are measurably more grounded
- [ ] Community structure produces more realistic follow graphs
- [ ] No regression in existing cast quality

---

## P3 — Output Quality & Product

### Phase 8 — ReportAgent (~1-2 weeks)

Goal: orchestrated analytical reports using existing building blocks.

- [ ] `8.1` [S] Design ReportAgent orchestrator interface:
  - input: question/objective
  - steps: hypothesis → query simulation → interview actors → check counter-evidence → synthesize
- [ ] `8.2` [S] Implement ReACT loop using existing tools:
  - `report.ts` (metrics)
  - `interview.ts` (actor Q&A)
  - `query-service.ts` (NL→SQL)
  - `shell.ts` (interactive queries)
- [ ] `8.3` [S] If Graphiti adopted: add graph traversal step (e.g., "why did Actor A block Actor B?" → trace through temporal graph)
- [ ] `8.4` [S] Wire as new CLI command (`publicmachina analyze`)
- [ ] `8.5` [S] Tests for orchestrator
- [ ] `8.6` [S] `npm run build` + `npm test` pass

---

### Phase 9 — Frontend (~6-8 weeks)

Goal: only if product audience requires it.

- [ ] `9.1` Evaluate whether frontend is needed based on product direction
- [ ] `9.2` If yes: choose stack (likely: Next.js + D3.js + SQLite read-only)
- [ ] `9.3` Community/network graph visualization
- [ ] `9.4` Narrative timeline visualization
- [ ] `9.5` Actor interview chat interface
- [ ] `9.6` Decision trace inspector
- [ ] `9.7` ReportAgent results viewer

---

## Cross-Phase Parallelism Opportunities

These are tasks from later phases that can be started EARLY without waiting for their phase:

| Task | Can start during | Why |
|---|---|---|
| `2.12` Add `temporalMemoryContext` to DecisionRequest | Phase 0 or 1 | No-op field addition, prepares for Phase 4 |
| `6.1` Install @huggingface/transformers | Phase 3 or 4 | Independent of Graphiti work |
| `6.2` Create TwHINBERTProvider | Phase 3 or 4 | Only depends on EmbeddingProvider interface (already exists) |
| `6.3` Add twhin config section | Phase 2 | Config-only change, no runtime impact |
| `6.4` Add FeedAlgorithm variants | Phase 2 | Type-only change |
| `0.6`/`0.7` Tech debt refactoring | Any time | Independent of everything |

**Maximum parallelism strategy:**

```text
Week 1-2:   Phase 0 (eval setup)
            ║
            ╠══ Phase 1 (spike) can overlap with 0.4-0.5 baseline capture
            ║
Week 2-3:   Phase 1 (spike concludes with go/no-go)
            ║
Week 3-5:   Phase 2 (integration base)
            ║   ╠══ 6.1-6.4 (TwHIN infra prep — independent)
            ║   ╠══ 2.12 (DecisionRequest field — early)
            ║
Week 5-6:   Phase 3 (round sync)
            ║   ╠══ 6.2 (TwHINBERTProvider — independent)
            ║
Week 6-7:   Phase 4 (retrieval)
            ║
Week 7-8:   Phase 5 (memory eval)
            ╠══ Phase 6 (feed experiment starts immediately after eval)
            ║
Week 8-10:  Phase 6 (feed experiment concludes)
            ╠══ Phase 7 (cast enrichment — partially parallel with 6)
            ║
Week 10-12: Phase 7 concludes
            ║
Week 12-14: Phase 8 (ReportAgent)
```

---

## Run Metadata Tracking

Each eval run must record:

```yaml
memory_provider: sqlite | graphiti
feed_algorithm: hybrid | twhin-hybrid
twhin_enabled: true | false
graphiti_enabled: true | false
tier_distribution: { A: N, B: N, C: N }
model_config: { tierA: "claude-sonnet", tierB: "haiku" }
version: "0.2.0-phase-N"
```

---

## Summary Counts

| Priority | Phases | Tasks | Estimated weeks |
|---|---|---|---|
| P1 | 0-5 | 56 tasks | 6-8 weeks |
| P2 | 6-7 | 31 tasks | 4-6 weeks |
| P3 | 8-9 | 13 tasks | 7-10 weeks |
| **Total** | **0-9** | **100 tasks** | **10-14 weeks (P1+P2)** |
