# PublicMachina Product Evolution Plan

## Status

This document captures the current product-evolution plan for PublicMachina after the operator, replay/resume, grounding, cast-design, and auditability hardening work already shipped.

It reflects the decisions already made:

- SQLite remains the operational source of truth.
- Graphiti is considered as a temporal memory layer, not as a full runtime replacement.
- TwHIN-BERT is treated as a feed-ranking experiment, not as a drop-in recommendation engine.
- The current cast pipeline stays and is strengthened incrementally.
- Frontend is not an immediate priority while the product is still optimized for technical operation through the CLI.

Workstream lettering is standardized in this document as:

- Workstream A = Graphiti / temporal memory
- Workstream B = feed realism
- Workstream C = cast / ontology / graph enrichment
- Workstream D = formal evaluation
- Workstream E = ReportAgent
- Workstream F = frontend

---

## 1. Decisions Already Taken

### 1.1 SQLite Stays

SQLite remains the operational ledger of the simulator.

It continues to own:

- runs
- rounds
- actors
- posts
- follows / mutes / blocks
- narratives
- decision traces
- snapshots
- replay / resume
- caches

Reason:

- portable single-file runs
- strong auditability
- straightforward SQL inspection
- replay/resume already works well on this model
- strong CLI alignment

### 1.2 Graphiti Does Not Replace SQLite

Graphiti enters as a temporal memory and context engine, not as the main runtime database.

Graphiti is for:

- temporal facts
- changing relationships
- contradiction / invalidation
- fact validity windows
- richer contextual retrieval

### 1.3 OASIS-Style Distributed Scale Is Out of Scope

Not a priority:

- vLLM
- multi-GPU clusters
- local massive-agent infra
- million-agent scale

Reason:

- the product is API-first
- cost-efficiency comes from cognition routing, not brute-force scale
- current A/B/C tiering is better aligned with the intended operating model

### 1.4 TwHIN-BERT Enters as a Ranking Signal, Not as a Full RecSys

TwHIN-BERT is considered for feed realism as an additional social representation signal.

It is not treated as a full recommendation system replacement.

Infrastructure decision for the experiment:

- runtime: `@huggingface/transformers` in Node.js
- model: `Twitter/twhin-bert-base`
- execution mode: local CPU batch inference
- strategy: pre-compute / refresh embeddings at the end of each round
- storage: SQLite embedding caches (`post_embeddings`, `actor_interest_embeddings`)
- feature flag: `config.feed.twhin.enabled`
- no external embedding API
- no Python sidecar
- no GPU requirement in the first implementation

### 1.5 The Current Cast Pipeline Stays

The current cast pipeline is kept and improved:

- spec design
- source downloads
- cast design
- castSeeds
- communityProposals
- entityTypeHints

### 1.6 Frontend Is Deferred

The CLI is sufficient for:

- research
- internal operation
- technical workflows
- engine development

Frontend becomes relevant later if the product is aimed at non-technical stakeholders or self-serve workflows.

---

## 2. Product Goal

The objective is to make PublicMachina produce more realistic social simulations while preserving:

- API-based model usage
- controlled cost
- strong auditability
- replay/resume
- CLI-first operator workflow

What "better" means:

1. Better memory
   - fewer contradictions
   - stronger stance continuity
   - richer relational history
2. Better feed realism
   - more plausible exposure patterns
   - less artificial amplification
   - more realistic clustering / echo-chamber effects
3. Better cast quality
   - actors more anchored to scenario and sources
   - more natural communities
   - less generic role generation
4. Better outputs
   - stronger interviews
   - better reports
   - better causal explanations

---

## 3. Architecture Target

### 3.1 Current Simplified Flow

```text
Brief
  ↓
Spec Design
  ↓
Source Downloads
  ↓
Cast Design
  ↓
Ingest
  ↓
Ontology / Graph
  ↓
Profiles
  ↓
Simulation Engine
  ↓
SQLite (.db)
  ├─ runs
  ├─ actors
  ├─ posts
  ├─ narratives
  ├─ memories
  ├─ decision_traces
  ├─ snapshots
  └─ replay/resume state
```

