/**
 * enclave-live.ts — the small shared core for the EnClave bridge.
 *
 * Values live in `models.json` (`providers.EnClave.models`), written by
 * `scripts/sync-models.mjs`. This module exists so the script and the extension
 * agree on one definition of "a model" and one definition of "where do values
 * come from". Nothing is computed here at runtime except membership.
 *
 * Value precedence, applied by the sync script:
 *
 *   1. DONOR — `providers.opendesign` in the same models.json, matched on the
 *      bare model name (the id with any `vendor/` prefix stripped on both
 *      sides). The donor is the source of truth. Its numbers are copied as-is,
 *      even when they are larger than what a local measurement found: a value
 *      the user chose beats one this tool inferred. Lower it deliberately if a
 *      problem ever shows up, not preemptively.
 *   2. EXISTING — whatever the EnClave entry already says. This is where
 *      hand-measured values live, and for models with no donor it is the only
 *      source. Copying is deliberately not additive: the donor replaces the
 *      block, so there is no leftover hybrid.
 *   3. GATEWAY — `context_length` and `pricing` only, because those are facts
 *      about this endpoint and the donor has no opinion on them.
 *
 * `cost` is always the gateway's: the donor carries no price, so inheriting it
 * would publish every model as free.
 *
 * Membership comes from the live catalog. A model is published only if the
 * catalog lists it AND `routeable_endpoint_count > 0` — an id with no healthy
 * route for this key is not something the picker should offer.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

export interface ModelEntry {
  id: string;
  name?: string;
  api?: string;
  provider?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input?: Array<"text" | "image">;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
  [key: string]: unknown;
}

export const ENCLAVE_BASE_URL = "https://router.enclave.ai/v1";
export const PROVIDER_ID = "EnClave";

/** Fields copied from the donor. Deliberately not cost, and not the id. */
const DONOR_FIELDS = [
  "reasoning",
  "thinkingLevelMap",
  "input",
  "contextWindow",
  "maxTokens",
  "compat",
] as const;

/** The model name with any `vendor/` prefix removed, on either side. */
export function bareName(id: string): string {
  const i = id.lastIndexOf("/");
  return i === -1 ? id : id.slice(i + 1);
}

// ---------------------------------------------------------------------------
// models.json
// ---------------------------------------------------------------------------

export interface ModelsJson {
  providers?: Record<string, Record<string, unknown> & { models?: ModelEntry[] }>;
}

export function readModelsJson(agentDir: string): ModelsJson {
  return JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")) as ModelsJson;
}

export function writeModelsJson(agentDir: string, data: ModelsJson): void {
  writeFileSync(join(agentDir, "models.json"), `${JSON.stringify(data, null, 2)}\n`);
}

export function providerModels(data: ModelsJson, provider: string): ModelEntry[] {
  return data.providers?.[provider]?.models ?? [];
}

