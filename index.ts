/**
 * @lokeraar/pi-enclave-bridge — EnClave provider for Pi.
 *
 * The values live in `models.json` under `providers.EnClave`. This file only
 * registers the provider and keeps its model list in step with the endpoint.
 *
 * Two scripts own the data:
 *
 *   scripts/sync-models.mjs  rebuilds the EnClave block: reads the live
 *                            catalog, copies values from the `opendesign`
 *                            donor by bare model name, keeps the endpoint's own
 *                            context window and price, and drops models that do
 *                            not answer. Run it after changing the donor.
 *
 *   scripts/probe-models.mjs optional; measures reasoning levels and output
 *                            ceilings for models with no donor, so the "work by
 *                            hand" list has somewhere to go.
 *
 * Local install: copy `index.ts` and `enclave-live.ts` into
 * `~/.pi/agent/extensions/`, renaming `index.ts` to `enclave-bridge.ts`. Pi
 * loads every `extensions/*.ts` as a factory, so a file called `index.ts`
 * collides and registers the provider twice.
 */

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Kept in step with package.json, because a user running loose files in
 * ~/.pi/agent/extensions has no other way to tell which build they are on — and
 * a bug report without that is a report we cannot act on.
 */
export const BRIDGE_VERSION = "0.1.7";
import {
  ENCLAVE_BASE_URL,
  makeRefreshModels,
  providerModels,
  readModelsJson,
  PROVIDER_ID,
} from "./enclave-live.ts";

export default async function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const cfg = readModelsJson(agentDir).providers?.[PROVIDER_ID] ?? {};
  const baseUrl = (cfg.baseUrl as string) ?? ENCLAVE_BASE_URL;

  pi.registerProvider(PROVIDER_ID, {
    name: `${(cfg.name as string) ?? "EnClave"} ${BRIDGE_VERSION}`,
    api: (cfg.api as string) ?? "openai-completions",
    baseUrl,
    authHeader: cfg.authHeader !== false,
    models: providerModels(readModelsJson(agentDir), PROVIDER_ID),
    refreshModels: makeRefreshModels(agentDir, baseUrl),
  });
}