### 3.2 Target Architecture

```text
                          ┌──────────────────────────────┐
                          │        PublicMachina         │
                          │     Simulation Runtime       │
                          └──────────────┬───────────────┘
                                         │
                    ┌────────────────────┼────────────────────┐
                    │                    │                    │
                    ▼                    ▼                    ▼
         ┌─────────────────┐   ┌──────────────────┐  ┌──────────────────┐
         │  SQLite Ledger  │   │ Feed / Exposure  │  │ Temporal Memory  │
         │  source of truth│   │ ranking engine   │  │    Graphiti      │
         └─────────────────┘   └──────────────────┘  └──────────────────┘
                    │                    │                    │
                    │                    │                    │
                    ▼                    ▼                    ▼
         ┌─────────────────┐   ┌──────────────────┐  ┌──────────────────┐
         │ replay/resume   │   │ TwHIN-style      │  │ facts, episodes, │
         │ inspect/report  │   │ ranking signals  │  │ validity windows │
         │ SQL audit       │   │ optional layer   │  │ contradictions   │
         └─────────────────┘   └──────────────────┘  └──────────────────┘
```

### 3.3 Golden Rule

```text
SQLite = execution ledger
Graphiti = temporal memory/context
Feed layer = exposure/ranking realism
Cast layer = actor quality and social structure
```

---

## 4. Workstream A: Graphiti as Temporal Memory

### 4.1 Objective

Close the biggest current realism gap:

- memory today is useful but flat
- temporal validity is weak
- contradictions are not first-class
- relationship history is limited
- retrieval is much simpler than a temporal graph can support

### 4.2 Core Decision

Do not do this:

```text
Runtime → Graphiti only
```

Do this:

```text
Runtime → SQLite first
           ↓
      Outbox / sync
           ↓
        Graphiti
```

### 4.2.1 Graphiti Infrastructure Requirements

Graphiti requires a graph backend service.

Initial support assumptions:

- preferred lightweight path: FalkorDB
- alternative path: Neo4j

Deployment options:

- local Docker service
- managed / cloud-hosted graph service

Operational rule:

- if Graphiti is disabled or unavailable, PublicMachina must continue to work exactly as it works today
- Graphiti is an opt-in enhancement layer until proven valuable and stable

Implication:

- this is a real tradeoff against the current "single `.db`" portability story
- the tradeoff is accepted only if evaluation proves meaningful memory gains

### 4.3 New Integration Layer

Create a new abstraction in something like:

- `src/temporal-memory.ts`

The interface should define:

- `healthCheck()`
- `appendEpisodes(runId, episodes)`
- `queryActorContext(runId, actorId, query)`
- `queryNarrativeContext(runId, topics)`
- `queryRelationshipContext(runId, actorId)`

Implementations:

- `NoopTemporalMemoryProvider`
- `GraphitiTemporalMemoryProvider`

Pre-change recommended before retrieval work:

- extend `DecisionRequest` with an optional `temporalMemoryContext?: string`
- thread it through prompt-building and test fixtures before Phase A4

This keeps the future Graphiti integration additive instead of forcing a larger refactor when retrieval is introduced.

### 4.4 Outbox Pattern

Do not write directly to Graphiti inline for every action.

Add SQLite tables such as:

```text
temporal_memory_outbox
  - id
  - run_id
  - round_num
  - episode_type
  - payload_json
  - created_at
  - synced_at
  - sync_error
```

Optional:

```text
temporal_memory_sync_state
  - run_id
  - last_synced_round
  - last_success_at
  - last_error
```

This gives:

- reliable sync
- retries
- non-blocking execution
- auditable failures
- no lost memory episodes

### 4.5 Initial Episode Types

Do not ingest everything in v1.

Start with:

- `event_observed`
- `opinion_expressed`
- `post_created`
- `comment_created`
- `repost_created`
- `follow_changed`
- `mute_changed`
- `block_changed`
- `belief_updated`
- `narrative_shift`

