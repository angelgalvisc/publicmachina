#!/usr/bin/env node
/**
 * index.ts — CLI entry point for SeldonClaw
 *
 * Source of truth: PLAN.md §CLI, CLAUDE.md Phase 5.2
 *
 * Commander-based CLI with subcommands:
 *   simulate — run simulation rounds
 *   stats    — show run metrics
 *   (stubs for future phases: run, ingest, analyze, generate, etc.)
 */

import { Command } from "commander";
import { pathToFileURL } from "node:url";
import { SQLiteGraphStore, uuid } from "./db.js";
import { loadConfig, defaultConfig } from "./config.js";
import type { SimConfig } from "./config.js";
import { DirectLLMBackend, MockCognitionBackend, getPromptVersion } from "./cognition.js";
import { runSimulation } from "./engine.js";
import { getTierStats } from "./telemetry.js";
import { LLMClient } from "./llm.js";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIO: CliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function parseIntOption(value: string, field: string): number {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${field}: ${value}`);
  }
  return parsed;
}

async function runSimulateCommand(
  opts: {
    db: string;
    rounds?: string;
    seed?: string;
    config?: string;
    run?: string;
    mock?: boolean;
  },
  io: CliIO
): Promise<void> {
  let config: SimConfig;
  if (opts.config) {
    config = loadConfig(opts.config);
  } else {
    config = defaultConfig();
  }

  if (opts.rounds) {
    const rounds = parseIntOption(opts.rounds, "rounds");
    config.simulation.totalHours = (rounds * config.simulation.minutesPerRound) / 60;
  }

  if (opts.seed !== undefined) {
    config.simulation.seed = parseIntOption(opts.seed, "seed");
  }

  const store = new SQLiteGraphStore(opts.db);
  const runId = opts.run ?? uuid();
  const backend = opts.mock
    ? new MockCognitionBackend()
    : new DirectLLMBackend(
        new LLMClient(config.providers),
        store,
        {
          runId,
          promptVersion: getPromptVersion(),
        }
      );

  try {
    const result = await runSimulation({
      store,
      config,
      backend,
      runId,
    });

    io.stdout(`Simulation ${result.status}\n`);
    io.stdout(`  Run ID: ${result.runId}\n`);
    io.stdout(`  Rounds: ${result.totalRounds}\n`);
    io.stdout(`  Wall time: ${(result.wallTimeMs / 1000).toFixed(1)}s\n`);
  } finally {
    store.close();
  }
}

function runStatsCommand(
  opts: {
    db: string;
    tiers?: boolean;
    run?: string;
  },
  io: CliIO
): void {
  const store = new SQLiteGraphStore(opts.db);

  try {
    const runId = opts.run ?? store.getLatestRunId();
    if (!runId) {
      throw new Error("No runs found in database.");
    }

    const run = store.getRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found.`);
    }

    io.stdout(`Run: ${runId}\n`);
    io.stdout(`  Status: ${run.status}\n`);
    io.stdout(`  Seed: ${run.seed}\n`);
    io.stdout(`  Total rounds: ${run.total_rounds ?? "unknown"}\n`);
    io.stdout(`  Started: ${run.started_at}\n`);
    if (run.finished_at) io.stdout(`  Finished: ${run.finished_at}\n`);

    const roundSummary = store.getRunRoundSummary(runId);
    io.stdout(`  Rounds completed: ${roundSummary.roundsCompleted}\n`);
    io.stdout(`  Total posts: ${roundSummary.totalPosts}\n`);
    io.stdout(`  Total actions: ${roundSummary.totalActions}\n`);
    io.stdout(`  Avg active actors/round: ${roundSummary.avgActiveActors.toFixed(1)}\n`);

    if (opts.tiers) {
      const stats = getTierStats(store, runId);
      const tierCalls = store.getRunTierCallTotals(runId);
      io.stdout(`  Tier breakdown:\n`);
      io.stdout(`    A (always LLM): ${stats.tierA} actors\n`);
      io.stdout(`    B (salient LLM): ${stats.tierB} actors\n`);
      io.stdout(`    C (rules only): ${stats.tierC} actors\n`);
      io.stdout(`    Tier A calls: ${tierCalls.tierACalls}\n`);
      io.stdout(`    Tier B calls: ${tierCalls.tierBCalls}\n`);
      io.stdout(`    Tier C actions: ${tierCalls.tierCActions}\n`);
    }
  } finally {
    store.close();
  }
}

export function createProgram(io: CliIO = defaultIO): Command {
  const program = new Command()
    .name("seldonclaw")
    .version("0.1.0")
    .description("Social simulation engine on CKP")
    .configureOutput({
      writeOut: (text) => io.stdout(text),
      writeErr: (text) => io.stderr(text),
    });

  // ═══════════════════════════════════════════════════════
  // SIMULATE
  // ═══════════════════════════════════════════════════════

  program
    .command("simulate")
    .description("Run simulation rounds on an existing database")
    .option("--db <path>", "SQLite database path", "simulation.db")
    .option("--rounds <n>", "override number of rounds")
    .option("--seed <n>", "PRNG seed (0=random)")
    .option("--config <path>", "config YAML file")
    .option("--run <id>", "run ID (auto-generated if omitted)")
    .option("--mock", "use MockCognitionBackend instead of DirectLLMBackend")
    .action(async (opts) => {
      await runSimulateCommand(opts, io);
    });

  // ═══════════════════════════════════════════════════════
  // STATS
  // ═══════════════════════════════════════════════════════

  program
    .command("stats")
    .description("Show simulation metrics")
    .requiredOption("--db <path>", "SQLite database path")
    .option("--tiers", "show cognition tier breakdown")
    .option("--run <id>", "specific run ID")
    .action((opts) => {
      runStatsCommand(opts, io);
    });

  // ═══════════════════════════════════════════════════════
  // STUB COMMANDS (future phases)
  // ═══════════════════════════════════════════════════════

  const stubs = [
    { name: "run", desc: "Full pipeline: ingest → analyze → generate → simulate" },
    { name: "ingest", desc: "Ingest documents into knowledge graph" },
    { name: "analyze", desc: "Run ontology analysis on knowledge graph" },
    { name: "generate", desc: "Generate actor profiles from knowledge graph" },
    { name: "inspect", desc: "Inspect actor details" },
    { name: "resume", desc: "Resume simulation from last snapshot" },
    { name: "replay", desc: "Replay simulation from decision cache" },
  ];

  for (const stub of stubs) {
    program
      .command(stub.name)
      .description(`${stub.desc} (not yet implemented)`)
      .action(() => {
        io.stdout(`"seldonclaw ${stub.name}" is not yet implemented.\n`);
      });
  }

  return program;
}

export async function runCli(argv = process.argv, io: CliIO = defaultIO): Promise<void> {
  const program = createProgram(io);
  await program.parseAsync(argv);
}

const entryHref = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : null;

if (entryHref && import.meta.url === entryHref) {
  runCli().catch((err) => {
    defaultIO.stderr(`${formatErrorMessage(err)}\n`);
    process.exitCode = 1;
  });
}
