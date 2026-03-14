/**
 * ingest.ts — Document parsing, chunking, and ingestion into GraphStore
 *
 * Source of truth: PLAN.md §Project Structure (line 110),
 *                  §Provenance tables (lines 176-207)
 *
 * Responsibilities:
 * - Parse MD/TXT documents from a directory or file list
 * - Chunk documents by paragraph (default) or by token count
 * - SHA-256 content_hash for document deduplication
 * - Persist via GraphStore.addDocument() + addChunk()
 *
 * Design decisions:
 * - Chunking by paragraph first, then split oversize paragraphs by token limit
 * - Token estimation: ~4 chars/token (consistent with MockLLMClient in llm.ts)
 * - Re-ingesting the same document (same content_hash) is a no-op, returns existing doc
 * - PDF support is optional (v2), only MD/TXT in v1
 */

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import type { GraphStore, DocumentRecord, Chunk } from "./db.js";

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

export interface IngestOptions {
  /** Max tokens per chunk (default: 512). Paragraphs exceeding this are split. */
  maxChunkTokens?: number;
  /** Minimum chunk size in characters to avoid tiny fragments (default: 50) */
  minChunkChars?: number;
  /** MIME type override (auto-detected from extension if not provided) */
  mimeType?: string;
  /** Additional metadata to attach to the document record (JSON-serializable) */
  metadata?: Record<string, unknown>;
}

export interface IngestResult {
  /** Document ID (existing or newly created) */
  documentId: string;
  /** Number of chunks created (0 if document already existed) */
  chunksCreated: number;
  /** Whether the document was already in the database (dedup hit) */
  deduplicated: boolean;
  /** The content hash used for dedup */
  contentHash: string;
}

export interface BatchIngestResult {
  /** Results per file */
  results: IngestResult[];
  /** Total documents ingested (new, not deduplicated) */
  newDocuments: number;
  /** Total chunks created across all new documents */
  totalChunks: number;
  /** Documents skipped due to dedup */
  skippedDocuments: number;
  /** Files that failed to process */
  errors: Array<{ filename: string; error: string }>;
}

// ═══════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════

const DEFAULT_MAX_CHUNK_TOKENS = 512;
const DEFAULT_MIN_CHUNK_CHARS = 50;
const CHARS_PER_TOKEN = 4; // rough estimate, consistent with MockLLMClient

/** Supported file extensions */
const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".markdown"]);

/** MIME type mapping by extension */
const MIME_BY_EXT: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
};

// ═══════════════════════════════════════════════════════
// CORE: computeContentHash
// ═══════════════════════════════════════════════════════

/**
 * Compute SHA-256 hash of content for deduplication.
 * Normalizes line endings before hashing to ensure cross-platform consistency.
 */
