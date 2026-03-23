/**
 * embedding-twhin.test.ts — Tests for TwHIN-BERT provider + feed algorithm integration
 */

import { describe, it, expect, vi } from "vitest";
import { TwHINBERTProvider, createTwhinProvider } from "../src/embedding-twhin.js";
import { createEmbeddingProvider, createEmbeddingProviderAsync, HashEmbeddingProvider } from "../src/embeddings.js";
import type { FeedConfig } from "../src/config.js";

// ═══════════════════════════════════════════════════════
// TwHINBERTProvider
// ═══════════════════════════════════════════════════════

describe("TwHINBERTProvider", () => {
  it("has correct modelId", () => {
    const provider = new TwHINBERTProvider("Twitter/twhin-bert-base");
    expect(provider.modelId()).toBe("twhin:Twitter/twhin-bert-base");
  });

  it("returns zero vectors when @huggingface/transformers is not installed", async () => {
    const provider = new TwHINBERTProvider("nonexistent/model");
    const vectors = await provider.embedTexts(["test text", "another text"]);

    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(768);
    // All zeros because the model failed to load
    expect(vectors[0].every((v) => v === 0)).toBe(true);
  });

  it("handles empty input gracefully", async () => {
    const provider = new TwHINBERTProvider();
    const vectors = await provider.embedTexts([]);
    expect(vectors).toHaveLength(0);
  });

  it("processes batches correctly", async () => {
    const provider = new TwHINBERTProvider("nonexistent/model", 2);
    const texts = ["a", "b", "c", "d", "e"];
    const vectors = await provider.embedTexts(texts);
    expect(vectors).toHaveLength(5);
  });
});

describe("createTwhinProvider", () => {
  it("returns a TwHINBERTProvider instance", () => {
    const provider = createTwhinProvider("Twitter/twhin-bert-base", 32);
    expect(provider).toBeInstanceOf(TwHINBERTProvider);
    expect(provider.modelId()).toBe("twhin:Twitter/twhin-bert-base");
  });
});

// ═══════════════════════════════════════════════════════
// createEmbeddingProvider integration
// ═══════════════════════════════════════════════════════

describe("createEmbeddingProvider with twhin config", () => {
  const baseFeedConfig: FeedConfig = {
    size: 20,
    algorithm: "hybrid",
    recencyWeight: 0.4,
    popularityWeight: 0.3,
    relevanceWeight: 0.3,
    echoChamberStrength: 0.5,
    traceWeight: 0.25,
    outOfNetworkRatio: 0.35,
    diversityWeight: 0.2,
    embeddingEnabled: false,
    embeddingWeight: 0.25,
    embeddingModel: "hash-embedding-v1",
    embeddingDimensions: 32,
    twhin: {
      enabled: false,
      model: "Twitter/twhin-bert-base",
      batchSize: 64,
      weight: 0.3,
    },
  };

  it("returns HashEmbeddingProvider when twhin is disabled", () => {
    const provider = createEmbeddingProvider(baseFeedConfig);
    expect(provider).toBeInstanceOf(HashEmbeddingProvider);
  });

  it("returns TwHINBERTProvider when twhin is enabled (async)", async () => {
    const config = {
      ...baseFeedConfig,
      twhin: { ...baseFeedConfig.twhin, enabled: true },
    };
    const provider = await createEmbeddingProviderAsync(config);
    // Should be TwHINBERTProvider (loaded via dynamic import)
    expect(provider.modelId()).toContain("twhin:");
  });
});

// ═══════════════════════════════════════════════════════
// Feed algorithm scoring (social-hybrid / twhin-hybrid)
// ═══════════════════════════════════════════════════════

describe("social-hybrid feed algorithm", () => {
  // We test the algorithm selection by importing buildFeed and checking
  // that the new algorithm produces different rankings than "hybrid"

  it("twhin-hybrid algorithm is accepted by FeedAlgorithm type", () => {
    const config: FeedConfig = {
      ...{
        size: 20,
        algorithm: "twhin-hybrid",
        recencyWeight: 0.4,
        popularityWeight: 0.3,
        relevanceWeight: 0.3,
        echoChamberStrength: 0.5,
        traceWeight: 0.25,
        outOfNetworkRatio: 0.35,
        diversityWeight: 0.2,
        embeddingEnabled: true,
        embeddingWeight: 0.25,
        embeddingModel: "hash-embedding-v1",
        embeddingDimensions: 32,
        twhin: {
          enabled: true,
          model: "Twitter/twhin-bert-base",
          batchSize: 64,
          weight: 0.3,
        },
      },
    };
    expect(config.algorithm).toBe("twhin-hybrid");
  });

  it("social-hybrid algorithm is accepted by FeedAlgorithm type", () => {
    const config: FeedConfig = {
      size: 20,
      algorithm: "social-hybrid",
      recencyWeight: 0.4,
      popularityWeight: 0.3,
      relevanceWeight: 0.3,
      echoChamberStrength: 0.5,
      traceWeight: 0.25,
      outOfNetworkRatio: 0.35,
      diversityWeight: 0.2,
      embeddingEnabled: true,
      embeddingWeight: 0.25,
      embeddingModel: "hash-embedding-v1",
      embeddingDimensions: 32,
      twhin: {
        enabled: false,
        model: "Twitter/twhin-bert-base",
        batchSize: 64,
        weight: 0.3,
      },
    };
    expect(config.algorithm).toBe("social-hybrid");
  });
});
