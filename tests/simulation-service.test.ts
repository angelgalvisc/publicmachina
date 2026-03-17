import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { SQLiteGraphStore } from "../src/db.js";
import { executePipeline } from "../src/simulation-service.js";

const tempDirs: string[] = [];

function fixtureDocsDir(): string {
  return join(process.cwd(), "tests", "fixtures", "sample-docs");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("simulation-service.ts", () => {
  it("propagates actorCount into profile generation and limits created actors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "publicmachina-simulation-service-"));
    tempDirs.push(dir);

    const config = defaultConfig();
    config.simulation.totalHours = 1;
    config.simulation.minutesPerRound = 60;

    const dbPath = join(dir, "simulation.db");
    const result = await executePipeline({
      config,
      dbPath,
      docsPath: fixtureDocsDir(),
      runId: "actor-limit-run",
      actorCount: 1,
      mock: true,
    });

    const store = new SQLiteGraphStore(dbPath);
    const actors = store.getActorsByRun("actor-limit-run");
    store.close();

    expect(result.status).toBe("completed");
    expect(result.actorsCreated).toBe(1);
    expect(actors).toHaveLength(1);
  });
});