export function computeContentHash(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

// ═══════════════════════════════════════════════════════
// CORE: estimateTokens
// ═══════════════════════════════════════════════════════

/**
 * Rough token count estimation (~4 chars per token).
 * Used for chunk sizing. Not exact, but sufficient for chunking decisions.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ═══════════════════════════════════════════════════════
// CORE: chunkByParagraph
// ═══════════════════════════════════════════════════════

/**
 * Split text into chunks by paragraph boundaries.
 *
 * Algorithm:
 * 1. Split on double-newline boundaries (paragraph separator)
 * 2. Filter out empty/whitespace-only paragraphs
 * 3. Filter out paragraphs shorter than minChunkChars
 * 4. If a paragraph exceeds maxChunkTokens, split it further by sentences
 * 5. If a sentence still exceeds, split by hard character boundary
 *
 * Returns array of chunk content strings with their estimated token counts.
 */
export function chunkByParagraph(
  content: string,
  maxChunkTokens: number = DEFAULT_MAX_CHUNK_TOKENS,
  minChunkChars: number = DEFAULT_MIN_CHUNK_CHARS
): Array<{ content: string; tokenCount: number }> {
  const normalized = content.replace(/\r\n/g, "\n");

  // Split on paragraph boundaries (2+ newlines)
  const rawParagraphs = normalized.split(/\n{2,}/);

  const chunks: Array<{ content: string; tokenCount: number }> = [];

  for (const para of rawParagraphs) {
    const trimmed = para.trim();
    if (trimmed.length < minChunkChars) continue;

    const tokens = estimateTokens(trimmed);

    if (tokens <= maxChunkTokens) {
      // Paragraph fits in one chunk
      chunks.push({ content: trimmed, tokenCount: tokens });
    } else {
      // Paragraph too large — split by sentences
      const subChunks = splitOversizeParagraph(
        trimmed,
        maxChunkTokens,
        minChunkChars
      );
      chunks.push(...subChunks);
    }
  }

  return chunks;
}

/**
 * Split an oversize paragraph into smaller chunks.
 * First tries sentence-level splits, then falls back to hard character boundaries.
 */
function splitOversizeParagraph(
  text: string,
  maxChunkTokens: number,
  minChunkChars: number
): Array<{ content: string; tokenCount: number }> {
  const maxChars = maxChunkTokens * CHARS_PER_TOKEN;
  const chunks: Array<{ content: string; tokenCount: number }> = [];

  // Try splitting by sentences first
  // Regex: split on sentence-ending punctuation followed by space or end
  const sentences = text.split(/(?<=[.!?])\s+/);

  let currentChunk = "";

  for (const sentence of sentences) {
    const combined = currentChunk
      ? currentChunk + " " + sentence
      : sentence;

    if (combined.length <= maxChars) {
      currentChunk = combined;
    } else {
      // Push current chunk if it meets min size
      if (currentChunk.length >= minChunkChars) {
        chunks.push({
          content: currentChunk,
          tokenCount: estimateTokens(currentChunk),
        });
      }

      // Start new chunk with current sentence
      if (sentence.length <= maxChars) {
        currentChunk = sentence;
      } else {
        // Sentence itself exceeds max — hard split
        const hardChunks = hardSplit(sentence, maxChars, minChunkChars);
        chunks.push(...hardChunks);
        currentChunk = "";
      }
    }
  }

  // Don't forget the last accumulated chunk
  if (currentChunk.length >= minChunkChars) {
    chunks.push({
      content: currentChunk,
      tokenCount: estimateTokens(currentChunk),
    });
  }

  return chunks;
}

/**
 * Hard split text at character boundaries (last resort).
 * Tries to split at word boundaries when possible.
 */
function hardSplit(
  text: string,
  maxChars: number,
  minChunkChars: number
): Array<{ content: string; tokenCount: number }> {
  const chunks: Array<{ content: string; tokenCount: number }> = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      if (remaining.trim().length >= minChunkChars) {
        chunks.push({
          content: remaining.trim(),
          tokenCount: estimateTokens(remaining.trim()),
        });
      }
      break;
    }

    // Try to find a word boundary near maxChars
    let splitAt = maxChars;
    const lastSpace = remaining.lastIndexOf(" ", maxChars);
    if (lastSpace > maxChars * 0.5) {
      splitAt = lastSpace;
    }

    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk.length >= minChunkChars) {
      chunks.push({
        content: chunk,
        tokenCount: estimateTokens(chunk),
      });
    }

    remaining = remaining.slice(splitAt).trim();
  }

  return chunks;
}

// ═══════════════════════════════════════════════════════
// CORE: ingestDocument
// ═══════════════════════════════════════════════════════

/**
 * Ingest a single document into the GraphStore.
 *
 * Steps:
 * 1. Compute content_hash (SHA-256) for dedup
 * 2. Check if document with same hash already exists → skip
 * 3. Create document record
 * 4. Chunk content by paragraph boundaries
 * 5. Create chunk records with sequential chunk_index
 *
 * @param store - GraphStore instance
 * @param filename - Original filename (used for display and metadata)
 * @param content - Full text content of the document
 * @param options - Ingestion options (chunk size, metadata, etc.)
 * @returns IngestResult with document ID and chunk count
 */
