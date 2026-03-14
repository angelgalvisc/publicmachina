/**
 * ingest.test.ts — Tests for document ingestion pipeline
 *
 * Covers:
 * - computeContentHash() produces consistent SHA-256
 * - estimateTokens() approximation
 * - chunkByParagraph() splitting logic
 * - ingestDocument() creates documents + chunks in DB
 * - Dedup: re-ingesting same content returns existing doc
 * - ingestFile() reads from disk
 * - ingestDirectory() batch ingestion
 * - Chunks have valid document_id FK
 * - Oversize paragraph splitting
 * - Cross-platform line ending normalization
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { SQLiteGraphStore } from "../src/db.js";
import {
  computeContentHash,
  estimateTokens,
  chunkByParagraph,
  ingestDocument,
  ingestFile,
  ingestDirectory,
} from "../src/ingest.js";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures", "sample-docs");

describe("computeContentHash", () => {
  it("produces a 64-char hex SHA-256", () => {
    const hash = computeContentHash("hello world");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic (same input → same output)", () => {
    const a = computeContentHash("test content");
    const b = computeContentHash("test content");
    expect(a).toBe(b);
  });

  it("different content → different hash", () => {
    const a = computeContentHash("content A");
    const b = computeContentHash("content B");
    expect(a).not.toBe(b);
  });

  it("normalizes CRLF to LF before hashing", () => {
    const unix = computeContentHash("line one\nline two");
    const windows = computeContentHash("line one\r\nline two");
    expect(unix).toBe(windows);
  });
});

describe("estimateTokens", () => {
  it("estimates ~4 chars per token", () => {
    expect(estimateTokens("hello")).toBe(2); // 5 / 4 = 1.25 → ceil = 2
    expect(estimateTokens("abcdefgh")).toBe(2); // 8 / 4 = 2
    expect(estimateTokens("")).toBe(0);
  });

  it("handles long text", () => {
    const text = "a".repeat(2048);
    expect(estimateTokens(text)).toBe(512);
  });
});

describe("chunkByParagraph", () => {
  it("splits text on double-newline boundaries", () => {
    const text = "First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph.";
    // "Third paragraph." is only 16 chars, below default 50 min
    const chunks = chunkByParagraph(text, 512, 10);
    expect(chunks.length).toBe(3);
    expect(chunks[0].content).toBe("First paragraph here.");
    expect(chunks[1].content).toBe("Second paragraph here.");
    expect(chunks[2].content).toBe("Third paragraph.");
  });

  it("filters out chunks below minChunkChars", () => {
    const text = "Short.\n\nThis is a sufficiently long paragraph for testing purposes.";
    const chunks = chunkByParagraph(text, 512, 50);
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toContain("sufficiently long");
  });

  it("filters out empty paragraphs", () => {
    const text = "Paragraph one.\n\n\n\n\n\nParagraph two.";
    const chunks = chunkByParagraph(text, 512, 5);
    expect(chunks.length).toBe(2);
  });

  it("splits oversize paragraphs by sentence", () => {
    // Create a paragraph that exceeds 20 tokens (80 chars at 4 chars/token)
    const longPara = "This is sentence one with enough words. This is sentence two with more words. This is sentence three which adds length. This is sentence four for good measure.";
    const chunks = chunkByParagraph(longPara, 20, 10); // 20 tokens = 80 chars max
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be within token limit
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(20);
    }
  });

  it("handles text with only single newlines (no paragraph breaks)", () => {
    const text = "Line one.\nLine two.\nLine three.";
    const chunks = chunkByParagraph(text, 512, 5);
    // All lines are in one paragraph (single newline doesn't split)
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toContain("Line one.");
    expect(chunks[0].content).toContain("Line three.");
  });

  it("provides accurate token count estimates", () => {
    const text = "A paragraph with exactly some content here for counting.";
    const chunks = chunkByParagraph(text, 512, 5);
    expect(chunks.length).toBe(1);
    expect(chunks[0].tokenCount).toBe(Math.ceil(text.length / 4));
  });
});

describe("ingestDocument", () => {
  let store: SQLiteGraphStore;

  beforeEach(() => {
    store = new SQLiteGraphStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("creates document and chunks in DB", () => {
    const content =
      "# Title\n\nFirst paragraph with enough content to pass the minimum chunk size threshold easily.\n\nSecond paragraph also with enough content to pass the threshold and create a valid chunk.";

    const result = ingestDocument(store, "test.md", content);

    expect(result.deduplicated).toBe(false);
    expect(result.chunksCreated).toBeGreaterThan(0);
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.documentId).toBeTruthy();

    // Verify document in DB
    const doc = store.getDocumentByHash(result.contentHash);
    expect(doc).not.toBeNull();
    expect(doc!.filename).toBe("test.md");
    expect(doc!.content_hash).toBe(result.contentHash);
    expect(doc!.mime_type).toBe("text/markdown");

    // Verify chunks in DB
    const chunks = store.getChunksByDocument(result.documentId);
    expect(chunks.length).toBe(result.chunksCreated);
    for (const chunk of chunks) {
      expect(chunk.document_id).toBe(result.documentId);
    }
  });

  it("deduplicates: re-ingesting same content returns existing doc", () => {
    const content =
      "Some document content that is long enough to produce at least one chunk for testing dedup.";

    const first = ingestDocument(store, "doc1.txt", content);
    const second = ingestDocument(store, "doc1-copy.txt", content);

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.documentId).toBe(first.documentId);
    expect(second.chunksCreated).toBe(0);
    expect(second.contentHash).toBe(first.contentHash);

    // Only one document in DB
    const allDocs = store.getAllDocuments();
    expect(allDocs.length).toBe(1);
  });

  it("different content creates separate documents", () => {
    const contentA =
      "First document with unique content that is different from the other document entirely.";
    const contentB =
      "Second document with completely different content that does not match the first at all.";

    const a = ingestDocument(store, "a.md", contentA);
    const b = ingestDocument(store, "b.md", contentB);

    expect(a.documentId).not.toBe(b.documentId);
    expect(a.contentHash).not.toBe(b.contentHash);

    const allDocs = store.getAllDocuments();
    expect(allDocs.length).toBe(2);
  });

  it("chunks have sequential chunk_index starting at 0", () => {
    const content = [
      "# Title",
      "",
      "First paragraph with enough length to pass the minimum chunk chars threshold for ingestion.",
      "",
      "Second paragraph with enough length to pass the minimum chunk chars threshold for ingestion.",
      "",
      "Third paragraph with enough length to pass the minimum chunk chars threshold for ingestion.",
    ].join("\n");

    const result = ingestDocument(store, "test.md", content);
    const chunks = store.getChunksByDocument(result.documentId);

    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunk_index).toBe(i);
    }
  });

  it("sets mime_type based on file extension", () => {
    const content = "Some content long enough for at least one chunk to be created during ingestion test.";

    ingestDocument(store, "readme.md", content);
    ingestDocument(store, "notes.txt", content + " v2"); // different content for no dedup

    const docs = store.getAllDocuments();
    const md = docs.find((d) => d.filename === "readme.md");
    const txt = docs.find((d) => d.filename === "notes.txt");

    expect(md!.mime_type).toBe("text/markdown");
    expect(txt!.mime_type).toBe("text/plain");
  });

  it("attaches metadata when provided", () => {
    const content = "Document with metadata that is long enough to produce at least one chunk in the test.";
    const result = ingestDocument(store, "test.md", content, {
      metadata: { author: "test", source_url: "https://example.com" },
    });

    const doc = store.getDocumentByHash(result.contentHash);
    expect(doc).not.toBeNull();
    const meta = JSON.parse(doc!.metadata!);
    expect(meta.author).toBe("test");
    expect(meta.source_url).toBe("https://example.com");
  });

  it("respects custom maxChunkTokens", () => {
    // Create content with several paragraphs
    const paragraphs = Array.from({ length: 5 }, (_, i) =>
      `This is paragraph number ${i + 1} with enough text to be a valid chunk on its own terms.`
    );
    const content = paragraphs.join("\n\n");

    // Very small chunk size to force more chunks
    const result = ingestDocument(store, "test.md", content, {
      maxChunkTokens: 30,
      minChunkChars: 10,
    });

    const chunks = store.getChunksByDocument(result.documentId);
    // Each chunk should have token count <= 30
    for (const chunk of chunks) {
      expect(chunk.token_count).toBeLessThanOrEqual(30);
    }
  });

  it("each chunk has a valid token_count", () => {
    const content =
      "A paragraph with enough text to be useful for testing.\n\nAnother paragraph with different content that is also long enough.";

    const result = ingestDocument(store, "test.md", content, {
      minChunkChars: 10,
    });
    const chunks = store.getChunksByDocument(result.documentId);

    for (const chunk of chunks) {
      expect(chunk.token_count).toBeGreaterThan(0);
      // token_count should roughly match content length / 4
      const expected = Math.ceil(chunk.content.length / 4);
      expect(chunk.token_count).toBe(expected);
    }
  });
});

describe("ingestFile", () => {
  let store: SQLiteGraphStore;

  beforeEach(() => {
    store = new SQLiteGraphStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("reads and ingests a markdown file from disk", async () => {
    const filePath = join(FIXTURES_DIR, "university-tuition.md");
    const result = await ingestFile(store, filePath);

    expect(result.deduplicated).toBe(false);
    expect(result.chunksCreated).toBeGreaterThan(0);

    // Verify in DB
    const doc = store.getDocumentByHash(result.contentHash);
    expect(doc).not.toBeNull();
    expect(doc!.filename).toBe("university-tuition.md");
    expect(doc!.mime_type).toBe("text/markdown");
  });

  it("reads and ingests a text file from disk", async () => {
    const filePath = join(FIXTURES_DIR, "media-coverage.txt");
    const result = await ingestFile(store, filePath);

    expect(result.deduplicated).toBe(false);
    expect(result.chunksCreated).toBeGreaterThan(0);

    const doc = store.getDocumentByHash(result.contentHash);
    expect(doc!.mime_type).toBe("text/plain");
  });

  it("re-ingesting the same file deduplicates", async () => {
    const filePath = join(FIXTURES_DIR, "university-tuition.md");
    const first = await ingestFile(store, filePath);
    const second = await ingestFile(store, filePath);

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.documentId).toBe(first.documentId);
    expect(second.chunksCreated).toBe(0);
  });

  it("rejects unsupported file extensions", async () => {
    await expect(
      ingestFile(store, "/tmp/test.pdf")
    ).rejects.toThrow("Unsupported file type");
  });
});

describe("ingestDirectory", () => {
  let store: SQLiteGraphStore;

  beforeEach(() => {
    store = new SQLiteGraphStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("ingests all supported files from sample-docs/", async () => {
    const result = await ingestDirectory(store, FIXTURES_DIR);

    // We have 3 fixture files: 2 .md + 1 .txt
    expect(result.newDocuments).toBe(3);
    expect(result.totalChunks).toBeGreaterThan(0);
    expect(result.skippedDocuments).toBe(0);
    expect(result.errors.length).toBe(0);
    expect(result.results.length).toBe(3);

    // Verify all documents are in DB
    const allDocs = store.getAllDocuments();
    expect(allDocs.length).toBe(3);
  });

  it("re-ingesting the same directory deduplicates all files", async () => {
    const first = await ingestDirectory(store, FIXTURES_DIR);
    const second = await ingestDirectory(store, FIXTURES_DIR);

    expect(first.newDocuments).toBe(3);
    expect(second.newDocuments).toBe(0);
    expect(second.skippedDocuments).toBe(3);
    expect(second.totalChunks).toBe(0);

    // Still only 3 docs in DB
    const allDocs = store.getAllDocuments();
    expect(allDocs.length).toBe(3);
  });

  it("chunks have valid document_id FK references", async () => {
    await ingestDirectory(store, FIXTURES_DIR);

    const allDocs = store.getAllDocuments();
    for (const doc of allDocs) {
      const chunks = store.getChunksByDocument(doc.id);
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect(chunk.document_id).toBe(doc.id);
      }
    }
  });

  it("processes files in deterministic order (sorted)", async () => {
    const result = await ingestDirectory(store, FIXTURES_DIR);

    // Results should be alphabetically ordered by filename
    const filenames = result.results.map((r) => {
      const doc = store.getDocumentByHash(r.contentHash);
      return doc!.filename;
    });

    const sorted = [...filenames].sort();
    expect(filenames).toEqual(sorted);
  });
});
