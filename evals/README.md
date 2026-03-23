# PublicMachina Evaluation Framework

## Structure

```
evals/
  scenarios/       # YAML scenario definitions (what to simulate)
  baselines/       # Baseline .db files and extracted metrics
  results/         # Comparison results per phase
  metrics.yaml     # Formal metric definitions
  README.md        # This file
```

## Scenarios

| ID | Name | Actors | Rounds | Key dynamics tested |
|---|---|---|---|---|
| crypto-ai-regulation | SEC joint AI-crypto framework | 30 | 24 | Polarization, cascades, echo chambers |
| earnings-market-structure | Tech earnings miss + sector rotation | 25 | 24 | Credibility shifts, narrative competition |
| policy-tariff-shock | Semiconductor tariff | 35 | 24 | Second-order effects, coalition formation |
| rumor-vs-confirmation | False acquisition rumor + denial | 30 | 24 | Misinformation dynamics, correction lag |
| reputational-shock | Major data breach at cloud company | 30 | 24 | Crisis response, stakeholder divergence |

## Metrics

See `metrics.yaml` for formal definitions. Summary:

**Quality** (what we want to improve):
- Contradiction rate (lower is better)
- Stance continuity (higher is better)
- Relation continuity (lower flip rate)
- Narrative coherence (LLM-judge, 1-5)
- Repetition rate (lower is better)

**Runtime** (must not regress beyond thresholds):
- Wall time per round
- Added latency for Tier A/B
- Token usage
- Total cost estimate

**Output utility** (measured after improvements):
- Interview consistency
- Report usefulness

## How to run evaluations

Evaluations compare a **baseline** (current engine) against a **variant** (with new feature enabled).

1. Capture baseline: run each scenario with current config, save .db
2. Enable variant: change config for the feature being tested
3. Run variant: same scenario, same seed, save .db
4. Extract metrics from both .db files
5. Compare using metrics.yaml definitions
6. Document findings in `results/`

**Important notes on variant availability:**

- **Graphiti memory** (`temporalMemory.enabled: true`): **NOT runnable yet.** The Graphiti provider is a stub pending the Phase A1 spike. Enabling it will write episodes to the outbox table but produce zero temporal context for decisions. Wait for the spike to validate and implement the real provider before running memory evaluations.
- **TwHIN-BERT feed** (`feed.twhin.enabled: true`): Requires `@huggingface/transformers` to be installed (`npm install @huggingface/transformers`). Without the package, the provider silently falls back to zero vectors, producing no real signal. The run will not fail, but the comparison will be invalid.
- **Cast enrichment**: Available now — uses existing graph data.

## Adoption rule

No new feature becomes default unless it measurably improves quality metrics without exceeding runtime regression thresholds.
