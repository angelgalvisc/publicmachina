/**
 * ckp.ts — CKP (ClawKernel Protocol) export/import module
 *
 * Export and import agent bundles in the CKP format.
 * Bundles include agent cards, beliefs, topics, memories, provenance, and persona.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import {
  projectAgentCard,
  type CkpAgentProjectionInput,
} from "@clawkernel/sdk";
import type { GraphStore } from "./store.js";
import type { ActorMemoryRow, ActorRow } from "./types.js";
import { uuid } from "./ids.js";

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

export interface ExportResult {
  actorId: string;
  outDir: string;
  files: string[];
  memoriesExported: number;
}

export interface ImportResult {
  actorId: string; // new UUID
  name: string;
  topicsImported: number;
  beliefsImported: number;
  memoriesImported: number;
}

// ═══════════════════════════════════════════════════════
// scrubSecrets — recursive secret redaction
// ═══════════════════════════════════════════════════════

const SECRET_KEY_RE = /api.?key|token|secret|bearer|password|auth|credential/i;
const SECRET_VALUE_RE = /^sk-|^Bearer |^ghp_|^xoxb-/;
const SECRET_TEXT_RE = /\b(sk-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+|ghp_[A-Za-z0-9]+|xoxb-[A-Za-z0-9-]+)\b/g;

/**
 * Deep-clone the input and redact any secret keys or values.
 * Never mutates the original object.
 */
export function scrubSecrets<T>(obj: T): T {
  const clone = structuredClone(obj);
  walk(clone);
  return clone;
}

export function scrubSecretsInText(text: string): string {
  return text.replace(SECRET_TEXT_RE, "[REDACTED]");
}

function walk(node: unknown): void {
  if (node === null || node === undefined) return;
  if (typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      if (typeof node[i] === "string" && SECRET_VALUE_RE.test(node[i])) {
        node[i] = "[REDACTED]";
      } else if (typeof node[i] === "string") {
        node[i] = scrubSecretsInText(node[i]);
      } else {
        walk(node[i]);
      }
    }
    return;
  }

  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value = record[key];

    // Redact by key name
    if (SECRET_KEY_RE.test(key) && typeof value === "string") {
      record[key] = "[REDACTED]";
      continue;
    }

    // Redact string values matching known secret prefixes
    if (typeof value === "string" && SECRET_VALUE_RE.test(value)) {
      record[key] = "[REDACTED]";
      continue;
    }

    if (typeof value === "string") {
      record[key] = scrubSecretsInText(value);
      continue;
    }

    // Recurse into nested objects/arrays
    if (typeof value === "object" && value !== null) {
      walk(value);
    }
  }
}

// ═══════════════════════════════════════════════════════
// exportAgent — write CKP bundle to disk
// ═══════════════════════════════════════════════════════

export function exportAgent(
  store: GraphStore,
  runId: string,
  actorId: string,
  outDir: string,
): ExportResult {
  // 1. Get actor
  const actor = store.getActor(actorId);
  if (!actor) {
    throw new Error("Actor not found: " + actorId);
  }

  // 2. Get context (beliefs, topics, recent posts)
  const context = store.queryActorContext(actorId, runId);
  const memories = store.listActorMemories(actorId, runId);

  // 3. Get provenance if entity_id exists
  let provenance: unknown;
  if (actor.entity_id) {
    provenance = store.queryProvenance(actor.entity_id);
  } else {
    provenance = { entity: null, claims: [], chunks: [], documents: [] };
  }

  // 4. Build CKP agent card
  const input: CkpAgentProjectionInput = {
    name: actor.name,
    version: "0.1.0",
    personality: actor.personality,
  };
  const agentCard = projectAgentCard(input);

  // 5. Create output directory
  mkdirSync(outDir, { recursive: true });

  // 6. Build file contents
  const clawYaml = YAML.stringify(scrubSecrets({
    apiVersion: "ckp/v1alpha1",
    kind: "AgentCard",
    ...agentCard,
  }));

  const actorState = {
    stance: actor.stance,
    sentiment_bias: actor.sentiment_bias,
    influence_weight: actor.influence_weight,
    activity_level: actor.activity_level,
    follower_count: actor.follower_count,
    following_count: actor.following_count,
  };

  const beliefs = context.beliefs;
  const topics = context.topics;

  const manifest = {
    run_id: runId,
    actor_id: actorId,
    round: null,
    version: "0.1.0",
    exported_at: new Date().toISOString(),
    memories_exported: memories.length,
  };

  // 7. Write files (scrub secrets from all JSON)
  const files = [
    "claw.yaml",
    "actor_state.json",
    "beliefs.json",
    "topics.json",
    "memories.json",
    "provenance.json",
    "persona.md",
    "manifest.meta.json",
  ];

  writeFileSync(join(outDir, "claw.yaml"), clawYaml, "utf-8");
  writeFileSync(
    join(outDir, "actor_state.json"),
    JSON.stringify(scrubSecrets(actorState), null, 2),
    "utf-8",
  );
  writeFileSync(
    join(outDir, "beliefs.json"),
    JSON.stringify(scrubSecrets(beliefs), null, 2),
    "utf-8",
  );
  writeFileSync(
    join(outDir, "topics.json"),
    JSON.stringify(scrubSecrets(topics), null, 2),
    "utf-8",
  );
  writeFileSync(
    join(outDir, "memories.json"),
    JSON.stringify(scrubSecrets(memories.map(toPortableMemory)), null, 2),
    "utf-8",
  );
  writeFileSync(
    join(outDir, "provenance.json"),
    JSON.stringify(scrubSecrets(provenance), null, 2),
    "utf-8",
  );
  writeFileSync(
    join(outDir, "persona.md"),
    scrubSecretsInText(actor.personality),
    "utf-8",
  );
  writeFileSync(
    join(outDir, "manifest.meta.json"),
    JSON.stringify(scrubSecrets(manifest), null, 2),
    "utf-8",
  );

  return { actorId, outDir, files, memoriesExported: memories.length };
}

