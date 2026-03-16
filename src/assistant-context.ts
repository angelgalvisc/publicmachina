/**
 * assistant-context.ts — Context assembly for the PublicMachina operator assistant
 */

import type { SimConfig } from "./config.js";
import {
  listSimulationHistory,
  loadDurableMemories,
  loadUserProfile,
  readRecentDailyNotes,
  readWorkspaceReferenceText,
  type AssistantSimulationRecord,
  type AssistantWorkspaceLayout,
} from "./assistant-workspace.js";
import { readRecentAssistantMessages } from "./assistant-session.js";

export interface AssistantContextBundle {
  summary: string;
  relevantSimulations: AssistantSimulationRecord[];
}

export function buildAssistantContext(
  layout: AssistantWorkspaceLayout,
  config: SimConfig,
  query: string
): AssistantContextBundle {
  const profile = loadUserProfile(layout);
  const durableMemories = loadDurableMemories(layout);
  const references = readWorkspaceReferenceText(layout);
  const recentNotes = readRecentDailyNotes(layout, config.assistant.memory.recentDailyNotes);
  const recentMessages = config.assistant.permissions.rememberConversations
    ? readRecentAssistantMessages(layout, config.assistant.memory.recentSessionMessages)
    : [];
  const relevantSimulations = config.assistant.permissions.rememberSimulationHistory
    ? listSimulationHistory(layout, {
        query,
        limit: config.assistant.memory.relevantSimulationLimit,
      })
    : [];

  const sections = [
    "Operator identity:",
    truncate(references.identity, 1200),
    "",
    "Operating style:",
    truncate(references.soul, 900),
    "",
    "Known user profile:",
    `- Preferred name: ${profile.preferredName ?? "unknown"}`,
    `- Last context: ${profile.lastContext ?? "none recorded"}`,
    ...(profile.notes.length > 0 ? profile.notes.map((note) => `- Note: ${note}`) : ["- Note: none"]),
    "",
    "Durable memory:",
    ...(durableMemories.length > 0
      ? durableMemories.slice(-8).map((memory) => `- ${memory.kind}: ${memory.summary}`)
      : ["- none"]),
  ];

  if (recentNotes.length > 0) {
    sections.push("", "Recent daily notes:");
    for (const note of recentNotes) {
      sections.push(`- ${basename(note.path)}: ${summarizeMarkdown(note.content)}`);
    }
  }

  if (recentMessages.length > 0) {
    sections.push("", "Recent conversation turns:");
    for (const message of recentMessages) {
      sections.push(`- ${message.role}: ${truncate(message.content, 220)}`);
    }
  }

  if (relevantSimulations.length > 0) {
    sections.push("", "Relevant previous simulations:");
    for (const record of relevantSimulations) {
      sections.push(
        `- ${record.title} (${record.createdAt}): ${truncate(
          `${record.objective ?? ""} ${record.hypothesis ?? ""} ${record.brief}`,
          260
        )}`
      );
    }
  }

  return {
    summary: `${sections.join("\n")}\n`,
    relevantSimulations,
  };
}

function summarizeMarkdown(input: string): string {
  const normalized = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#") && !line.startsWith("<!--"))
    .join(" ");
  return truncate(normalized, 220);
}

function truncate(input: string, maxLength: number): string {
  const trimmed = input.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1)}…`;
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1];
}