export function ingestDocument(
  store: GraphStore,
  filename: string,
  content: string,
  options: IngestOptions = {}
): IngestResult {
  const contentHash = computeContentHash(content);

  // Dedup: check if this exact content already exists
  const existing = store.getDocumentByHash(contentHash);
  if (existing) {
    return {
      documentId: existing.id,
      chunksCreated: 0,
      deduplicated: true,
      contentHash,
    };
  }

  // Determine MIME type
  const ext = extname(filename).toLowerCase();
  const mimeType =
    options.mimeType ?? MIME_BY_EXT[ext] ?? "text/plain";

  // Create document record
  const docId = store.addDocument({
    id: "", // auto-generated by GraphStore
    filename,
    content_hash: contentHash,
    mime_type: mimeType,
    metadata: options.metadata
      ? JSON.stringify(options.metadata)
      : undefined,
  });

  // Chunk the content
  const maxTokens = options.maxChunkTokens ?? DEFAULT_MAX_CHUNK_TOKENS;
  const minChars = options.minChunkChars ?? DEFAULT_MIN_CHUNK_CHARS;
  const chunks = chunkByParagraph(content, maxTokens, minChars);

  // Persist chunks
  for (let i = 0; i < chunks.length; i++) {
    store.addChunk({
      id: "", // auto-generated by GraphStore
      document_id: docId,
      chunk_index: i,
      content: chunks[i].content,
      token_count: chunks[i].tokenCount,
    });
  }

  return {
    documentId: docId,
    chunksCreated: chunks.length,
    deduplicated: false,
    contentHash,
  };
}

// ═══════════════════════════════════════════════════════
// CORE: ingestFile
// ═══════════════════════════════════════════════════════

/**
 * Read a file from disk and ingest it.
 *
 * @param store - GraphStore instance
 * @param filePath - Absolute or relative path to the file
 * @param options - Ingestion options
 * @returns IngestResult
 * @throws Error if file cannot be read or has unsupported extension
 */
export async function ingestFile(
  store: GraphStore,
  filePath: string,
  options: IngestOptions = {}
): Promise<IngestResult> {
  const ext = extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported file type "${ext}". Supported: ${[...SUPPORTED_EXTENSIONS].join(", ")}`
    );
  }

  const content = await readFile(filePath, "utf-8");
  const filename = basename(filePath);

  return ingestDocument(store, filename, content, options);
}

// ═══════════════════════════════════════════════════════
// CORE: ingestDirectory
// ═══════════════════════════════════════════════════════

/**
 * Ingest all supported documents from a directory (non-recursive).
 *
 * @param store - GraphStore instance
 * @param dirPath - Path to directory containing documents
 * @param options - Ingestion options (applied to all files)
 * @returns BatchIngestResult with per-file results and aggregates
 */
export async function ingestDirectory(
  store: GraphStore,
  dirPath: string,
  options: IngestOptions = {}
): Promise<BatchIngestResult> {
  const entries = await readdir(dirPath);

  // Filter to supported file types
  const supportedFiles = entries.filter((f) =>
    SUPPORTED_EXTENSIONS.has(extname(f).toLowerCase())
  );

  // Sort for deterministic ordering
  supportedFiles.sort();

  const results: IngestResult[] = [];
  const errors: Array<{ filename: string; error: string }> = [];

  for (const filename of supportedFiles) {
    const filePath = join(dirPath, filename);

    // Verify it's a file, not a directory
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) continue;
    } catch {
      errors.push({ filename, error: "Cannot stat file" });
      continue;
    }

    try {
      const result = await ingestFile(store, filePath, options);
      results.push(result);
    } catch (err) {
      errors.push({
        filename,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const newDocuments = results.filter((r) => !r.deduplicated).length;
  const totalChunks = results.reduce((sum, r) => sum + r.chunksCreated, 0);
  const skippedDocuments = results.filter((r) => r.deduplicated).length;

  return {
    results,
    newDocuments,
    totalChunks,
    skippedDocuments,
    errors,
  };
}