/** bare name -> donor entry. First definition wins. */
export function donorIndex(data: ModelsJson, provider = "opendesign"): Map<string, ModelEntry> {
  const index = new Map<string, ModelEntry>();
  for (const m of providerModels(data, provider)) {
    const bare = bareName(m.id);
    if (!index.has(bare)) index.set(bare, m);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Live catalog
// ---------------------------------------------------------------------------

export interface CatalogModel {
  id: string;
  name?: string;
  contextLength?: number;
  pricingPrompt?: number;
  pricingCompletion?: number;
  routeable: boolean;
}

export interface CatalogAlias {
  id: string;
  task: string | null;
}

export interface LiveCatalog {
  models: CatalogModel[];
  aliases: CatalogAlias[];
}

export async function fetchCatalog(
  baseUrl: string,
  key: string,
  signal: AbortSignal,
): Promise<LiveCatalog | undefined> {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { data?: Array<Record<string, unknown>>; aliases?: Array<Record<string, unknown>> };
    const models: CatalogModel[] = [];
    for (const e of json.data ?? []) {
      if (typeof e.id !== "string") continue;
      const pricing = (e.pricing ?? {}) as Record<string, unknown>;
      const routeableCount = typeof e.routeable_endpoint_count === "number" ? e.routeable_endpoint_count : undefined;
      models.push({
        id: e.id,
        name: typeof e.name === "string" ? e.name : undefined,
        contextLength: typeof e.context_length === "number" ? e.context_length : undefined,
        pricingPrompt: typeof pricing.prompt === "number" ? pricing.prompt : undefined,
        pricingCompletion: typeof pricing.completion === "number" ? pricing.completion : undefined,
        routeable: routeableCount === undefined ? true : routeableCount > 0,
      });
    }
    const aliases: CatalogAlias[] = [];
    for (const e of json.aliases ?? []) {
      if (typeof e.id === "string") aliases.push({ id: e.id, task: typeof e.task === "string" ? e.task : null });
    }
    return models.length ? { models, aliases } : undefined;
  } catch {
    return undefined;
  }
}

/** Cheap liveness call. Returns an error class, or "ok". */
export async function liveness(
  baseUrl: string,
  key: string,
  modelId: string,
  signal: AbortSignal,
): Promise<"ok" | "no-route" | "upstream-gone" | "other"> {
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 8 }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    if (res.ok) return "ok";
    const body = await res.text().catch(() => "");
    if (res.status === 404) return "no-route";
    // The router is a tunnel: it reports the upstream status in the body.
    const m = /returned HTTP (\d{3})/i.exec(body);
    if (m?.[1] === "410") return "upstream-gone";
    return "other";
  } catch {
    return "other";
  }
}

// ---------------------------------------------------------------------------
// Building the block
// ---------------------------------------------------------------------------

export interface BuildResult {
  models: ModelEntry[];
  fromDonor: string[];
  fromExisting: string[];
  pending: string[];
  skipped: Array<{ id: string; why: string }>;
}

const num = (v: unknown, fallback: number) => (typeof v === "number" && v > 0 ? v : fallback);

/**
 * Build the EnClave model block from the live catalog, the donor and whatever
 * the EnClave block already says.
 *
 * @param alive pass a predicate that filters the live ids first, so callers can
 *   drop models that do not actually answer.
 */
