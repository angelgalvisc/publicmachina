/**
 * model-command.ts — Shared `/model` command handling for interactive surfaces.
 */

import type { SimConfig } from "./config.js";
import { saveConfig } from "./config.js";
import {
  PROVIDER_ROLES,
  clearRoleProviderOverride,
  hasRoleOverride,
  resolveProviderConfig,
  setGlobalProviderSelection,
  setRoleProviderSelection,
  type ProviderRole,
} from "./provider-selection.js";
import {
  SUPPORTED_PROVIDERS,
  describeConfiguredModel,
  getProviderCatalog,
  normalizeModelId,
  parseProvider,
  resolveModelPreset,
  type SupportedProvider,
} from "./model-catalog.js";

export interface ModelCommandContext {
  config?: SimConfig;
  configPath?: string;
  onConfigUpdate?: (config: SimConfig) => Promise<void>;
}

export interface ModelCommandIO {
  output(text: string): void;
  error(text: string): void;
}

export async function handleModelCommand(
  ctx: ModelCommandContext,
  io: ModelCommandIO,
  args: string
): Promise<void> {
  if (!ctx.config || !ctx.configPath || !ctx.onConfigUpdate) {
    io.error('Model switching is unavailable here. Run "publicmachina setup" first.\n');
    return;
  }
  const configuredCtx = ctx as Required<ModelCommandContext>;

  const { text: trimmed, role } = extractRoleOption(args);
  const currentResolved = resolveProviderConfig(
    configuredCtx.config.providers,
    role ?? "simulation"
  );
  const currentProvider = currentResolved.provider;
  const currentModel = currentResolved.model;

  if (!trimmed || trimmed === "list") {
    io.output(`Default provider: ${getProviderCatalog(configuredCtx.config.providers.default.provider).label}\n`);
    io.output(
      `Default model: ${describeConfiguredModel(
        configuredCtx.config.providers.default.provider,
        configuredCtx.config.providers.default.model
      )} (${configuredCtx.config.providers.default.model})\n`
    );
    if (role) {
      io.output(`Resolved ${role} provider: ${getProviderCatalog(currentProvider).label}\n`);
      io.output(
        `Resolved ${role} model: ${describeConfiguredModel(currentProvider, currentModel)} (${currentModel})\n`
      );
    }
    const overriddenRoles = PROVIDER_ROLES.filter((candidate) =>
      hasRoleOverride(configuredCtx.config.providers, candidate)
    );
    if (overriddenRoles.length > 0) {
      io.output("Role overrides:\n");
      for (const overriddenRole of overriddenRoles) {
        const resolved = resolveProviderConfig(configuredCtx.config.providers, overriddenRole);
        io.output(
          `  - ${overriddenRole}: ${getProviderCatalog(resolved.provider).label} / ${describeConfiguredModel(
            resolved.provider,
            resolved.model
          )} (${resolved.model})\n`
        );
      }
    }
    io.output("Configured provider commands:\n");
    io.output("  /model list\n");
    io.output("  /model use <model-id-or-label>\n");
    io.output("  /model provider <anthropic|openai|moonshot>\n");
    io.output("  /model use <model> --role <analysis|generation|simulation|report>\n");
    io.output("  /model provider <provider> --role <analysis|generation|simulation|report>\n");
    io.output("  /model reset --role <analysis|generation|simulation|report>\n");
    io.output("  /model setup\n");
    io.output("Available providers:\n");
    for (const provider of SUPPORTED_PROVIDERS) {
      const entry = getProviderCatalog(provider);
      io.output(`  - ${entry.label} (${provider})\n`);
    }
    io.output(`Available models for ${getProviderCatalog(currentProvider).label}:\n`);
    for (const preset of getProviderCatalog(currentProvider).models) {
      io.output(`  - ${preset.label} -> ${preset.persistedId ?? preset.id}\n`);
    }
    return;
  }

  if (trimmed === "setup") {
    io.error('Run "publicmachina setup" to configure a provider or add a new API key.\n');
    return;
  }

  if (trimmed === "reset") {
    if (!role) {
      io.error('Use "/model reset --role <role>" to clear a role-specific override.\n');
      return;
    }
    const next = structuredClone(configuredCtx.config);
    next.providers = clearRoleProviderOverride(next.providers, role);
    saveConfig(configuredCtx.configPath, next);
    ctx.config = next;
    await configuredCtx.onConfigUpdate(next);
    io.output(`Cleared provider/model override for ${role}.\n`);
    return;
  }

  if (trimmed.startsWith("provider ")) {
    const requestedProvider = parseProvider(trimmed.slice("provider ".length));
    if (!requestedProvider) {
      io.error('Unknown provider. Use "anthropic", "openai", or "moonshot".\n');
      return;
    }
    await switchProvider(configuredCtx, io, requestedProvider, role);
    return;
  }

  if (trimmed.startsWith("use ")) {
    await switchModel(configuredCtx, io, trimmed.slice("use ".length).trim(), role);
    return;
  }

  io.error('Unknown /model command. Use "/model", "/model use <id>", or "/model provider <provider>".\n');
}

