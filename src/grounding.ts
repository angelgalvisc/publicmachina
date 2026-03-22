import type { SimConfig } from "./config.js";
import { checkSearchHealth, createSearchProvider } from "./search.js";

export interface GroundingPreparationOptions {
  offline?: boolean;
}

export async function prepareGroundedRun(
  config: SimConfig,
  options: GroundingPreparationOptions = {}
): Promise<SimConfig> {
  const next = structuredClone(config);
  if (options.offline) {
    next.search.enabled = false;
    return next;
  }
  if (!next.search.enabled) {
    throw new Error(
      "Grounded runs require search.enabled=true. Reconfigure search or pass --offline explicitly."
    );
  }
  const provider = createSearchProvider(next.search);
  await checkSearchHealth(provider, next.search);
  return next;
}

export function prefersOfflineMode(input: string): boolean {
  return /\b(--offline|offline|sin internet|sin web|sin b[uú]squeda|sin busqueda|without internet|without web search|without search)\b/i.test(
    input
  );
}
