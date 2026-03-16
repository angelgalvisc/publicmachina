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

  it("uses a structured Spanish operator brief as authoritative input", async () => {
    const llm = makeDesignLlm();
    const result = await designSimulationFromBrief(
      llm,
      [
        "Diseña una simulación nueva desde cero y reemplaza cualquier simulación anterior.",
        "",
        "Título:",
        "Impacto narrativo de la noticia de NemoClaw de NVIDIA en Bitcoin",
        "",
        "Objetivo:",
        "Evaluar si la noticia reportada por WIRED sobre NemoClaw puede mover de forma material el sentimiento de mercado y el precio de Bitcoin el 16 de marzo de 2026, o si su efecto es principalmente ruido narrativo.",
        "",
        "Fuente principal:",
        "https://es.wired.com/articulos/nvidia-lanzara-una-plataforma-de-agentes-de-ia-de-codigo-abierto",
        "",
        "Fecha focal:",
        "2026-03-16",
        "",
        "Evento inicial:",
        "El mercado empieza a procesar la noticia de WIRED sobre el posible lanzamiento de NemoClaw de NVIDIA alrededor de GTC 2026.",
        "",
        "Actores clave:",
        "- traders macro",
        "- traders cripto spot",
        "- periodistas de mercados",
        "",
        "Configuración:",
        "- 10 agentes",
        "- 16 rondas",
        "- búsqueda web habilitada",
        "- permitir búsqueda a periodistas de tecnología, periodistas de mercados, traders macro y traders cripto",
        "- máximo 4 actores por ronda con búsqueda",
      ].join("\n")
    );

    expect(result.spec.title).toContain("NemoClaw");
    expect(result.spec.objective).toContain("Bitcoin");
    expect(result.spec.rounds).toBe(16);
    expect(result.spec.search.enabled).toBe(true);
    expect(result.spec.search.enabledTiers).toEqual(["A", "B"]);
    expect(result.spec.search.maxActorsPerRound).toBe(4);
    expect(result.spec.search.allowProfessions).toEqual([
      "periodistas de mercados",
      "periodistas de tecnología",
      "traders cripto",
      "traders macro",
    ]);
    expect(result.spec.focusActors).toEqual([
      "periodistas de mercados",
      "traders cripto spot",
      "traders macro",
    ]);

    const parsed = parseConfig(renderSimulationConfigYaml(result.spec, defaultConfig()));
    expect(parsed.search.enabled).toBe(true);
    expect(parsed.search.enabledTiers).toEqual(["A", "B"]);
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
