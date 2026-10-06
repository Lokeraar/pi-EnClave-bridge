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
import {
  type BundledCatalog,
  type ModelEntry,
  type Resolved,
  bareName,
  resolveModel,
} from "./donors-enclave.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

export type { ModelEntry } from "./donors-enclave.ts";

export const ENCLAVE_BASE_URL = "https://router.enclave.ai/v1";
export const PROVIDER_ID = "EnClave";

export { bareName } from "./donors-enclave.ts";

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

/** bare name -> the values already written for that model. First wins. */
export function keptIndex(data: ModelsJson, provider = PROVIDER_ID): Map<string, ModelEntry> {
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
  /** id -> which donors contributed and by which rule, for the report. */
  resolved: Map<string, Resolved>;
  pending: string[];
  skipped: Array<{ id: string; why: string }>;
}

const num = (v: unknown, fallback: number) => (typeof v === "number" && v > 0 ? v : fallback);

/**
 * Tokens held back from an output ceiling so the prompt has room. See the clamp
 * in buildBlock.
 *
 * This must cover a real Pi request, not a toy one. The router counts
 * `messages + tools + max_tokens` against the window, so a reserve smaller than
 * the system prompt plus every tool schema makes the model unusable in practice:
 * gpt-oss-120b (131,072 window) shipped a 117,964 ceiling that left ~13k for
 * input, below what Pi sends, and every call 400'd once the conversation grew.
 */
export const PROMPT_RESERVE_TOKENS = 32_768;

/** Aliases the router exposes: never resolved from a donor. See donors.ts. */
function isAliasId(id: string, aliases: readonly CatalogAlias[]): boolean {
  return aliases.some((a) => a.id === id);
}

/**
 * Build the EnClave model block from the live catalog and every donor.
 *
 * Precedence, per field: the hand-written layer outranks a bundled catalog
 * unless the two agree to within rounding, in which case the exact figure wins.
 * `contextWindow` and `cost` are never taken from a donor — they describe this
 * endpoint.
 */
export function buildBlock(
  catalog: LiveCatalog,
  kept: Map<string, ModelEntry>,
  bundled: readonly BundledCatalog[],
  baseUrl: string,
  alive: (id: string) => boolean = () => true,
): BuildResult {
  const models: ModelEntry[] = [];
  const resolved = new Map<string, Resolved>();
  const pending: string[] = [];
  const skipped: Array<{ id: string; why: string }> = [];

  const contexts = catalog.models.map((m) => m.contextLength).filter((c): c is number => !!c);
  const pricesIn = catalog.models.map((m) => m.pricingPrompt).filter((c): c is number => !!c);
  const pricesOut = catalog.models.map((m) => m.pricingCompletion).filter((c): c is number => !!c);

  for (const listing of catalog.models) {
    // routeable_endpoint_count 0 means the catalog lists it but this key has no
    // healthy route: every request 404s.
    if (!listing.routeable) {
      skipped.push({ id: listing.id, why: "sin ruta para esta clave" });
      continue;
    }
    if (!alive(listing.id)) {
      skipped.push({ id: listing.id, why: "no responde" });
      continue;
    }

    const bare = bareName(listing.id);
    const isAlias = isAliasId(listing.id, catalog.aliases);
    const r = resolveModel(bare, kept.get(bare), bundled, isAlias);
    resolved.set(listing.id, r);
    if (!r.source) pending.push(listing.id);

    const entry: ModelEntry = {
      ...r.entry,
      id: listing.id,
      name: listing.name ?? listing.id,
      reasoning: r.entry.reasoning ?? true,
      thinkingLevelMap:
        r.entry.thinkingLevelMap ??
        { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
      input: r.entry.input ?? ["text"],
      // The donor carries no per-model compat, and this block REPLACES rather
      // than merges, so a default is required. Without it Pi sends
      // role:"developer" and every request fails with
      //   messages.0.role: Invalid option: expected one of
      //   "system"|"user"|"assistant"|"tool"
      compat: r.entry.compat ?? { supportsDeveloperRole: false },
      // A donor may simply not state an output ceiling. `num` turns that into a
      // conservative default rather than leaving `undefined`, which would reach
      // Pi as null and fail schema validation.
      //
      // Clamped to the window MINUS a prompt reserve, because an output ceiling
      // larger than what the context can hold is not a bigger claim, it is an
      // impossible one. EnClave rejects it outright:
      //   "This request needs about N tokens (messages + tools + max_tokens)"
      // so the ceiling is the window minus whatever the prompt occupies. The
      // reserve is deliberately coarse (2048) because the prompt size is not
      // knowable here and the cost of being too generous is a rejected request,
      // while the cost of reserving too little is only headroom.
      //
      // Note the clamp can never EQUAL the window either: measured on inkling,
      // 262,144 was rejected while 261,120 passed. OpenRouter lists that same
      // model at 471,859 against a 262,144 window here, so this is not
      // hypothetical. A value inside the limit is used exactly as given — the
      // clamp removes impossibilities, it does not second-guess the donor.
      maxTokens: Math.min(
        num(r.entry.maxTokens, 16_384),
        Math.max(1_024, num(listing.contextLength, 128_000) - PROMPT_RESERVE_TOKENS),
      ),
      // The endpoint owns these two.
      contextWindow: num(listing.contextLength, 128_000),
      cost: {
        input: listing.pricingPrompt ?? 0,
        output: listing.pricingCompletion ?? 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      api: "openai-completions",
      donor: r.source
        ? {
            source: r.source,
            matchedId: r.matchedId,
            corroborating: r.corroborating,
            rule: r.rule,
          }
        : undefined,
    };
    models.push(entry);
  }

  // Router aliases: usable as a model, but their window and price depend on
  // which concrete model the router picks per request, so both are bounded
  // rather than guessed — context at the catalog floor, price at the ceiling.
  // Left vanilla on purpose: the same bare name is a different thing elsewhere.
  for (const alias of catalog.aliases) {
    if (!alive(alias.id)) {
      skipped.push({ id: alias.id, why: "no responde" });
      continue;
    }
    models.push({
      id: alias.id,
      name: alias.id,
      api: "openai-completions",
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
      input: ["text"],
      contextWindow: contexts.length ? Math.min(...contexts) : 128_000,
      maxTokens: 16_384,
      compat: { supportsDeveloperRole: false },
      cost: {
        input: pricesIn.length ? Math.max(...pricesIn) : 0,
        output: pricesOut.length ? Math.max(...pricesOut) : 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    });
  }

  return { models, resolved, pending, skipped };
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