export function buildBlock(
  catalog: LiveCatalog,
  donor: Map<string, ModelEntry>,
  existing: readonly ModelEntry[],
  baseUrl: string,
  alive: (id: string) => boolean = () => true,
): BuildResult {
  const existingByBare = new Map(existing.map((m) => [bareName(m.id), m]));
  const models: ModelEntry[] = [];
  const fromDonor: string[] = [];
  const fromExisting: string[] = [];
  const pending: string[] = [];
  const skipped: Array<{ id: string; why: string }> = [];

  for (const listing of catalog.models) {
    // routeable_endpoint_count 0 means the catalog lists it but this key has no
    // healthy route: every request 404s. Offering it would be the ghost-model
    // bug, so the catalog's own health field is enough to exclude it.
    if (!listing.routeable) {
      skipped.push({ id: listing.id, why: "sin ruta para esta clave" });
      continue;
    }
    if (!alive(listing.id)) {
      skipped.push({ id: listing.id, why: "no responde" });
      continue;
    }
    const bare = bareName(listing.id);
    const entry: ModelEntry = {
      id: listing.id,
      name: listing.name ?? listing.id,
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
      input: ["text"],
      contextWindow: num(listing.contextLength, 128_000),
      maxTokens: 16_384,
      // The donor carries no per-model compat (it keeps its own at provider
      // level), and this block REPLACES rather than merges, so without a
      // default here the flag is silently dropped. Pi then sends
      // role:"developer", which this gateway rejects with
      //   messages.0.role: Invalid option: expected one of
      //   "system"|"user"|"assistant"|"tool"
      // Set before the donor copy, so a donor that does declare compat wins.
      compat: { supportsDeveloperRole: false },
    };

    const from = donor.get(bare);
    if (from) {
      for (const f of DONOR_FIELDS) if (from[f] !== undefined) entry[f] = from[f] as never;
      fromDonor.push(listing.id);
    } else {
      const was = existingByBare.get(bare);
      if (was) {
        for (const f of DONOR_FIELDS) if (was[f] !== undefined) entry[f] = was[f] as never;
        fromExisting.push(listing.id);
      } else {
        pending.push(listing.id);
      }
    }

    // The gateway owns these two: they are facts about this endpoint.
    if (listing.contextLength) entry.contextWindow = listing.contextLength;
    entry.cost = {
      input: listing.pricingPrompt ?? 0,
      output: listing.pricingCompletion ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    entry.api = "openai-completions";
    models.push(entry);
  }

  // Router aliases: usable as a model, but their window and price depend on
  // which concrete model the router picks per request, so both are bounded
  // rather than guessed — context at the catalog floor, price at the ceiling.
  const contexts = catalog.models.map((m) => m.contextLength).filter((c): c is number => !!c);
  const pricesIn = catalog.models.map((m) => m.pricingPrompt).filter((c): c is number => !!c);
  const pricesOut = catalog.models.map((m) => m.pricingCompletion).filter((c): c is number => !!c);
  for (const alias of catalog.aliases) {
    if (!alive(alias.id)) {
      skipped.push({ id: alias.id, why: "no responde" });
      continue;
    }
    const bare = bareName(alias.id);
    const from = donor.get(bare) ?? existingByBare.get(bare);
    models.push({
      compat: { supportsDeveloperRole: false },
      ...(from ? Object.fromEntries(DONOR_FIELDS.filter((f) => from[f] !== undefined).map((f) => [f, from[f]])) : {}),
      id: alias.id,
      name: alias.id,
      api: "openai-completions",
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
      input: ["text"],
      contextWindow: contexts.length ? Math.min(...contexts) : 128_000,
      maxTokens: 16_384,
      cost: {
        input: pricesIn.length ? Math.max(...pricesIn) : 0,
        output: pricesOut.length ? Math.max(...pricesOut) : 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    });
  }

  return { models, fromDonor, fromExisting, pending, skipped };
}

// ---------------------------------------------------------------------------
// refreshModels — membership only
// ---------------------------------------------------------------------------

export interface RefreshModelsContextLike {
  credential?: { type?: string; key?: string };
  stored?: { models?: readonly ModelEntry[] };
  publish(p: { persist?: { models: ModelEntry[]; checkedAt?: number } | null; update?: () => void }): Promise<boolean>;
  allowNetwork: boolean;
  signal: AbortSignal;
}

/** This module is imported by index.ts, so it needs a valid factory export. */
export default async function enclaveHelper(): Promise<void> {}

/**
 * Keep membership fresh. Values come from `models.json`, which the sync script
 * owns — this only adds ids the endpoint started serving and drops ids it
 * stopped. It never invents a value.
 */
export function makeRefreshModels(agentDir: string, baseUrl = ENCLAVE_BASE_URL) {
  return async function refreshModels(ctx: RefreshModelsContextLike): Promise<ModelEntry[] | undefined> {
    if (process.env.PI_ENCLAVE_LIVE === "0") return undefined;
    const key = ctx.credential?.type === "api_key" ? ctx.credential.key : undefined;
    if (!ctx.allowNetwork || !key) return undefined;

    const catalog = await fetchCatalog(baseUrl, key, ctx.signal);
    if (!catalog || ctx.signal.aborted) return undefined;

    const live = new Set<string>([...catalog.models.filter((m) => m.routeable).map((m) => m.id), ...catalog.aliases.map((a) => a.id)]);
    const configured = providerModels(readModelsJson(agentDir), PROVIDER_ID);

    // Known values for anything the endpoint still serves. A new id has no
    // values here; `scripts/sync-models.mjs` is what fills it in.
    const out = configured.filter((m) => live.has(m.id));
    for (const id of live) if (!out.some((m) => m.id === id)) out.push({ id, name: id });

    if (ctx.signal.aborted) return undefined;
    const ok = await ctx.publish({ persist: { models: out, checkedAt: Date.now() } });
    return ok && !ctx.signal.aborted ? out : undefined;
  };
}