Why `opinion_expressed` is separate from `belief_updated`:

- `opinion_expressed` captures first-time or externally visible stance expression
- `belief_updated` captures an actual change from a prior internal state

This distinction matters for contradiction detection later in the run.

### 4.6 Write Flow

```text
Round executes
  ↓
SQLite writes canonical state
  ↓
Temporal episodes derived
  ↓
Outbox rows inserted
  ↓
End-of-round sync
  ↓
Graphiti ingests episodes
```

Implementation rule:

- keep flat SQLite memory persistence and temporal-episode derivation as separate steps
- do not fold Graphiti episode generation into `persistActorMemories()`
- let the engine remain the orchestrator of both:
  - `persistActorMemories(...)`
  - `deriveTemporalEpisodes(...)`

This preserves separation of concerns and keeps the flat-memory path usable as a fallback and baseline.

### 4.7 Read Flow

Only use Graphiti for Tier A/B at first.

```text
Actor decision request
  ↓
Route cognition tier
  ↓
If tier A/B:
  query Graphiti context
     - recent relevant facts
     - changed relationships
     - invalidated beliefs
     - narrative shifts
  ↓
compose memory pack
  ↓
LLM/backend decide
```

Context budget by tier:

- Tier A
  - up to 10 relevant facts
  - up to 5 changing relationships
  - up to 3 contradictions / invalidations
  - estimated added context budget: ~800-1200 tokens
- Tier B
  - up to 3 most relevant facts
  - up to 2 relationship changes
  - estimated added context budget: ~300-500 tokens
- Tier C
  - no Graphiti query
  - remains deterministic and low-cost

### 4.8 Fallback Rule

If Graphiti fails:

- do not stop the run
- fall back to current SQLite memory
- log telemetry and sync failures

### 4.9 Modules Likely Involved

- `src/config.ts`
- `src/schema.ts`
- `src/store.ts`
- `src/migrations.ts`
- `src/engine.ts`
- `src/cognition.ts`
- `src/memory.ts`
- new:
  - `src/temporal-memory.ts`
  - `src/temporal-memory-graphiti.ts`
  - `src/temporal-memory-mapper.ts`

Import hygiene rule for new temporal-memory modules:

- prefer importing pure domain types from `src/types.ts`
- avoid depending on the `src/db.ts` barrel unless the store abstraction is actually required

This reduces the chance of introducing circular dependencies as the memory layer grows.

### 4.10 Graphiti Phases

#### Phase A1 — Spike

Goal:

- verify that Graphiti actually improves useful context for agents

Work:

- prototype against real runs
- adapt a small set of episodes manually
- compare 3-5 actors before / after

Exit:

- evidence of useful improvement, or discard

Go / no-go criteria:

GO if:

- Graphiti-backed context produces more coherent decisions in at least 4 of 5 evaluated actors
- query latency stays below 2 seconds per actor on the test machine
- local setup stays within ~10 minutes on a clean machine

NO-GO if:

- improvement is weak or inconsistent in most sampled actors
- query latency exceeds 5 seconds per actor
- setup requires heavy DevOps overhead for normal use
- backend cost / ops burden is disproportionate to the measured gain

#### Phase A2 — Integration Base

Work:

- provider abstraction
- feature flags
- outbox tables
- migrations
- Graphiti adapter
- health checks

#### Phase A3 — Round Sync

Work:

- emit episodes each round
- flush to Graphiti end-of-round
- retry policy
- tracing

#### Phase A4 — Decision Retrieval

Work:

- query Graphiti before Tier A/B decisions
- enrich memory pack
- preserve SQLite fallback

#### Phase A5 — Interviews and Reports

Work:

- richer interviews with temporal relational history
- reports that explain:
  - when a stance changed
  - when an alliance broke
  - what fact was invalidated
  - what narrative displaced another

#### Phase A6 — Evaluation

Success criteria:

