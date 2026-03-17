import { describe, expect, it } from "vitest";
import { MockLLMClient } from "../src/llm.js";
import { ASSISTANT_TOOLS } from "../src/assistant-tools.js";
import { planAssistantStep } from "../src/assistant-planner.js";

describe("assistant-planner.ts", () => {
  it("parses a tool call plan from JSON", async () => {
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
      expect(decision.arguments.docsPath).toBe("./docs/elections");
      expect(decision.arguments.brief).toBe("Design and run an election rumor simulation.");
    }
  });

  it("preserves the user's exact brief when the model tries to rewrite design input", async () => {
    const llm = new MockLLMClient();
    llm.setResponse(
      "Latest user input:\nTitle:\nNemoClaw and Bitcoin",
      JSON.stringify({
        kind: "tool_call",
        tool: "design_simulation",
        arguments: {
          brief: "Create a BTC and AI simulation with multiple actors.",
          docsPath: "./hallucinated-docs",
        },
      })
    );

    const userInput = [
      "Design a new simulation from scratch.",
      "",
      "Title:",
      "Narrative impact of the NVIDIA NemoClaw WIRED report on Bitcoin",
      "",
      "Primary source:",
      "https://es.wired.com/articulos/nvidia-lanzara-una-plataforma-de-agentes-de-ia-de-codigo-abierto",
    ].join("\n");

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
      expect(decision.arguments.brief).toBe(userInput);
      expect(decision.arguments.docsPath).toBeUndefined();
    }
  });

  it("parses a direct response plan from JSON", async () => {
    const llm = new MockLLMClient();
    llm.setResponse(
      "Latest user input:\nWhat can you do here?",
      JSON.stringify({
        kind: "respond",
        message: "I can design, run, inspect, report on, and compare simulations for you.",
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

  it("retries once when the first planner JSON response is invalid", async () => {
    const llm = new MockLLMClient();
    let calls = 0;
    llm.complete = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          content: '{"kind":"tool_call","tool":"design_simulation","arguments":{"brief":"Rediseña',
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
          arguments: { brief: "Rediseña la simulación con el nuevo contexto." },
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
      userInput: "Rediseñala con ese contexto",
      tools: ASSISTANT_TOOLS,
    });

    expect(calls).toBe(2);
    expect(decision.kind).toBe("tool_call");
    if (decision.kind === "tool_call") {
      expect(decision.tool).toBe("design_simulation");
      expect(decision.meta.costUsd).toBe(3);
    }
  });

  it("extracts JSON when the model wraps it in prose", async () => {
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

  it("routes a structured Spanish brief to design_simulation without relying on the model", async () => {
    const llm = new MockLLMClient();

    const decision = await planAssistantStep(llm, {
      contextSummary: "Operator identity: PublicMachina.",
      currentTaskSummary: "- Status: designed\n- Active design: Global Product Recall Response",
      conversation: [],
      userInput: [
        "Diseña una simulación nueva desde cero y reemplaza cualquier simulación anterior.",
        "",
        "Título:",
        "Impacto narrativo de la noticia de NemoClaw de NVIDIA en Bitcoin",
        "",
        "Fuente principal:",
        "https://es.wired.com/articulos/nvidia-lanzara-una-plataforma-de-agentes-de-ia-de-codigo-abierto",
        "",
        "Contexto documental:",
        "./inputs/nemoclaw-btc",
        "",
        "Objetivo:",
        "Evaluar si la noticia puede mover de forma material el precio de Bitcoin.",
      ].join("\n"),
      tools: ASSISTANT_TOOLS,
    });

    expect(decision.kind).toBe("tool_call");
    if (decision.kind === "tool_call") {
      expect(decision.tool).toBe("design_simulation");
      expect(decision.arguments.docsPath).toBe("./inputs/nemoclaw-btc");
      expect(decision.meta.model).toBe("heuristic");
    }
  });

  it("routes a structured English brief to design_simulation without relying on the model", async () => {
    const llm = new MockLLMClient();

    const decision = await planAssistantStep(llm, {
      contextSummary: "Operator identity: PublicMachina.",
      currentTaskSummary: "- Status: idle",
      conversation: [],
      userInput: [
        "Design a new simulation from scratch and replace any previous design.",
        "",
        "Title:",
        "NVIDIA NemoClaw and Bitcoin",
        "",
        "Primary source:",
        "https://example.com/nemoclaw",
        "",
        "Document context:",
        "./inputs/nemoclaw-btc",
        "",
        "Objective:",
        "Assess whether the story can materially change Bitcoin sentiment.",
      ].join("\n"),
      tools: ASSISTANT_TOOLS,
    });

    expect(decision.kind).toBe("tool_call");
    if (decision.kind === "tool_call") {
      expect(decision.tool).toBe("design_simulation");
      expect(decision.arguments.docsPath).toBe("./inputs/nemoclaw-btc");
      expect(decision.meta.model).toBe("heuristic");
    }
  });

  it("treats labeled briefs as design requests even without an explicit design verb", async () => {
    const llm = new MockLLMClient();

    const decision = await planAssistantStep(llm, {
      contextSummary: "Operator identity: PublicMachina.",
      currentTaskSummary: "- Status: idle",
      conversation: [],
      userInput: [
        "Title:",
        "MiCA narrative impact on crypto markets",
        "",
        "Objective:",
        "Assess how MiCA framing changes public market narratives.",
        "",
        "Primary source:",
        "https://example.com/mica",
      ].join("\n"),
      tools: ASSISTANT_TOOLS,
    });

    expect(decision.kind).toBe("tool_call");
    if (decision.kind === "tool_call") {
      expect(decision.tool).toBe("design_simulation");
      expect(decision.meta.model).toBe("heuristic");
    }
  });

  it("treats refine-style structured requests as design updates without relying on the model", async () => {
    const llm = new MockLLMClient();

    const decision = await planAssistantStep(llm, {
      contextSummary: "Operator identity: PublicMachina.",
      currentTaskSummary: "- Status: designed\n- Active design: BTC and AI",
      conversation: [],
      userInput: [
        "Refine this simulation.",
        "",
        "Configuration:",
        "- 10 actors",
        "- 16 rounds",
        "- web search enabled",
        "",
        "Primary source:",
        "https://example.com/nemoclaw",
      ].join("\n"),
      tools: ASSISTANT_TOOLS,
    });

    expect(decision.kind).toBe("tool_call");
    if (decision.kind === "tool_call") {
      expect(decision.tool).toBe("design_simulation");
      expect(decision.meta.model).toBe("heuristic");
    }
  });
});
