import { describe, expect, it } from "vitest";
import { MockLLMClient } from "../src/llm.js";
import {
  designSimulationFromBrief,
  renderSimulationConfig,
  renderSimulationConfigYaml,
  validateSimulationSpec,
} from "../src/design.js";
import { parseConfig, defaultConfig } from "../src/config.js";

function makeDesignLlm(): MockLLMClient {
  const llm = new MockLLMClient();
  llm.setResponse(
    "Interpret the following simulation brief",
    JSON.stringify({
      title: "Global Cloud Outage Pressure Test",
      objective:
        "Simulate how narratives evolve after a multi-region cloud outage affecting developers, enterprise buyers, regulators, and the platform operator.",
      hypothesis:
        "Technical experts stabilize the narrative slower than financial commentators amplify it.",
      rounds: 12,
      focusActors: ["developers", "enterprise buyers", "financial analysts", "regulators"],
      search: {
        enabled: true,
        enabledTiers: ["A", "B"],
        maxActorsPerRound: 5,
        maxActorsByTier: { A: 3, B: 2 },
        allowArchetypes: ["institution"],
        allowProfessions: ["journalist", "analyst"],
        cutoffDate: "2026-03-01",
        categories: "news",
        defaultLanguage: "auto",
        maxResultsPerQuery: 6,
        maxQueriesPerActor: 2,
        strictCutoff: true,
        timeoutMs: 2500,
      },
      feed: {
        embeddingEnabled: true,
        embeddingWeight: 0.4,
      },
      assumptions: ["Assumed an X-style public conversation layer."],
      warnings: [],
    })
  );
  return llm;
}

describe("designSimulationFromBrief", () => {
  it("converts a natural-language brief into a validated simulation plan", async () => {
    const llm = makeDesignLlm();
    const result = await designSimulationFromBrief(
      llm,
      [
        "Create a 12-round simulation about a global cloud outage.",
        "Only journalists, analysts, and institutions may search the web.",
        "Allow up to 5 search-enabled actors per round, 3 Tier A and 2 Tier B.",
        "Enable embedding-aware feed ranking.",
      ].join(" "),
      {
        docsPath: "./docs/global-cloud-outage",
      }
    );

    expect(result.validation.errors).toHaveLength(0);
    expect(result.spec.docsPath).toBe("./docs/global-cloud-outage");
    expect(result.spec.rounds).toBe(12);
    expect(result.spec.search.enabled).toBe(true);
    expect(result.spec.search.allowProfessions).toEqual(["analyst", "journalist"]);
    expect(result.spec.feed.embeddingEnabled).toBe(true);
    expect(result.preview).toContain("Simulation Plan");
    expect(result.preview).toContain("Search policy: tiers A, B, up to 5 actors/round (A:3, B:2)");
  });

  it("renders deterministic config and valid YAML", async () => {
    const llm = makeDesignLlm();
    const result = await designSimulationFromBrief(llm, "Design a global outage simulation.");

    const config = renderSimulationConfig(result.spec, defaultConfig());
    const parsed = parseConfig(renderSimulationConfigYaml(result.spec, defaultConfig()));

    expect(config.simulation.totalHours).toBe(12);
    expect(config.search.maxActorsPerRound).toBe(5);
    expect(config.feed.embeddingEnabled).toBe(true);
    expect(parsed.search.maxActorsByTier.A).toBe(3);
    expect(parsed.feed.embeddingWeight).toBe(0.4);
  });
});

describe("validateSimulationSpec", () => {
  it("warns when documents path is missing", () => {
    const config = defaultConfig();
    const validation = validateSimulationSpec({
      title: "Global Supply Chain Shock",
      objective: "Observe how a supply chain narrative propagates.",
      hypothesis: null,
      docsPath: null,
      rounds: 8,
      focusActors: ["suppliers", "investors"],
      search: {
        enabled: false,
        enabledTiers: [],
        maxActorsPerRound: 0,
        maxActorsByTier: { A: 0, B: 0 },
        allowArchetypes: [],
        denyArchetypes: [],
        allowProfessions: [],
        denyProfessions: [],
        allowActors: [],
        denyActors: [],
        cutoffDate: null,
        categories: config.search.categories,
        defaultLanguage: config.search.defaultLanguage,
        maxResultsPerQuery: config.search.maxResultsPerQuery,
        maxQueriesPerActor: config.search.maxQueriesPerActor,
        strictCutoff: config.search.strictCutoff,
        timeoutMs: config.search.timeoutMs,
      },
      feed: {
        embeddingEnabled: false,
        embeddingWeight: config.feed.embeddingWeight,
      },
      assumptions: [],
      warnings: [],
    });

    expect(validation.errors).toHaveLength(0);
    expect(validation.warnings.some((warning) => warning.field === "docsPath")).toBe(true);
  });
});