- fewer contradictions
- stronger stance continuity
- stronger relational continuity
- better narrative coherence
- acceptable added latency
- no regression in replay/resume

---

## 5. Workstream D: Formal Evaluation

This is mandatory.

### 5.1 Objective

Do not adopt memory, feed, or cast changes by intuition alone.

### 5.2 Evaluation Harness

Create a fixed set of scenarios such as:

- crypto + AI
- earnings / market structure
- policy / regulation
- rumor vs confirmation
- reputational shock

### 5.3 Comparisons

#### Memory

- baseline: current SQLite memory
- variant: Graphiti-backed memory

#### Feed

- baseline: current `hybrid`
- variant: TwHIN-enriched / socially enriched feed

#### Cast

- baseline: current cast pipeline
- variant: enriched cast / graph-backed validation

### 5.4 Metrics

```text
Quality
  - contradiction rate
  - stance continuity
  - relation continuity
  - narrative coherence
  - repetition rate

Runtime
  - wall time / round
  - added latency Tier A/B
  - token usage
  - search requests
  - total cost estimate

Output utility
  - interview consistency
  - report usefulness
  - stakeholder readability
```

### 5.5 Run Metadata for Comparability

Runs must carry enough metadata to make experimental comparisons valid.

Target metadata set:

- `memory_provider`: `sqlite` | `graphiti`
- `feed_algorithm`: `hybrid` | `twhin-hybrid` | other future variants
- `twhin_enabled`: boolean
- `graphiti_enabled`: boolean
- `tier_distribution`: `{ A, B, C }`
- `model_config`: per-tier model selection and provider choices
- `version`: PublicMachina version / plan milestone

Without this, phase-to-phase evaluation becomes noisy and historically hard to interpret.

### 5.6 Adoption Rule

No new layer becomes default unless it improves:

- quality
- or quality / cost tradeoff

---

## 6. Workstream B: Feed Realism / TwHIN-BERT

### 6.1 Objective

Improve exposure realism.

This matters because what an agent sees directly changes what it decides.

### 6.2 Current State

PublicMachina already supports:

- `chronological`
- `heuristic`
- `trace-aware`
- `embedding`
- `hybrid`

### 6.3 Decision

Do not treat TwHIN-BERT as a full recommendation engine.

Treat it as:

- a social representation model
- an additional ranking signal
- an experiment to compare against the current feed engine

### 6.3.1 Embedding Infrastructure Decision

Implementation decision for the first experiment:

- use `@huggingface/transformers` directly from Node.js
- use `Twitter/twhin-bert-base`
- run locally on CPU
- compute embeddings in batch at the end of each round
- persist vectors to SQLite caches
- avoid external embedding APIs in the first iteration
- avoid GPU and Python as hard requirements

Initial storage targets:

- `post_embeddings`
- `actor_interest_embeddings`

### 6.4 Correct Integration Pattern

Do not do this:

```text
TwHIN-BERT -> replace feed engine
```

Do this:

```text
Current feed scoring
   + social representation score
   + affinity score
   + community signal
   + trace-aware signal
   = new hybrid ranking
```

### 6.5 Scoring Sketch

```text
score(post, actor) =
  base_heuristic
  + trace_signal
  + community_affinity
  + semantic_embedding_similarity
  + social_representation_similarity
  + recency / fatigue adjustments
```

### 6.6 Feed Phases

#### Phase B1 — Design

Define:

- actor representation
- post representation
- engagement-likelihood signal
- integration point in the current ranking stack

#### Phase B2 — Experimental Algorithm

Add a new algorithm such as:

- `social-hybrid`
- or `twhin-hybrid`

#### Phase B3 — Comparison

Compare against `hybrid` on:

- diversity of exposure
- concentration of reach
- superuser dominance
- cluster realism
- latency and cost

### 6.7 Success Criteria

- more plausible exposure dynamics
- fewer obvious artifacts
- better cluster / echo-chamber formation
- acceptable runtime overhead

### 6.8 Operational Notes

