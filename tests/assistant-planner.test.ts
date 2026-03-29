import { describe, expect, it } from "vitest";
import { MockLLMClient } from "../src/llm.js";
import { ASSISTANT_TOOLS } from "../src/assistant-tools.js";
import { planAssistantStep } from "../src/assistant-planner.js";

describe("assistant-planner.ts — LLM-first routing", () => {
  it("routes a design request via LLM", async () => {
    const llm = new MockLLMClient();
    llm.setResponse(
      "Latest user input:\nDesign and run an election rumor simulation.",
      JSON.stringify({
        kind: "tool_call",
        tool: "design_simulation",
        arguments: {
          brief: "Design and run an election rumor simulation.",
          docsPath: "./docs/elections",
        },
      })
    );

    const decision = await planAssistantStep(llm, {
      contextSummary: "Operator identity: PublicMachina.",
      currentTaskSummary: "- Status: idle",
      conversation: [],
      userInput: "Design and run an election rumor simulation.",
      tools: ASSISTANT_TOOLS,
    });

    expect(decision.kind).toBe("tool_call");
    if (decision.kind === "tool_call") {
      expect(decision.tool).toBe("design_simulation");
      // docsPath is only trusted when extracted from the actual brief text
      // (not from LLM-generated args), so it's undefined here
      expect(decision.arguments.docsPath).toBeUndefined();
      expect(decision.arguments.brief).toBe("Design and run an election rumor simulation.");
    }
  });

  it("preserves the user's exact brief even when the LLM rewrites it", async () => {
    const llm = new MockLLMClient();
    const userInput = [
      "Design a new simulation.",
      "",
      "Title:",
      "NVIDIA NemoClaw impact on Bitcoin",
      "",
      "Primary source:",
      "https://example.com/nemoclaw",
    ].join("\n");

    // Mock: LLM tries to summarize the brief and hallucinate a docsPath
    llm.setResponse(
      "NemoClaw",
      JSON.stringify({
        kind: "tool_call",
        tool: "design_simulation",
        arguments: {
          brief: "A summarized version the LLM tried to rewrite",
          docsPath: "./hallucinated-docs",
        },
      })
    );

    const decision = await planAssistantStep(llm, {
      contextSummary: "Operator identity: PublicMachina.",
      currentTaskSummary: "- Status: idle",
      conversation: [],
      userInput,
      tools: ASSISTANT_TOOLS,
    });

    expect(decision.kind).toBe("tool_call");
    if (decision.kind === "tool_call") {
      expect(decision.tool).toBe("design_simulation");
      // The normalizer should override with the full user input
      expect(decision.arguments.brief).toBe(userInput);
      // Hallucinated docsPath should be dropped (not in the actual input)
      expect(decision.arguments.docsPath).toBeUndefined();
    }
  });

  it("routes a conversational question as a direct response", async () => {
    const llm = new MockLLMClient();
    llm.setResponse(
      "Latest user input:\nWhat can you do here?",
      JSON.stringify({
        kind: "respond",
        message: "I can design, run, inspect, report on, and compare simulations.",
      })
    );

    const decision = await planAssistantStep(llm, {
      contextSummary: "Operator identity: PublicMachina.",
      currentTaskSummary: "- Status: idle",
      conversation: [],
      userInput: "What can you do here?",
      tools: ASSISTANT_TOOLS,
    });

    expect(decision.kind).toBe("respond");
    if (decision.kind === "respond") {
      expect(decision.message).toContain("design");
    }
  });

  it("retries once when the first LLM JSON response is invalid", async () => {
    const llm = new MockLLMClient();
    let calls = 0;
    llm.complete = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          content: '{"kind":"tool_call","tool":"design_simulation","arguments":{"brief":"Truncated',
          model: "mock-model",
          inputTokens: 10,
          outputTokens: 10,
          costUsd: 1,
          durationMs: 1,
        };
      }
      return {
        content: JSON.stringify({
          kind: "tool_call",
          tool: "design_simulation",
          arguments: { brief: "Redesign the simulation." },
        }),
        model: "mock-model",
        inputTokens: 10,
        outputTokens: 10,
        costUsd: 2,
        durationMs: 1,
      };
    };

    const decision = await planAssistantStep(llm, {
      contextSummary: "Operator identity: PublicMachina.",
      currentTaskSummary: "- Status: designed",
      conversation: [],
      userInput: "Redesign it with that context",
      tools: ASSISTANT_TOOLS,
    });

    expect(calls).toBe(2);
    expect(decision.kind).toBe("tool_call");
    if (decision.kind === "tool_call") {
      expect(decision.tool).toBe("design_simulation");
      expect(decision.meta.costUsd).toBe(3);
    }
  });

  it("extracts JSON when the LLM wraps it in prose", async () => {
    const llm = new MockLLMClient();
    llm.setResponse(
      "Latest user input:\nRun it now",
      'Sure — here is the decision:\n{"kind":"tool_call","tool":"run_simulation","arguments":{"confirmed":true}}\nThanks.'
    );

    const decision = await planAssistantStep(llm, {
      contextSummary: "Operator identity: PublicMachina.",
      currentTaskSummary: "- Status: awaiting_confirmation",
      conversation: [],
      userInput: "Run it now",
      tools: ASSISTANT_TOOLS,
    });

    expect(decision.kind).toBe("tool_call");
    if (decision.kind === "tool_call") {
      expect(decision.tool).toBe("run_simulation");
      expect(decision.arguments.confirmed).toBe(true);
    }
  });

  it("adds offline=true when user mentions offline in a run confirmation", async () => {
    const llm = new MockLLMClient();
    llm.setResponse(
      "Latest user input:\nyes offline",
      JSON.stringify({
        kind: "tool_call",
        tool: "run_simulation",
        arguments: { confirmed: true },
      })
    );

    const decision = await planAssistantStep(llm, {
      contextSummary: "Operator identity: PublicMachina.",
      currentTaskSummary: "- Status: awaiting_confirmation\n- Pending run: run-1 (16 rounds)",
      conversation: [],
      userInput: "yes offline",
      tools: ASSISTANT_TOOLS,
    });

    expect(decision.kind).toBe("tool_call");
    if (decision.kind === "tool_call") {
      expect(decision.tool).toBe("run_simulation");
      expect(decision.arguments.offline).toBe(true);
    }
  });

  it("passes docsPath from brief when LLM detects design intent", async () => {
    const llm = new MockLLMClient();
    const userInput = [
      "Title:",
      "MiCA narrative impact on crypto markets",
      "",
      "Document context:",
      "./inputs/mica-docs",
      "",
      "Objective:",
      "Assess how MiCA framing changes public market narratives.",
    ].join("\n");

    llm.setResponse(
      `Latest user input:\n${userInput}`,
      JSON.stringify({
        kind: "tool_call",
        tool: "design_simulation",
        arguments: { brief: userInput },
      })
    );

    const decision = await planAssistantStep(llm, {
      contextSummary: "Operator identity: PublicMachina.",
      currentTaskSummary: "- Status: idle",
      conversation: [],
      userInput,
      tools: ASSISTANT_TOOLS,
    });

    expect(decision.kind).toBe("tool_call");
    if (decision.kind === "tool_call") {
      expect(decision.tool).toBe("design_simulation");
      expect(decision.arguments.docsPath).toBe("./inputs/mica-docs");
    }
  });

  it("falls back to a helpful response when LLM returns garbage", async () => {
    const llm = new MockLLMClient();
    llm.complete = async () => ({
      content: "I am confused and cannot parse this",
      model: "mock-model",
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0.01,
      durationMs: 1,
    });

    const decision = await planAssistantStep(llm, {
      contextSummary: "Operator identity: PublicMachina.",
      currentTaskSummary: "- Status: idle",
      conversation: [],
      userInput: "asdfqwer random garbage",
      tools: ASSISTANT_TOOLS,
    });

    // Should fall back to a helpful response, not crash
    expect(decision.kind).toBe("respond");
    if (decision.kind === "respond") {
      expect(decision.message).toBeTruthy();
    }
  });
});
