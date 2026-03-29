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
    expect(result.spec.sourceUrls).toEqual([]);
    expect(result.spec.actorCount).toBeNull();
    expect(result.spec.rounds).toBe(12);
    expect(result.spec.search.enabled).toBe(true);
    expect(result.spec.search.allowProfessions).toEqual(["analyst", "journalist"]);
    expect(result.spec.feed.embeddingEnabled).toBe(true);
    expect(result.preview).toContain("Simulation Plan");
    expect(result.preview).toContain("Actor count: not constrained");
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

  it("interprets a structured Spanish brief via LLM", async () => {
    const llm = new MockLLMClient();
    // Mock: LLM correctly extracts fields from the Spanish brief
    llm.setResponse("Interpret the following simulation brief", JSON.stringify({
      title: "Impacto narrativo de la noticia de NemoClaw de NVIDIA en Bitcoin",
      objective: "Evaluar si la noticia puede mover el sentimiento de mercado y el precio de Bitcoin.",
      hypothesis: "NemoClaw moves crypto sentiment temporarily.",
      sourceUrls: ["https://es.wired.com/articulos/nvidia-lanzara-una-plataforma-de-agentes-de-ia-de-codigo-abierto"],
      actorCount: 10,
      rounds: 16,
      focusActors: ["periodistas de mercados", "traders cripto spot", "traders macro"],
      search: {
        enabled: true,
        enabledTiers: ["A", "B"],
        maxActorsPerRound: 4,
        allowProfessions: ["periodistas de mercados", "periodistas de tecnología", "traders cripto", "traders macro"],
      },
      feed: { embeddingEnabled: false },
    }));
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
    expect(result.spec.sourceUrls).toEqual([
      "https://es.wired.com/articulos/nvidia-lanzara-una-plataforma-de-agentes-de-ia-de-codigo-abierto",
    ]);
    expect(result.spec.actorCount).toBe(10);
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

  it("interprets a structured English brief via LLM", async () => {
    const llm = new MockLLMClient();
    // Mock: LLM correctly extracts fields from the English brief
    llm.setResponse("Interpret the following simulation brief", JSON.stringify({
      title: "Narrative impact of NVIDIA NemoClaw coverage on Bitcoin",
      objective: "Assess whether the reported NemoClaw launch can materially change Bitcoin sentiment.",
      hypothesis: "NemoClaw generates temporary sentiment shift.",
      sourceUrls: ["https://example.com/nemoclaw"],
      actorCount: 8,
      rounds: 12,
      focusActors: ["macro traders", "crypto traders", "markets journalists"],
      search: {
        enabled: true,
        enabledTiers: ["A", "B"],
        maxActorsPerRound: 4,
        allowProfessions: ["technology journalists", "markets journalists", "macro traders", "crypto traders"],
      },
      feed: { embeddingEnabled: false },
    }));
    const result = await designSimulationFromBrief(
      llm,
      [
        "Design a new simulation from scratch and replace any previous design.",
        "",
        "Title:",
        "Narrative impact of NVIDIA NemoClaw coverage on Bitcoin",
        "",
        "Objective:",
        "Assess whether the reported NemoClaw launch can materially change Bitcoin sentiment or remains narrative noise.",
        "",
        "Primary source:",
        "https://example.com/nemoclaw",
        "",
        "Focal date:",
        "2026-03-16",
        "",
        "Key actors:",
        "- macro traders",
        "- crypto traders",
        "- markets journalists",
        "",
        "Configuration:",
        "- 8 actors",
        "- 12 rounds",
        "- web search enabled",
        "- allow search for technology journalists, markets journalists, macro traders, and crypto traders",
        "- up to 4 actors per round with search",
      ].join("\n")
    );

    expect(result.spec.title).toContain("NemoClaw");
    expect(result.spec.sourceUrls).toEqual(["https://example.com/nemoclaw"]);
    expect(result.spec.actorCount).toBe(8);
    expect(result.spec.rounds).toBe(12);
    expect(result.spec.search.allowProfessions).toEqual([
      "crypto traders",
      "macro traders",
      "markets journalists",
      "technology journalists",
    ]);
  });

  it("interprets a rich structured brief with tiers, search, and constraints via LLM", async () => {
    const llm = new MockLLMClient();
    // Mock: LLM correctly extracts all rich fields from the complex brief
    llm.setResponse("Interpret the following simulation brief", JSON.stringify({
      title: "Impacto de Claude Mythos en empresas de ciberseguridad",
      objective: "Entender cómo reaccionan mercado, vendors, CISOs, investigadores y medios.",
      hypothesis: "Es bullish para cyber pero produce rotación entre ganadores y perdedores.",
      sourceUrls: [
        "https://www.anthropic.com/customers/palo-alto-networks",
        "https://www.anthropic.com/customers/trellix",
        "https://www.anthropic.com/news/disrupting-AI-espionage",
      ],
      actorCount: 20,
      rounds: 6,
      focusActors: ["Anthropic", "Palo Alto Networks", "Trellix", "Stairwell", "CrowdStrike"],
      search: {
        enabled: true,
        enabledTiers: ["A", "B"],
        maxActorsPerRound: 6,
        maxQueriesPerActor: 2,
        categories: "news",
        defaultLanguage: "en",
        allowProfessions: ["cybersecurity analyst", "enterprise software analyst", "security journalist", "threat researcher"],
      },
      feed: { embeddingEnabled: false },
      assumptions: ["Restrictions: no quiero actores inventados sin anclaje claro"],
    }));
    const result = await designSimulationFromBrief(
      llm,
      [
        "Tema:",
        "Impacto de Claude Mythos en empresas de ciberseguridad",
        "",
        "Objetivo:",
        "Entender cómo reaccionan mercado, vendors, CISOs, investigadores y medios ante un nuevo Claude mucho más fuerte para tareas de ciberseguridad.",
        "",
        "Detonante:",
        "Lanzamiento o leak altamente creíble de Claude Mythos con mejoras materiales en agentic coding, vulnerability discovery y SOC automation.",
        "",
        "Pregunta central:",
        "¿Es bullish para cyber, bearish para algunos subsegmentos o produce una rotación entre ganadores y perdedores?",
        "",
        "Alcance geográfico:",
        "Principalmente EE. UU., con eco global.",
        "",
        "Horizonte temporal:",
        "Quiero observar reacción de corto plazo durante 48-72 horas. Diseña 6 rondas.",
        "",
        "Actores clave:",
        "- Anthropic",
        "- Palo Alto Networks",
        "- Trellix",
        "- Stairwell",
        "- CrowdStrike",
        "",
        "Tier A:",
        "- Anthropic como actor institucional / vocero corporativo",
        "- Palo Alto Networks",
        "- CrowdStrike",
        "- periodistas top de seguridad / enterprise AI",
        "",
        "Tier B:",
        "- threat researchers",
        "- incident responders",
        "- vulnerability researchers",
        "- enterprise software analysts",
        "",
        "Búsqueda en internet:",
        "Quiero un run grounded con búsqueda web habilitada.",
        "Permite búsqueda a actores Tier A y Tier B.",
        "Idioma de búsqueda: en",
        "Categoría: news",
        "Máximo 6 actores con búsqueda por ronda",
        "Máximo 2 queries por actor",
        "Permite búsqueda especialmente a estos perfiles:",
        "- cybersecurity analyst",
        "- threat researcher",
        "- security journalist",
        "- enterprise software analyst",
        "",
        "Fuentes o links:",
        "https://www.anthropic.com/news/disrupting-AI-espionage",
        "https://www.anthropic.com/customers/palo-alto-networks",
        "https://www.anthropic.com/customers/trellix",
        "",
        "Salida deseada:",
        "- preview detallado antes de correr",
        "- actores propuestos",
        "- comunidades",
        "",
        "Restricciones:",
        "- no quiero actores inventados sin anclaje claro",
        "- si Claude Mythos no está confirmado, dilo explícitamente como supuesto de escenario",
      ].join("\n")
    );

    expect(result.spec.title).toContain("Claude Mythos");
    expect(result.spec.objective).toContain("mercado");
    expect(result.spec.hypothesis).toContain("bullish");
    expect(result.spec.sourceUrls).toEqual([
      "https://www.anthropic.com/customers/palo-alto-networks",
      "https://www.anthropic.com/customers/trellix",
      "https://www.anthropic.com/news/disrupting-AI-espionage",
    ]);
    expect(result.spec.rounds).toBe(6);
    expect(result.spec.search.enabled).toBe(true);
    expect(result.spec.search.enabledTiers).toEqual(["A", "B"]);
    expect(result.spec.search.maxActorsPerRound).toBe(6);
    expect(result.spec.search.maxQueriesPerActor).toBe(2);
    expect(result.spec.search.categories).toBe("news");
    expect(result.spec.search.defaultLanguage).toBe("en");
    expect(result.spec.search.allowProfessions).toEqual([
      "cybersecurity analyst",
      "enterprise software analyst",
      "security journalist",
      "threat researcher",
    ]);
    expect(result.spec.focusActors).toContain("Anthropic");
    expect(result.spec.focusActors).toContain("Palo Alto Networks");
    expect(result.spec.assumptions.join("\n")).toContain("Restrictions:");
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
      sourceUrls: [],
      actorCount: null,
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
    expect(validation.warnings[0]?.message).toContain("materialize them from the brief");
  });
});