The first TwHIN experiment is intentionally constrained:

- no online per-request embedding calls
- no external embedding provider dependency
- no GPU assumption
- batch refresh only

If local CPU inference proves too slow, hosted embeddings can be reconsidered later, but they are not part of the first design.

---

## 7. Workstream C: Cast / Ontology / Graph Enrichment

### 7.1 Objective

Improve actor quality without throwing away the current pipeline.

### 7.2 Current Pipeline

The current flow is already stronger than it used to be:

```text
Brief
  ↓
Spec Design
  ↓
Source Downloads
  ↓
Cast Design
    - castSeeds
    - communityProposals
    - entityTypeHints
  ↓
Ingest / Graph
  ↓
Profiles
    priority:
      1. focusActors
      2. castSeeds
      3. ranked graph entities
```

### 7.3 Decision

Do not discard the current pipeline.

Strengthen it incrementally.

The cast-enrichment graph is the same Graphiti introduced in Workstream A.

Do not create two separate graph infrastructures.

Unified graph lifecycle:

```text
Pre-simulation:
  source facts -> Graphiti

During simulation:
  actor episodes -> Graphiti

Post-simulation:
  reports / interviews query the same Graphiti
```

### 7.4 Concrete Improvements

#### C1. Better Grounding for Cast Design

The cast design layer currently uses summaries of downloaded source docs.

Make them more useful by including:

- title
- source URL
- cleaner summary
- key named entities
- central claims

The objective is to seed the same graph that later receives simulated episodes, so pre-simulation grounding and in-simulation memory live in one temporal system.

#### C2. Stronger Threading into Profiles

Make sure the priority is always:

1. `focusActors`
2. `castSeeds`
3. ranked graph entities

#### C3. Better Graph Usage

Use the graph to:

- validate types
- enrich relations
- prioritize entities

Do not let it become the only source of the cast.

#### C4. Stronger Community Impact

Ensure community proposals influence:

- follow graph initialization
- affinity
- stance distributions
- cross-community exposure

### 7.5 What Not to Do Yet

- do not rewrite everything into a rigid ontology-first pipeline
- do not let the graph become the only source of truth for actors

---

## 8. Workstream E: ReportAgent

### 8.1 Objective

Produce stronger analytical outputs for stakeholders.

### 8.2 Existing Building Blocks

PublicMachina already has:

- reporting
- interviews
- query service
- shell

### 8.3 Missing Layer

An orchestrator that does this:

```text
Question / objective
  ↓
Hypothesis
  ↓
Query simulation
  ↓
Interview key actors
  ↓
Check counter-evidence
  ↓
Synthesize report
```

### 8.4 Timing

This comes after:

- memory quality improves
- feed realism improves
- cast quality improves

---

## 9. Workstream F: Frontend

### 9.1 Decision

Frontend is not necessary now.

### 9.2 When CLI Is Enough

- internal research
- operator-led workflows
- technical teams
- engine quality focus

### 9.3 When Frontend Becomes Necessary

- commercial demos
- non-technical stakeholders
- self-serve exploration
- interactive visualization of:
  - communities
  - narratives
  - timelines
  - decision traces

### 9.4 Priority

P3, after engine realism is improved.

---

## 10. Roadmap by Phase

### Phase 0 — Preparation

Goal:

- define baselines and evaluation criteria

Work:

- select benchmark scenarios
- define metrics
- capture current baseline

Estimated duration:

- ~1 week

Technical-debt note before major expansion:

- `src/store.ts` is already very large and may merit capability-oriented extraction during or before Phase A2
- `src/index.ts` is already very large and may merit command extraction before Workstream D grows the CLI further

These are recommended refactors, not hard blockers.

### Phase 1 — Graphiti Spike

Goal:

- verify Graphiti improves memory context

Estimated duration:

- ~1 week

### Phase 2 — Graphiti Integration Base

Goal:

- provider, outbox, migrations, feature flags

Estimated duration:

- ~1-2 weeks

### Phase 3 — Graphiti End-of-Round Sync