// ═══════════════════════════════════════════════════════
// importAgent — read CKP bundle from disk into store
// ═══════════════════════════════════════════════════════

const REQUIRED_FILES = [
  "claw.yaml",
  "actor_state.json",
  "beliefs.json",
  "topics.json",
];

export function importAgent(
  store: GraphStore,
  runId: string,
  bundleDir: string,
): ImportResult {
  // 1. Validate required files exist
  for (const filename of REQUIRED_FILES) {
    if (!existsSync(join(bundleDir, filename))) {
      throw new Error("Missing required file: " + filename);
    }
  }

  // 2. Read and parse
  const agentCard = YAML.parse(
    readFileSync(join(bundleDir, "claw.yaml"), "utf-8"),
  );
  const actorState = JSON.parse(
    readFileSync(join(bundleDir, "actor_state.json"), "utf-8"),
  );
  const beliefs = JSON.parse(
    readFileSync(join(bundleDir, "beliefs.json"), "utf-8"),
  ) as Array<{ topic: string; sentiment: number }>;
  const topics = JSON.parse(
    readFileSync(join(bundleDir, "topics.json"), "utf-8"),
  ) as Array<{ topic: string; weight: number }>;
  const memoriesPath = join(bundleDir, "memories.json");
  const memories = existsSync(memoriesPath)
    ? (JSON.parse(readFileSync(memoriesPath, "utf-8")) as PortableActorMemory[])
    : [];

  // Read persona.md if it exists
  const personaMdPath = join(bundleDir, "persona.md");
  const personaMd = existsSync(personaMdPath)
    ? readFileSync(personaMdPath, "utf-8")
    : "";

  // 3. Generate new UUID
  const newId = uuid();

  // 4. Build ActorRow
  const actor: ActorRow = {
    id: newId,
    run_id: runId,
    entity_id: null,
    archetype: agentCard.name?.includes("media") ? "media" : "persona",
    cognition_tier: "B",
    name: agentCard.name ?? "Imported Actor",
    handle: null,
    personality: personaMd ?? "",
    bio: agentCard.description ?? null,
    age: null,
    gender: null,
    profession: null,
    region: null,
    language: "en",
    stance: actorState.stance ?? "neutral",
    sentiment_bias: actorState.sentiment_bias ?? 0,
    activity_level: actorState.activity_level ?? 0.5,
    influence_weight: actorState.influence_weight ?? 0.1,
    community_id: null,
    active_hours: null,
    follower_count: actorState.follower_count ?? 0,
    following_count: actorState.following_count ?? 0,
  };

  // 5. Persist actor
  store.addActor(actor);

  // 6. Import beliefs
  for (const belief of beliefs) {
    store.addActorBelief(newId, belief.topic, belief.sentiment);
  }

  // 7. Import topics
  for (const topic of topics) {
    store.addActorTopic(newId, topic.topic, topic.weight);
  }

  // 8. Import memories when present. Source references are nulled because the
  // destination run does not include the original posts/actors by default.
  for (const memory of memories) {
    store.addActorMemory({
      id: uuid(),
      run_id: runId,
      actor_id: newId,
      round_num: Number.isFinite(memory.round_num) ? memory.round_num : 0,
      kind: isPortableMemoryKind(memory.kind) ? memory.kind : "reflection",
      summary: String(memory.summary ?? "").trim() || "Imported actor memory",
      salience: typeof memory.salience === "number" ? memory.salience : 0.5,
      topic: memory.topic ?? null,
      source_post_id: null,
      source_actor_id: null,
    });
  }

  // 9. Return result
  return {
    actorId: newId,
    name: actor.name,
    topicsImported: topics.length,
    beliefsImported: beliefs.length,
    memoriesImported: memories.length,
  };
}

type PortableActorMemory = {
  kind: string;
  round_num: number;
  summary: string;
  salience: number;
  topic?: string | null;
  source_post_id?: string | null;
  source_actor_id?: string | null;
  created_at?: string;
};

function toPortableMemory(memory: ActorMemoryRow): PortableActorMemory {
  return {
    kind: memory.kind,
    round_num: memory.round_num,
    summary: memory.summary,
    salience: memory.salience,
    topic: memory.topic ?? null,
    source_post_id: memory.source_post_id ?? null,
    source_actor_id: memory.source_actor_id ?? null,
    created_at: memory.created_at,
  };
}

function isPortableMemoryKind(
  kind: string
): kind is ActorMemoryRow["kind"] {
  return (
    kind === "reflection" ||
    kind === "interaction" ||
    kind === "narrative" ||
    kind === "event"
  );
}
