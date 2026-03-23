/**
 * temporal-memory.test.ts — Tests for TemporalMemoryProvider + NoopProvider + factory
 */

import { describe, it, expect } from "vitest";
import {
  NoopTemporalMemoryProvider,
  createTemporalMemoryProvider,
} from "../src/temporal-memory.js";
import type { TemporalEpisode } from "../src/types.js";

describe("NoopTemporalMemoryProvider", () => {
  const provider = new NoopTemporalMemoryProvider();

  it("healthCheck always returns true", async () => {
    expect(await provider.healthCheck()).toBe(true);
  });

  it("appendEpisodes is a no-op that does not throw", async () => {
    const episodes: TemporalEpisode[] = [
      {
        id: "ep-1",
        run_id: "run-1",
        round_num: 0,
        episode_type: "post_created",
        actor_id: "actor-1",
        content: "Test post",
        created_at: new Date().toISOString(),
      },
    ];
    await expect(provider.appendEpisodes("run-1", episodes)).resolves.toBeUndefined();
  });

  it("queryActorContext returns empty string", async () => {
    expect(await provider.queryActorContext("run-1", "actor-1")).toBe("");
  });

  it("queryNarrativeContext returns empty string", async () => {
    expect(await provider.queryNarrativeContext("run-1", ["crypto"])).toBe("");
  });

  it("queryRelationshipContext returns empty string", async () => {
    expect(await provider.queryRelationshipContext("run-1", "actor-1")).toBe("");
  });
});

describe("createTemporalMemoryProvider", () => {
  it("returns NoopProvider when disabled", async () => {
    const provider = await createTemporalMemoryProvider({
      enabled: false,
      provider: "noop",
    });
    expect(provider).toBeInstanceOf(NoopTemporalMemoryProvider);
  });

  it("returns NoopProvider when provider is noop even if enabled", async () => {
    const provider = await createTemporalMemoryProvider({
      enabled: true,
      provider: "noop",
    });
    expect(provider).toBeInstanceOf(NoopTemporalMemoryProvider);
  });

  it("falls back to NoopProvider when Graphiti stub healthCheck returns false", async () => {
    // The graphiti stub provider exists but healthCheck returns false.
    // The factory detects this and falls back to NoopProvider for reads,
    // while the outbox write path still works for future sync.
    const provider = await createTemporalMemoryProvider({
      enabled: true,
      provider: "graphiti",
      graphitiEndpoint: "bolt://localhost:9999",
    });
    // Should return Noop (healthy) because stub was detected
    expect(provider).toBeDefined();
    expect(provider).toBeInstanceOf(NoopTemporalMemoryProvider);
    expect(await provider.healthCheck()).toBe(true);
  });
});