Goal:

- write episodes to Graphiti reliably

Estimated duration:

- ~1 week

### Phase 4 — Graphiti Retrieval for Tier A/B

Goal:

- use Graphiti context before decisions

Estimated duration:

- ~1 week

### Phase 5 — Memory Evaluation

Goal:

- decide if Graphiti becomes an adopted capability

Estimated duration:

- ~1 week

### Phase 6 — Feed Experiment

Goal:

- add social-representation signal
- compare against `hybrid`

Estimated duration:

- ~2-3 weeks

### Phase 7 — Cast Enrichment

Goal:

- strengthen cast grounding and community realism

Estimated duration:

- ~2-3 weeks

### Phase 8 — ReportAgent

Goal:

- increase analytical output quality

Estimated duration:

- ~1-2 weeks

### Phase 9 — Frontend

Goal:

- only if product audience requires it

Estimated duration:

- ~6-8 weeks

### 10.1 Timeline Summary

```text
P1 total (Phases 0-5): ~6-8 weeks
P2 total (Phases 6-7): ~4-6 weeks
P3 total (Phases 8-9): ~7-10 weeks

P1 + P2 combined: ~10-14 weeks
```

---

## 11. Final Prioritization

### P1

1. Graphiti spike
2. Graphiti provider + outbox
3. Graphiti retrieval for Tier A/B
4. formal memory evaluation

### P2

5. feed realism / TwHIN experiment
6. feed evaluation
7. cast enrichment

### P3

8. ReportAgent
9. frontend
10. multi-platform expansion

---

## 12. Risks and Mitigations

### 12.1 Dual-Write Divergence

Risk:

- SQLite and Graphiti drift apart

Mitigation:

- outbox pattern
- retries
- sync state tracking

### 12.2 Latency Increase

Risk:

- graph queries slow rounds down too much

Mitigation:

- only query Graphiti for Tier A/B

### 12.3 Scope Creep

Risk:

- trying to make Graphiti do everything

Mitigation:

- keep SQLite as the operational ledger

### 12.4 Feed Miscalibration

Risk:

- TwHIN-style signals worsen dynamics

Mitigation:

- strict A/B comparison against the current `hybrid` baseline

### 12.5 Cast Overengineering

Risk:

- turning the cast pipeline into a rigid, heavy system too early

Mitigation:

- incremental strengthening instead of full reinvention

### 12.6 Runaway Cost

Risk:

- a bug, loop, or unexpectedly large prompt causes excessive API spend

Mitigation:

- configurable cost cap per run
- warning at ~80% of estimated cap
- automatic abort or pause at ~100% of cap

### 12.7 Provider Outage

Risk:

- Anthropic / OpenAI / provider outage during a run

Mitigation:

- exponential backoff retries
- circuit breaker after repeated failures
- optional fallback provider chain when configured
- otherwise pause the run cleanly rather than corrupting state

---

## 13. Success Criteria

### Memory

- fewer contradictions
- better stance continuity
- better relational continuity

### Feed

- more plausible exposure
- fewer obvious artifacts
- more realistic clustering

### Cast

- better scenario grounding
- more natural communities
- less generic behavior

### Product

- better interviews
- better reports
- no major cost or latency regression
- run metadata rich enough to compare experiments across versions

---

## 14. Executive Summary

### What Will Be Done

- Graphiti, but as temporal memory
- TwHIN-BERT, but as a feed-ranking experiment
- cast strengthening, not cast replacement
- formal evaluation of all major changes
- SQLite remains the operational core

### What Will Not Be Done Now

- replacing SQLite
- pursuing OASIS-style infra scale
- making Graphiti the main runtime backend
- building frontend before engine quality justifies it
- treating TwHIN-BERT as a complete recsys

### Final Position on Frontend

Frontend is not required now.

The CLI is enough while the focus is:

- engine quality
- technical analysis
- internal operation

Frontend becomes necessary only when PublicMachina shifts from technical tool to stakeholder-facing product.
