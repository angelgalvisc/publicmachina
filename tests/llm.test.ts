/**
 * llm.test.ts — Regression tests for MockLLMClient
 *
 * Covers:
 * - MockLLMClient.complete() works
 * - MockLLMClient.chat() works (regression: was not overridden)
 * - MockLLMClient.completeJSON() works
 * - hasProvider() and getModel() return mock values
 */

import { describe, it, expect } from "vitest";
import { MockLLMClient } from "../src/llm.js";

describe("MockLLMClient", () => {
  it("complete() returns canned response by pattern", async () => {
    const mock = new MockLLMClient();
    mock.setResponse("hello", '{"greeting": "world"}');

    const result = await mock.complete("analysis", "say hello please");
    expect(result.content).toBe('{"greeting": "world"}');
    expect(result.model).toBe("mock-model");
    expect(result.costUsd).toBe(0);
  });

  it("complete() returns default {} for unmatched prompts", async () => {
    const mock = new MockLLMClient();
    const result = await mock.complete("analysis", "some random prompt");
    expect(result.content).toBe("{}");
  });

  it("chat() works without throwing (regression)", async () => {
    const mock = new MockLLMClient();
    mock.setResponse("question", "the answer is 42");

    const result = await mock.chat("analysis", [
      { role: "user", content: "I have a question for you" },
    ]);

    expect(result.content).toBe("the answer is 42");
    expect(result.model).toBe("mock-model");
  });

  it("chat() uses last user message for matching", async () => {
    const mock = new MockLLMClient();
    mock.setResponse("second", "matched second");

    const result = await mock.chat("report", [
      { role: "user", content: "first message" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second message" },
    ]);

    expect(result.content).toBe("matched second");
  });

  it("completeJSON() parses JSON correctly", async () => {
    const mock = new MockLLMClient();
    mock.setResponse("extract", '{"entities": ["Org A", "Org B"]}');

    const result = await mock.completeJSON<{ entities: string[] }>(
      "analysis",
      "please extract entities"
    );

    expect(result.data.entities).toEqual(["Org A", "Org B"]);
    expect(result.meta.model).toBe("mock-model");
  });

  it("completeJSON() extracts JSON when the model wraps it in prose", async () => {
    const mock = new MockLLMClient();
    mock.setResponse("wrapped", 'Claro. Aquí va:\n{"entities":["Org A"]}\nFin.');

    const result = await mock.completeJSON<{ entities: string[] }>(
      "analysis",
      "please extract wrapped entities"
    );

    expect(result.data.entities).toEqual(["Org A"]);
  });

  it("completeJSON() repairs simple malformed JSON when allowRepair=true", async () => {
    const mock = new MockLLMClient();
    mock.setResponse("repair", '{"entities":["Org A",],}');

    const result = await mock.completeJSON<{ entities: string[] }>(
      "analysis",
      "please repair entities",
      { allowRepair: true }
    );

    expect(result.data.entities).toEqual(["Org A"]);
  });

  it("hasProvider() returns true for all roles", () => {
    const mock = new MockLLMClient();
    expect(mock.hasProvider("analysis")).toBe(true);
    expect(mock.hasProvider("generation")).toBe(true);
    expect(mock.hasProvider("simulation")).toBe(true);
    expect(mock.hasProvider("report")).toBe(true);
  });

  it("getModel() returns mock-model", () => {
    const mock = new MockLLMClient();
    expect(mock.getModel("analysis")).toBe("mock-model");
  });
});
