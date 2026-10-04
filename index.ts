/**
 * @lokeraar/pi-enclave-bridge — EnClave provider for Pi: registration + live
 * catalog wiring.
 *
 * EnClave's router (https://router.enclave.ai/v1) speaks the OpenRouter catalog
 * dialect and, unlike most gateways, DECLARES the values a coding agent needs:
 * a real `context_length` per model, real `pricing` in USD per 1M tokens, and
 * per-key routability. So this bridge does not re-derive those by probing — it
 * trusts them and labels them `gateway`. What the endpoint says nothing about is
 * reasoning effort levels and the output ceiling, and only those get probed.
 *
 * Every published model carries a `provenance` block saying where each field
 * came from, so "is this value real?" is answerable without trusting the bridge:
 *
 *   measured          — a request was made and the answer observed
 *   gateway           — the endpoint's own claim (context, price, modality)
 *   curated           — hand-written in enclave-curated.json
 *   vanilla           — a conservative default because nothing better existed
 *
 * Two retirement signals keep the catalog honest, both recorded in
 * `<agentDir>/enclave-retired.json`:
 *   not-listed    — a successful fetch stopped listing the id
 *   not-routable  — the id is listed but `routeable_endpoint_count` is 0 for
 *                   this key, so every request would 404
 *
 * Router aliases (`cyberouter/auto` plus one per security task) are published
 * too. They live in a sibling field of the catalog, not inside `data`, and are
 * easy to lose.
 *
 * Kill switch: PI_ENCLAVE_LIVE=0.   Maintenance audit: PI_ENCLAVE_REPROBE=1.
 */

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildStaticCatalog,
  ENCLAVE_BASE_URL,
  makeRefreshModels,
  PROVIDER_ID,
} from "./enclave-live.ts";

export default async function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();

  // The baked snapshot is registered eagerly so startup resolves before any
  // network call. It is built through the SAME funnel a refresh uses, so the
  // statically registered list carries the retirement ledger and the donor just
  // like the live one. Skipping either layer here is not a cosmetic difference:
  // `pi --list-models` never touches the network, so this list is what a reader
  // actually sees, and it was showing vanilla max-out and no images for models
  // whose live values were inherited.
  const models = buildStaticCatalog(agentDir);

  // Registration is unconditional: this bridge owns the EnClave provider and
  // replaces whatever `models.json` declares for it. The baked snapshot is what
  // makes startup work before any network call — the live layer replaces it with
  // gateway-sourced values (and real prices) as soon as a fetch succeeds.
  pi.registerProvider(PROVIDER_ID, {
    name: "EnClave",
    api: "openai-completions",
    baseUrl: ENCLAVE_BASE_URL,
    authHeader: true,
    models,
    refreshModels: makeRefreshModels({ agentDir, fallbackBaseUrl: ENCLAVE_BASE_URL }),
  });
}