export function extractRoleOption(input: string): { text: string; role?: ProviderRole } {
  const match = input.match(/(?:^|\s)--role\s+(analysis|generation|simulation|report)\b/i);
  if (!match) {
    return { text: input.trim() };
  }
  const role = match[1].toLowerCase() as ProviderRole;
  const start = match.index ?? 0;
  const end = start + match[0].length;
  return {
    text: `${input.slice(0, start)} ${input.slice(end)}`.trim(),
    role,
  };
}

async function switchProvider(
  ctx: Required<ModelCommandContext>,
  io: ModelCommandIO,
  provider: SupportedProvider,
  role?: ProviderRole
): Promise<void> {
  const entry = getProviderCatalog(provider);
  if (!process.env[entry.apiKeyEnv]) {
    io.error(
      `${entry.label} is not configured here. Missing ${entry.apiKeyEnv}. Run "publicmachina setup".\n`
    );
    return;
  }

  const recommended = normalizeModelId(provider, entry.models.find((model) => model.tier === "recommended")?.id ?? entry.models[0].id);
  const next = structuredClone(ctx.config);
  next.providers = role
    ? setRoleProviderSelection(next.providers, role, {
        provider,
        model: recommended,
        apiKeyEnv: entry.apiKeyEnv,
        ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      })
    : setGlobalProviderSelection(next.providers, provider, recommended);
  saveConfig(ctx.configPath, next);
  ctx.config = next;
  await ctx.onConfigUpdate(next);
  io.output(
    role
      ? `Switched ${role} to ${entry.label} with ${describeConfiguredModel(provider, recommended)}.\n`
      : `Switched default provider to ${entry.label} with ${describeConfiguredModel(provider, recommended)}.\n`
  );
}

async function switchModel(
  ctx: Required<ModelCommandContext>,
  io: ModelCommandIO,
  requestedModel: string,
  role?: ProviderRole
): Promise<void> {
  const current = resolveProviderConfig(ctx.config.providers, role ?? "simulation");
  const provider = current.provider;
  const preset = resolveModelPreset(provider, requestedModel);
  const normalized = normalizeModelId(provider, preset?.persistedId ?? preset?.id ?? requestedModel);
  const next = structuredClone(ctx.config);
  next.providers = role
    ? setRoleProviderSelection(next.providers, role, {
        provider,
        model: normalized,
        apiKeyEnv: current.apiKeyEnv,
        ...(current.baseUrl ? { baseUrl: current.baseUrl } : {}),
      })
    : setGlobalProviderSelection(next.providers, provider, normalized);
  saveConfig(ctx.configPath, next);
  ctx.config = next;
  await ctx.onConfigUpdate(next);
  io.output(
    role
      ? `Switched ${role} model to ${describeConfiguredModel(provider, normalized)} (${normalized}).\n`
      : `Switched default model to ${describeConfiguredModel(provider, normalized)} (${normalized}).\n`
  );
}
