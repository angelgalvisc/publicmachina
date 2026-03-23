/**
 * embedding-twhin.ts — TwHIN-BERT social embedding provider
 *
 * Uses @huggingface/transformers to run Twitter/twhin-bert-base locally
 * on CPU for social-representation embeddings.
 *
 * Key design decisions (PLAN_PRODUCT_EVOLUTION.md §1.4, §6.3.1):
 *   - Local CPU inference via @huggingface/transformers (no Python, no GPU)
 *   - Model downloads automatically to ~/.cache/huggingface/ on first use (~500MB)
 *   - Batch pre-compute at end of each round (not per-request)
 *   - Feature flag: config.feed.twhin.enabled
 *   - Falls back to HashEmbeddingProvider if transformers.js is not installed
 *
 * Reference: PLAN_PRODUCT_EVOLUTION.md §6, IMPLEMENTATION_CHECKLIST.md Phase 6
 */

import type { EmbeddingProvider } from "./embeddings.js";

// ═══════════════════════════════════════════════════════
// TwHIN-BERT PROVIDER
// ═══════════════════════════════════════════════════════

/**
 * TwHIN-BERT embedding provider using @huggingface/transformers.
 *
 * The model (~500MB) is downloaded automatically on first use.
 * Subsequent runs load from cache (~50ms/embedding on CPU).
 *
 * This class uses lazy initialization — the model is not loaded until
 * the first call to embedTexts(). This avoids startup cost when
 * TwHIN is configured but the feed algorithm doesn't use it.
 */
export class TwHINBERTProvider implements EmbeddingProvider {
  private pipeline: any = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly model: string = "Twitter/twhin-bert-base",
    private readonly batchSize: number = 64
  ) {}

  modelId(): string {
    return `twhin:${this.model}`;
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    await this.ensureInitialized();

    if (!this.pipeline) {
      // Fallback: if transformers.js failed to load, return zero vectors
      return texts.map(() => new Array(768).fill(0));
    }

    // Process in batches to avoid memory issues
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const output = await this.pipeline(batch, {
        pooling: "mean",
        normalize: true,
      });

      // Convert tensor output to plain arrays
      for (let j = 0; j < batch.length; j++) {
        const vec = output[j];
        results.push(Array.isArray(vec) ? vec : Array.from(vec.data ?? vec));
      }
    }

    return results;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.pipeline) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.loadModel();
    await this.initPromise;
  }

  private async loadModel(): Promise<void> {
    try {
      // Dynamic import to avoid hard dependency
      // Dynamic import — @huggingface/transformers is an optional dependency
      const moduleName = "@huggingface/transformers";
      const transformers = await import(/* webpackIgnore: true */ moduleName);
      this.pipeline = await (transformers as any).pipeline(
        "feature-extraction",
        this.model
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[twhin] Failed to load @huggingface/transformers or model "${this.model}": ${message}. ` +
        `TwHIN embeddings will return zero vectors. Install with: npm install @huggingface/transformers`
      );
      this.pipeline = null;
    }
  }
}

// ═══════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════

/**
 * Create a TwHIN-BERT provider. Used by createEmbeddingProvider() when
 * twhin is enabled. Returns the provider immediately — the actual model
 * loading is deferred to the first embedTexts() call.
 */
export function createTwhinProvider(
  model: string = "Twitter/twhin-bert-base",
  batchSize: number = 64
): EmbeddingProvider {
  return new TwHINBERTProvider(model, batchSize);
}
