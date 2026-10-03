/**
 * enclave-live.ts — the catalog engine for the EnClave provider bridge.
 *
 * ## Why this file is not a copy of `opendesign-live.ts`
 *
 * The two gateways differ in a way that changes the whole design:
 *
 * - OpenDesign's `/models` returns ids and almost nothing else. Every value a
 *   user cares about has to be discovered by probing, which is why that bridge
 *   probes aggressively and treats `context_window` as unmeasurable.
 * - EnClave's `/models` returns an OpenRouter-shaped catalog that already
 *   DECLARES `context_length`, `pricing` and per-key routability. Probing those
 *   again would waste money and produce weaker evidence than the endpoint's own
 *   claim. What EnClave says *nothing* about is reasoning effort levels and the
 *   output ceiling — exactly what still needs probing.
 *
 * So the rule here is inverted relative to the sibling bridge: trust the
 * gateway wherever it speaks, probe only where it is silent, and label every
 * value with where it came from so a reader never has to guess.
 *
 * ## The two retirement signals
 *
 * OpenDesign only had one ("the endpoint stopped listing it"). EnClave has two,
 * and the second one is easy to miss:
 *
 * 1. `not-listed`   — a successful fetch did not return the id.
 * 2. `not-routable` — the id IS listed, but `routeable_endpoint_count` is 0 for
 *    this key. The router fails closed and every request 404s with
 *    "No routeable endpoint matched filters (healthy, zdr, data_collection)".
 *    Publishing such a model is the exact ghost-model bug the ledger exists to
 *    prevent: it looks selectable and fails 100% of the time.
 *
 * ## Aliases
 *
 * The catalog has a sibling field `aliases` (NOT inside `data`) holding five
 * router pseudo-models: `cyberouter/auto` plus one per security task
 * (`vuln-discovery`, `exploit-dev`, `remediation`, `triage`), each sorted by
 * `task_perf`. A parser that only reads `data` silently loses all five.
 *
 * They are usable as a `model` value but have no context window and no price of
 * their own — both depend on which concrete model the router picks per request.
 * We bound them instead of guessing: the SMALLEST context window in the catalog
 * (the guaranteed floor, since some routed model may be the narrow one) and the
 * LARGEST price in the catalog (an upper bound, because understating what a
 * call will cost is worse than overstating it). That asymmetry is deliberate:
 * capability fields are biased low, money fields are biased high.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

/**
 * Where each value came from.
 *
 * - `curated`  — hand-written in the curated file / baked snapshot. Trusted,
 *                never overwritten by the live layer.
 * - `measured` — a real probe: the request was made and the answer observed.
 * - `gateway`  — the endpoint's own declaration. Real, but a CLAIM.
 * - `vanilla`  — a conservative default used because nothing better was
 *                available. Honest, but not evidence.
 */
export type ValueOrigin = "curated" | "measured" | "gateway" | "vanilla";

export interface ValueProvenance {
  contextWindow: ValueOrigin;
  maxTokens: ValueOrigin;
  thinkingLevelMap: ValueOrigin;
  input: ValueOrigin;
  cost: ValueOrigin;
}

export interface LiveModelConfig {
  id: string;
  name: string;
  api?: string;
  provider?: string;
  baseUrl?: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat?: Record<string, unknown>;
  /** `cyberouter/auto` and friends are router pseudo-models, not fixed weights. */
  alias?: { task: string | null; sort?: string };
  metadata?: Record<string, unknown>;
  provenance?: ValueProvenance;
  [key: string]: unknown;
}

/** Structural mirror of pi-ai's RefreshModelsContext. */
export interface RefreshModelsContextLike {
  credential?: { type?: string; key?: string };
  stored?: {
    models?: readonly LiveModelConfig[];
    checkedAt?: number;
    etag?: string;
    lastModified?: number;
  };
  publish(publication: {
    persist?: { models: LiveModelConfig[]; checkedAt?: number } | null;
    update?: () => void;
  }): Promise<boolean>;
  allowNetwork: boolean;
  force?: boolean;
  signal: AbortSignal;
}

export interface ModelsJsonProviderLike {
  baseUrl?: string;
  compat?: Record<string, unknown>;
  models?: LiveModelConfig[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ENCLAVE_BASE_URL = "https://router.enclave.ai/v1";
export const PROVIDER_ID = "EnClave";

export const THINKING_LEVELS: Array<Exclude<ThinkingLevel, "off">> = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Conservative default: only `medium` is offered.
 *
 * `getSupportedThinkingLevels` drops any level mapped to `null` and keeps
 * `xhigh`/`max` only when the key is present at all, so this map reduces the UI
 * to a single safe level instead of guessing. It is `vanilla`, never `measured`.
 */
const VANILLA_THINKING_MAP: ThinkingLevelMap = {
  off: null,
  minimal: null,
  low: null,
  medium: "medium",
  high: null,
  xhigh: null,
  max: null,
};

/** Ascending output-cap candidates; the walk stops at the first rejection. */
const CEILING_CANDIDATES = [
  8_192, 32_768, 131_072, 262_144, 393_216, 524_288, 1_048_576, 2_097_152,
];

const PROBE_BODY_MESSAGES = [
  { role: "system", content: "Be terse." },
  { role: "user", content: "hi" },
];

/** Non-chat ids the picker must never see. */
const NOISE_PATTERN =
  /\b(embed|embedding|tts|whisper|dall-?e|clip|moderation|rerank|reranker)\b|^image[-_]|[-_]embed/i;

// ---------------------------------------------------------------------------
// Baked snapshot (registration-time fallback; the live layer replaces it)
// ---------------------------------------------------------------------------

/**
 * A snapshot of the catalog observed on 2026-10-03 (14 models, 13 routable + 5 aliases), so `findInitialModel()` can
 * resolve during startup before any network call happens. Every value here is
 * `curated` — it is a transcription of one observation, not a live fact. The
 * live layer overwrites it as soon as a fetch succeeds.
 */
export const SNAPSHOT_MODELS: LiveModelConfig[] = [
  {
    id: "cyberouter/glm-5.3",
    name: "GLM 5.3",
    reasoning: true,
    input: ["text"],
    contextWindow: 1048576,
    maxTokens: 16384,
    cost: { input: 1.4, output: 4.4, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
    metadata: { family: "glm-5", creator: "Zhipu (open weight; hosted US/EU only)", endpointCount: 3, routeableEndpointCount: 3 },
  },
  {
    id: "cyberouter/glm-5.3-flash",
    name: "GLM 5.3 Flash",
    reasoning: true,
    input: ["text"],
    contextWindow: 1048576,
    maxTokens: 16384,
    cost: { input: 0.15, output: 0.5, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
    metadata: { family: "glm-5", creator: "Zhipu (open weight; hosted US/EU only)", endpointCount: 2, routeableEndpointCount: 2 },
  },
  {
    id: "cyberouter/glm-5.2",
    name: "GLM 5.2",
    reasoning: true,
    input: ["text"],
    contextWindow: 1048576,
    maxTokens: 16384,
    cost: { input: 1.4, output: 4.4, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
    metadata: { family: "glm-5", creator: "Zhipu (open weight; hosted US/EU only)", endpointCount: 3, routeableEndpointCount: 3 },
  },
  {
    id: "cyberouter/deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    reasoning: true,
    input: ["text"],
    contextWindow: 1048576,
    maxTokens: 16384,
    cost: { input: 1.32, output: 3.96, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
    metadata: { family: "deepseek-v4", creator: "DeepSeek (open weight; hosted US/EU only)", endpointCount: 2, routeableEndpointCount: 2 },
  },
  {
    id: "cyberouter/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    reasoning: true,
    input: ["text"],
    contextWindow: 1048576,
    maxTokens: 16384,
    cost: { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
    metadata: { family: "deepseek-v4.1", creator: "DeepSeek (open weight; hosted US/EU only)", endpointCount: 2, routeableEndpointCount: 2 },
  },
  {
    id: "cyberouter/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    reasoning: true,
    input: ["text"],
    contextWindow: 1048576,
    maxTokens: 16384,
    cost: { input: 0.13, output: 0.26, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
    metadata: { family: "deepseek-v4", creator: "DeepSeek (open weight; hosted US/EU only)", endpointCount: 2, routeableEndpointCount: 2 },
  },
  {
    id: "cyberouter/qwen3.8-max",
    name: "Qwen3.8 Max",
    reasoning: true,
    input: ["text"],
    contextWindow: 1010000,
    maxTokens: 16384,
    cost: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
    metadata: { family: "qwen3.8", creator: "Alibaba (open weight; hosted US/EU only)", endpointCount: 1, routeableEndpointCount: 1 },
  },
  {
    id: "cyberouter/kimi-k3",
    name: "Kimi K3",
    reasoning: true,
    input: ["text"],
    contextWindow: 1048576,
    maxTokens: 16384,
    cost: { input: 2.7, output: 13.5, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
    metadata: { family: "kimi-k3", creator: "Moonshot (open weight; hosted US/EU only)", endpointCount: 2, routeableEndpointCount: 2 },
  },
  {
    id: "cyberouter/kimi-k2.6",
    name: "Kimi K2.6",
    reasoning: true,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 16384,
    cost: { input: 0.95, output: 4, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
    metadata: { family: "kimi-k2", creator: "Moonshot (open weight; hosted US/EU only)", endpointCount: 2, routeableEndpointCount: 1 },
  },
  {
    id: "cyberouter/gpt-oss-120b",
    name: "GPT-OSS 120B",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 16384,
    cost: { input: 0.1, output: 0.5, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
    metadata: { family: "gpt-oss", creator: "OpenAI (open weight)", endpointCount: 2, routeableEndpointCount: 2 },
  },
  {
    id: "cyberouter/minimax-m3",
    name: "MiniMax M3",
    reasoning: true,
    input: ["text"],
    contextWindow: 524288,
    maxTokens: 16384,
    cost: { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
    metadata: { family: "minimax-m3", creator: "MiniMax (open weight; hosted US/EU only)", endpointCount: 1, routeableEndpointCount: 1 },
  },
  {
    id: "cyberouter/inkling",
    name: "Inkling",
    reasoning: true,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 16384,
    cost: { input: 1, output: 4.05, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
    metadata: { family: "inkling", creator: "Thinking Machines", endpointCount: 2, routeableEndpointCount: 2 },
  },
  {
    id: "cyberouter/nemotron-ultra",
    name: "Nemotron 3 Ultra",
    reasoning: true,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 16384,
    cost: { input: 0.6, output: 2.4, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
    metadata: { family: "nemotron", creator: "NVIDIA", endpointCount: 2, routeableEndpointCount: 1 },
  },
];

/** Same idea for aliases, filled in by the same snapshot step. */
export const SNAPSHOT_ALIAS_MODELS: LiveModelConfig[] = [
  {
    id: "cyberouter/auto",
    name: "cyberouter/auto",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 16384,
    cost: { input: 2.7, output: 13.5, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
    alias: { task: null, sort: "task_perf" },
  },
  {
    id: "cyberouter/vuln-discovery",
    name: "cyberouter/vuln-discovery",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 16384,
    cost: { input: 2.7, output: 13.5, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
    alias: { task: "vuln_discovery", sort: "task_perf" },
  },
  {
    id: "cyberouter/exploit-dev",
    name: "cyberouter/exploit-dev",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 16384,
    cost: { input: 2.7, output: 13.5, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
    alias: { task: "exploit_dev", sort: "task_perf" },
  },
  {
    id: "cyberouter/remediation",
    name: "cyberouter/remediation",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 16384,
    cost: { input: 2.7, output: 13.5, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
    alias: { task: "remediation", sort: "task_perf" },
  },
  {
    id: "cyberouter/triage",
    name: "cyberouter/triage",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 16384,
    cost: { input: 2.7, output: 13.5, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
    alias: { task: "triage", sort: "task_perf" },
  },
];

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

function normalize(m: LiveModelConfig): LiveModelConfig {
  const mergedCompat = {
    supportsDeveloperRole: false,
    ...(m.compat ?? {}),
  };
  // Invariant: only hand-written entries reach here without provenance — the
  // curated file and the baked snapshot. Probe-built, gateway-built and stored
  // entries all carry it forward via the spread. So absent ⇒ curated.
  const provenance: ValueProvenance = m.provenance ?? {
    contextWindow: "curated",
    maxTokens: "curated",
    thinkingLevelMap: "curated",
    input: "curated",
    cost: "curated",
  };
  return {
    ...m,
    name: m.name ?? m.id,
    api: m.api ?? "openai-completions",
    provider: PROVIDER_ID,
    reasoning: m.reasoning ?? true,
    input: m.input && m.input.length ? m.input : ["text"],
    cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow && m.contextWindow > 0 ? m.contextWindow : 128_000,
    maxTokens: m.maxTokens && m.maxTokens > 0 ? m.maxTokens : 16_384,
    compat: mergedCompat,
    provenance,
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface ProbeResult {
  ok: boolean;
  /** reasoning tokens reported by usage, when the upstream reports them */
  rt?: number;
  status?: number;
  /** transport-level failure (timeout/conn/abort), not an HTTP rejection */
  net?: boolean;
}

async function postChat(
  baseUrl: string,
  key: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  timeoutMs = 20_000,
): Promise<ProbeResult> {
  if (signal.aborted) return { ok: false, net: true };
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const json = (await res.json()) as {
      usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
    };
    const rt = json?.usage?.completion_tokens_details?.reasoning_tokens;
    return { ok: true, rt: typeof rt === "number" ? rt : undefined };
  } catch {
    return { ok: false, net: true };
  }
}

/**
 * The only HTTP statuses that constitute a per-parameter MEASUREMENT.
 *
 * Everything else is a request-level failure that says nothing about the model:
 * 402 quota exhausted, 401/403 auth, 404 no route, 429 rate limit, 5xx, and
 * transport errors. Deriving values from those is how a probe concludes "this
 * model has no reasoning and a 16k ceiling" while the account simply cannot pay
 * or the router is down — which is precisely the state EnClave's chat endpoint
 * is in today (Vercel 500 on every model).
 */
function isParameterRejection(status?: number): boolean {
  return status === 400 || status === 422;
}

// ---------------------------------------------------------------------------
// Catalog fetch
// ---------------------------------------------------------------------------

export interface GatewayModel {
  id: string;
  name?: string;
  contextLength?: number;
  pricingPrompt?: number;
  pricingCompletion?: number;
  /** false when `routeable_endpoint_count` is 0 for this key */
  routeable: boolean;
  routeableCount?: number;
  endpointCount?: number;
  modality?: string;
  toolCapable?: boolean;
  openWeight?: boolean;
  family?: string;
  creator?: string;
  tasks?: string[];
}

export interface GatewayAlias {
  id: string;
  task: string | null;
  sort?: string;
}

export interface LiveCatalog {
  models: GatewayModel[];
  aliases: GatewayAlias[];
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * Fetch + normalize the catalog. Returns `undefined` on any failure so the
 * caller falls back to the previous layer instead of publishing an empty one.
 */
export async function fetchLiveCatalog(
  baseUrl: string,
  key: string,
  signal: AbortSignal,
): Promise<LiveCatalog | undefined> {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as {
      data?: Array<Record<string, unknown>>;
      aliases?: Array<Record<string, unknown>>;
    };

    const models: GatewayModel[] = [];
    for (const entry of json?.data ?? []) {
      const id = typeof entry.id === "string" ? entry.id : undefined;
      if (!id || entry.enabled === false || NOISE_PATTERN.test(id)) continue;
      const arch = (entry.architecture ?? {}) as Record<string, unknown>;
      const pricing = (entry.pricing ?? {}) as Record<string, unknown>;
      // NOTE: 0 is the meaningful value here, so this must NOT go through
      // `num()` — that helper rejects anything <= 0 and would turn a dead route
      // into "unknown", i.e. routable. Only a non-number counts as unknown.
      const rawRouteable = entry.routeable_endpoint_count;
      const routeableCount =
        typeof rawRouteable === "number" && Number.isFinite(rawRouteable) && rawRouteable >= 0
          ? rawRouteable
          : undefined;
      models.push({
        id,
        name: typeof entry.name === "string" ? entry.name : undefined,
        contextLength: num(entry.context_length),
        pricingPrompt: num(pricing.prompt),
        pricingCompletion: num(pricing.completion),
        // Absent count means "unknown", which we treat as routable: only an
        // explicit 0 is evidence of a dead route.
        routeable: routeableCount === undefined ? true : routeableCount > 0,
        routeableCount,
        endpointCount: num(entry.endpoint_count),
        modality: typeof arch.modality === "string" ? arch.modality : undefined,
        toolCapable: entry.tool_capable === true,
        openWeight: entry.open_weight === true,
        family: typeof entry.family === "string" ? entry.family : undefined,
        creator: typeof entry.creator === "string" ? entry.creator : undefined,
        tasks: Array.isArray(entry.tasks)
          ? (entry.tasks as unknown[]).filter((t): t is string => typeof t === "string")
          : undefined,
      });
    }

    const aliases: GatewayAlias[] = [];
    for (const entry of json?.aliases ?? []) {
      const id = typeof entry.id === "string" ? entry.id : undefined;
      if (!id) continue;
      aliases.push({
        id,
        task: typeof entry.task === "string" ? entry.task : null,
        sort: typeof entry.sort === "string" ? entry.sort : undefined,
      });
    }

    // An empty catalog means the fetch told us nothing; treat it as failure so
    // we never retire the whole provider on a truncated response.
    if (!models.length) return undefined;
    return { models, aliases };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Building models from the gateway
// ---------------------------------------------------------------------------

/**
 * Pi's `input` only models text and image. The catalog's `architecture.modality`
 * is currently the literal string `"text"` for all thirteen models with
 * `tokenizer:"unknown"`, which looks like a templated fill rather than a real
 * declaration — so it is reported as `gateway` (the endpoint's claim) and never
 * as `measured`. Audio/video in the catalog are not representable in Pi.
 */
function inputFromModality(modality?: string): Array<"text" | "image"> {
  const m = (modality ?? "").toLowerCase();
  if (m.includes("image") || m.includes("vision") || m.includes("multimodal")) {
    return ["text", "image"];
  }
  return ["text"];
}

/** Pi's `cost` is USD per 1M tokens — the same unit as the catalog's pricing. */
function costFromPricing(
  prompt: number | undefined,
  completion: number | undefined,
): LiveModelConfig["cost"] {
  return {
    input: prompt ?? 0,
    output: completion ?? 0,
    // The catalog publishes no cache rates. 0 is not "free" here; it is
    // "unpriced by the endpoint", and it is labelled `gateway` so a reader can
    // see the difference between a known-zero price and an unknown one.
    cacheRead: 0,
    cacheWrite: 0,
  };
}

export function gatewayModel(listing: GatewayModel): LiveModelConfig {
  return normalize({
    id: listing.id,
    name: listing.name ?? listing.id,
    reasoning: true,
    input: inputFromModality(listing.modality),
    contextWindow: listing.contextLength ?? 128_000,
    maxTokens: 16_384,
    cost: costFromPricing(listing.pricingPrompt, listing.pricingCompletion),
    thinkingLevelMap: VANILLA_THINKING_MAP,
    metadata: {
      family: listing.family,
      creator: listing.creator,
      tasks: listing.tasks,
      toolCapable: listing.toolCapable,
      openWeight: listing.openWeight,
      endpointCount: listing.endpointCount,
      routeableEndpointCount: listing.routeableCount,
    },
    provenance: {
      contextWindow: listing.contextLength ? "gateway" : "vanilla",
      maxTokens: "vanilla",
      thinkingLevelMap: "vanilla",
      input: listing.modality ? "gateway" : "vanilla",
      cost: listing.pricingPrompt || listing.pricingCompletion ? "gateway" : "vanilla",
    },
  });
}

/**
 * A router alias has no window and no price of its own. Bound both:
 * smallest context in the catalog (the guaranteed floor) and largest price
 * (an upper bound — understating cost is the worse error here).
 */
export function aliasModel(
  alias: GatewayAlias,
  bounds: { minContext: number; maxInput: number; maxOutput: number },
): LiveModelConfig {
  return normalize({
    id: alias.id,
    name: alias.id.replace(/^cyberouter\//, "auto · "),
    reasoning: true,
    input: ["text"],
    contextWindow: bounds.minContext,
    maxTokens: 16_384,
    cost: { input: bounds.maxInput, output: bounds.maxOutput, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: VANILLA_THINKING_MAP,
    alias: { task: alias.task, sort: alias.sort },
    provenance: {
      contextWindow: "gateway",
      maxTokens: "vanilla",
      thinkingLevelMap: "vanilla",
      input: "vanilla",
      cost: "gateway",
    },
  });
}

export function catalogBounds(models: readonly GatewayModel[]): {
  minContext: number;
  maxInput: number;
  maxOutput: number;
} {
  const contexts = models.map((m) => m.contextLength).filter((c): c is number => !!c);
  const inputs = models.map((m) => m.pricingPrompt).filter((c): c is number => !!c);
  const outputs = models.map((m) => m.pricingCompletion).filter((c): c is number => !!c);
  return {
    minContext: contexts.length ? Math.min(...contexts) : 128_000,
    maxInput: inputs.length ? Math.max(...inputs) : 0,
    maxOutput: outputs.length ? Math.max(...outputs) : 0,
  };
}

// ---------------------------------------------------------------------------
// Probe (only for what the gateway does not declare)
// ---------------------------------------------------------------------------

/**
 * Measure a brand-new model: effort levels, real `off` behaviour and the output
 * ceiling. Returns `undefined` on any request-level failure so the caller falls
 * back to the gateway-only build; an HTTP 400/422 per level IS a measurement.
 */
export async function probeNewModel(
  listing: GatewayModel,
  baseUrl: string,
  key: string,
  signal: AbortSignal,
): Promise<LiveModelConfig | undefined> {
  const base = {
    model: listing.id,
    messages: PROBE_BODY_MESSAGES,
    max_tokens: 16,
    stream: false,
  };

  const noParam = await postChat(baseUrl, key, base, signal);
  // Quota/auth/rate-limit/5xx is not a measurement — do not derive values from it.
  if (!noParam.ok && !isParameterRejection(noParam.status)) return undefined;

  const map: ThinkingLevelMap = {};
  let anyLevelOk = false;
  let anyReasoningSeen = (noParam.rt ?? 0) > 0;

  for (const level of THINKING_LEVELS) {
    if (signal.aborted) return undefined;
    const r = await postChat(baseUrl, key, { ...base, reasoning_effort: level }, signal);
    if (!r.ok && !isParameterRejection(r.status)) return undefined;
    map[level] = r.ok ? level : null;
    if (r.ok) anyLevelOk = true;
    if ((r.rt ?? 0) > 0) anyReasoningSeen = true;
  }

  // `off`: accepted AND zero reasoning tokens → "none"
  if (signal.aborted) return undefined;
  const none = await postChat(baseUrl, key, { ...base, reasoning_effort: "none" }, signal);
  if (!none.ok && !isParameterRejection(none.status)) return undefined;
  map.off = none.ok && !(none.rt !== undefined && none.rt > 0) ? "none" : null;
  if ((none.rt ?? 0) > 0) anyReasoningSeen = true;

  const reasoning = anyLevelOk || none.ok || anyReasoningSeen;

  // Output ceiling, walked with NO effort param so effort validation cannot
  // confound it. The walk reports the last ACCEPTED candidate, which is a floor
  // on the real ceiling, never an overstatement of it.
  let highest = 0;
  for (const n of CEILING_CANDIDATES) {
    if (signal.aborted) return undefined;
    const r = await postChat(baseUrl, key, { ...base, max_tokens: n }, signal, 30_000);
    if (!r.ok) {
      // A timeout or quota error mid-walk is not a ceiling measurement; bail out
      // so the caller keeps the gateway-only values instead of a wrong floor.
      if (!isParameterRejection(r.status)) return undefined;
      break;
    }
    highest = n;
  }

  const contextWindow = listing.contextLength ?? 128_000;
  const maxTokens = highest > 0 ? Math.min(contextWindow, highest) : 16_384;

  return normalize({
    id: listing.id,
    name: listing.name ?? listing.id,
    reasoning,
    input: inputFromModality(listing.modality),
    contextWindow,
    maxTokens,
    cost: costFromPricing(listing.pricingPrompt, listing.pricingCompletion),
    thinkingLevelMap: map,
    provenance: {
      contextWindow: listing.contextLength ? "gateway" : "vanilla",
      maxTokens: highest > 0 ? "measured" : "vanilla",
      thinkingLevelMap: "measured",
      input: listing.modality ? "gateway" : "vanilla",
      cost: listing.pricingPrompt || listing.pricingCompletion ? "gateway" : "vanilla",
    },
  });
}

// ---------------------------------------------------------------------------
// Curated layer
// ---------------------------------------------------------------------------

const CURATED_FILE = "enclave-curated.json";

/**
 * Hand-tuned values live in `<agentDir>/enclave-curated.json` as
 * `{ "models": [...] }`. Curated entries are authoritative for their values and
 * are never overwritten by the live layer — that is what makes them a place to
 * record something the gateway does not declare.
 */
export function readCurated(agentDir: string): LiveModelConfig[] {
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, CURATED_FILE), "utf8")) as {
      models?: unknown;
    };
    if (!Array.isArray(parsed?.models)) return [];
    return parsed.models.filter(
      (m): m is LiveModelConfig =>
        !!m && typeof m === "object" && typeof (m as LiveModelConfig).id === "string",
    );
  } catch {
    return []; // Missing or malformed: no curated layer, live layer still runs.
  }
}

// ---------------------------------------------------------------------------
// Retirement ledger
// ---------------------------------------------------------------------------

const RETIRED_FILE = "enclave-retired.json";

export type RetirementReason = "not-listed" | "not-routable";

export interface RetiredLedger {
  updatedAt: number;
  /** id -> { at, reason } */
  retired: Record<string, { at: number; reason: RetirementReason }>;
}

function readRetiredLedger(agentDir: string): RetiredLedger {
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, RETIRED_FILE), "utf8")) as RetiredLedger;
    if (parsed && typeof parsed === "object" && parsed.retired && typeof parsed.retired === "object") {
      return parsed;
    }
  } catch {
    // Missing or corrupt → "nothing retired", so we never hide a model.
  }
  return { updatedAt: 0, retired: {} };
}

function writeRetiredLedger(agentDir: string, ledger: RetiredLedger): void {
  try {
    writeFileSync(join(agentDir, RETIRED_FILE), `${JSON.stringify(ledger, null, 2)}\n`);
  } catch {
    // A read-only agent dir must not break the refresh.
  }
}

/**
 * Record which known ids a SUCCESSFUL live check stopped serving, under either
 * signal. Self-correcting: an id the endpoint serves again is un-retired.
 */
function reconcileRetired(
  agentDir: string,
  catalog: LiveCatalog,
  candidates: readonly LiveModelConfig[],
): RetiredLedger {
  const ledger = readRetiredLedger(agentDir);
  const now = Date.now();
  const next: RetiredLedger["retired"] = { ...ledger.retired };

  const listed = new Map(catalog.models.map((m) => [m.id, m]));
  // Only ROUTABLE ids count as live. A listed id with no healthy route is a
  // retirement signal in its own right; counting it as live here would make the
  // `not-routable` branch below unreachable and leave an unroutable model in
  // the store forever, where phase 1 would keep restoring it.
  const liveIds = new Set([
    ...catalog.models.filter((m) => m.routeable !== false).map((m) => m.id),
    ...catalog.aliases.map((a) => a.id),
  ]);

  for (const id of Object.keys(next)) if (liveIds.has(id)) delete next[id];

  for (const m of candidates) {
    if (liveIds.has(m.id)) continue;
    const entry = listed.get(m.id);
    // Present in the catalog but with no healthy route for this key.
    const reason: RetirementReason = entry ? "not-routable" : "not-listed";
    if (!next[m.id]) next[m.id] = { at: now, reason }; // keep the original date
  }

  if (JSON.stringify(next) === JSON.stringify(ledger.retired)) return ledger;
  const updated: RetiredLedger = { updatedAt: now, retired: next };
  writeRetiredLedger(agentDir, updated);
  return updated;
}

export function retiredIds(agentDir: string): Set<string> {
  return new Set(Object.keys(readRetiredLedger(agentDir).retired));
}

// ---------------------------------------------------------------------------
// Curated re-probe audit — PI_ENCLAVE_REPROBE
// ---------------------------------------------------------------------------

export interface ReprobeFinding {
  id: string;
  field: "contextWindow" | "maxTokens" | "thinkingLevelMap" | "reasoning" | "input" | "cost";
  curated: unknown;
  measured: unknown;
  status: "changed" | "match" | "probe-failed";
  /** What the "measured" side actually IS. See FIELD_BASIS. */
  basis: "probe" | "gateway-declaration" | "none";
}

export interface ReprobeReport {
  generatedAt: string;
  baseUrl: string;
  audited: number;
  changed: ReprobeFinding[];
  retired: Array<{ id: string; reason: RetirementReason }>;
  uncurated: string[];
  findings: ReprobeFinding[];
}

function truthyEnv(envName: string): boolean {
  const v = (process.env[envName] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/**
 * Numeric comparison with tolerance: curated values are written in round units
 * (128_000) while the gateway declares exact powers of two (131_072). Same
 * window, different notation — flagging it would bury real drift in noise.
 */
function numericClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.05 * Math.max(Math.abs(a), Math.abs(b));
}

/**
 * Which side is authoritative per field. Only `maxTokens`,
 * `thinkingLevelMap` and `reasoning` are actually probed; `contextWindow`,
 * `input` and `cost` are the endpoint's own declaration. Reading a context
 * drift as "my curated value is wrong" would overwrite a verified number with
 * an unverified one.
 */
const FIELD_BASIS: Record<ReprobeFinding["field"], ReprobeFinding["basis"]> = {
  contextWindow: "gateway-declaration",
  maxTokens: "probe",
  thinkingLevelMap: "probe",
  reasoning: "probe",
  input: "gateway-declaration",
  cost: "gateway-declaration",
};

function diffCuratedVsGateway(
  curated: LiveModelConfig,
  observed: LiveModelConfig,
): ReprobeFinding[] {
  const out: ReprobeFinding[] = [];
  const numeric = (field: "contextWindow" | "maxTokens") => {
    const a = Number(curated[field] ?? 0);
    const b = Number(observed[field] ?? 0);
    return numericClose(a, b) ? null : { field, curated: a, measured: b };
  };
  const exact = (field: "thinkingLevelMap" | "reasoning" | "input") => {
    const a = JSON.stringify(curated[field] ?? null);
    const b = JSON.stringify(observed[field] ?? null);
    return a === b ? null : { field, curated: curated[field] ?? null, measured: observed[field] ?? null };
  };
  for (const field of ["contextWindow", "maxTokens"] as const) {
    const d = numeric(field);
    if (d) out.push({ id: curated.id, status: "changed", basis: FIELD_BASIS[field], ...d });
  }
  for (const field of ["thinkingLevelMap", "reasoning", "input"] as const) {
    const d = exact(field);
    if (d) out.push({ id: curated.id, status: "changed", basis: FIELD_BASIS[field], ...d });
  }
  return out;
}

function fmt(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

function writeReprobeReport(agentDir: string, report: ReprobeReport): void {
  try {
    writeFileSync(join(agentDir, "enclave-reprobe.json"), `${JSON.stringify(report, null, 2)}\n`);
  } catch {
    /* read-only agent dir */
  }
}

/**
 * Re-check curated values against the endpoint and report drift. Report-only by
 * design: promoting an observed value automatically is exactly what this audit
 * exists to make unnecessary.
 */
export async function runReprobeAudit(options: {
  agentDir: string;
  baseUrl: string;
  key: string;
  signal: AbortSignal;
  curated: readonly LiveModelConfig[];
  catalog: LiveCatalog;
}): Promise<ReprobeReport> {
  const { agentDir, baseUrl, key, signal, curated, catalog } = options;
  const ledger = readRetiredLedger(agentDir);
  const findings: ReprobeFinding[] = [];
  const retired = Object.entries(ledger.retired).map(([id, v]) => ({ id, reason: v.reason }));
  const curatedIds = new Set(curated.map((m) => m.id));

  for (const listing of catalog.models) {
    if (signal.aborted) break;
    const known = curated.find((m) => m.id === listing.id);
    const uncurated = !known;
    if (!known) {
      findings.push({
        id: listing.id,
        field: "maxTokens",
        curated: null,
        measured: null,
        status: "probe-failed",
        basis: "none",
      });
    }

    const probed = await probeNewModel(listing, baseUrl, key, signal);
    if (signal.aborted) break;
    if (!probed) {
      if (known) {
        findings.push({
          id: listing.id,
          field: "maxTokens",
          curated: known.maxTokens,
          measured: null,
          status: "probe-failed",
          basis: "none",
        });
      }
      continue;
    }
    if (known) findings.push(...diffCuratedVsGateway(known, probed));
  }

  const report: ReprobeReport = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    audited: catalog.models.length,
    changed: findings.filter((f) => f.status === "changed"),
    retired,
    uncurated: catalog.models.filter((m) => !curatedIds.has(m.id)).map((m) => m.id),
    findings,
  };

  writeReprobeReport(agentDir, report);

  const lines = [
    `enclave re-probe ${report.generatedAt} — ${report.audited} models, ${report.changed.length} changed`,
  ];
  for (const f of report.changed) {
    lines.push(`  ${f.id} ${f.field}: ${fmt(f.curated)} -> ${fmt(f.measured)} [${f.basis}]`);
  }
  if (retired.length) {
    for (const r of retired) lines.push(`  RETIRED ${r.id} (${r.reason})`);
  }
  const failed = findings.filter((f) => f.status === "probe-failed").length;
  if (failed) lines.push(`  ${failed} probe-failed (endpoint did not answer with a measurement)`);
  console.error(`[enclave-bridge] ${lines.join("\n")}`);
  return report;
}

// ---------------------------------------------------------------------------
// refreshModels
// ---------------------------------------------------------------------------

export interface RefreshModelsOptions {
  agentDir: string;
  fallbackBaseUrl?: string;
  /** Test hook: force the endpoint (production leaves this undefined). */
  baseUrlOverride?: string;
  /** Env var name for the kill switch (default PI_ENCLAVE_LIVE). */
  killSwitchEnv?: string;
  /** Env var name for the re-probe audit (default PI_ENCLAVE_REPROBE). */
  reprobeEnv?: string;
  /** Set false to skip probing brand-new ids entirely. */
  probe?: boolean;
}

function liveDisabled(envName: string): boolean {
  const v = process.env[envName];
  return v === "0" || v === "false" || v === "off";
}

function sameModels(a: readonly LiveModelConfig[], b: readonly LiveModelConfig[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Pi's extension loader treats EVERY `extensions/*.ts` file as an extension
 * factory, so this helper module must expose a no-op default factory to load
 * silently next to `index.ts`.
 */
export default async function enclaveLiveHelper(): Promise<void> {}

export function makeRefreshModels(options: RefreshModelsOptions) {
  const envName = options.killSwitchEnv ?? "PI_ENCLAVE_LIVE";
  const fallbackBaseUrl = options.fallbackBaseUrl ?? ENCLAVE_BASE_URL;

  return async function refreshModels(
    ctx: RefreshModelsContextLike,
  ): Promise<LiveModelConfig[] | undefined> {
    if (liveDisabled(envName)) return undefined;

    const curated = readCurated(options.agentDir).map((m) => normalize(m));
    const curatedById = new Map(curated.map((m) => [m.id, m]));
    const baseUrl = options.baseUrlOverride ?? fallbackBaseUrl;
    const storedModels = (ctx.stored?.models ?? []).filter(
      (m) => m && typeof m.id === "string" && (!m.provider || m.provider === PROVIDER_ID),
    );

    // ---- Phase 1: cache-only restore (runs on every runtime creation) ----
    if (!ctx.allowNetwork) {
      if (!storedModels.length) {
        const baked = [...SNAPSHOT_MODELS, ...SNAPSHOT_ALIAS_MODELS].map((m) => normalize(m));
        return baked.length ? baked : undefined;
      }
      // Ids a previous SUCCESSFUL live check found retired must not come back,
      // neither from the store nor from the curated file.
      const retired = retiredIds(options.agentDir);
      const alive = (m: LiveModelConfig) => !retired.has(m.id);
      const liveStored = storedModels.filter(alive);
      const liveCurated = curated.filter(alive);
      const ids: string[] = [];
      for (const m of [...liveStored, ...liveCurated]) if (!ids.includes(m.id)) ids.push(m.id);
      const merged = ids.map((id) => {
        const storedEntry = liveStored.find((m) => m.id === id);
        return normalize(curatedById.get(id) ?? (storedEntry as LiveModelConfig));
      });
      if (ctx.signal.aborted) return undefined;
      if (!sameModels(merged, storedModels)) {
        const ok = await ctx.publish({
          persist: { models: merged, checkedAt: ctx.stored?.checkedAt },
        });
        if (!ok || ctx.signal.aborted) return undefined;
      }
      return merged;
    }

    // ---- Phase 2: live membership (network + credential) ----
    const key = ctx.credential?.type === "api_key" ? ctx.credential.key : undefined;
    if (!key) return undefined;

    const catalog = await fetchLiveCatalog(baseUrl, key, ctx.signal);
    if (!catalog || ctx.signal.aborted) return undefined;

    // This fetch SUCCEEDED, so it is authoritative about membership AND about
    // which listed ids actually have a healthy route for this key.
    reconcileRetired(options.agentDir, catalog, [...storedModels, ...curated]);
    const retired = retiredIds(options.agentDir);

    const storedById = new Map(storedModels.map((m) => [m.id, m]));
    const bounds = catalogBounds(catalog.models);
    const out: LiveModelConfig[] = [];

    for (const listing of catalog.models) {
      if (ctx.signal.aborted) return undefined;
      // `not-routable` is a retirement signal in its own right: the id is listed
      // but every request would 404, so publishing it recreates the ghost.
      if (listing.routeable === false || retired.has(listing.id)) continue;

      const known = curatedById.get(listing.id);
      if (known) {
        out.push(known); // curated values are never overwritten
        continue;
      }
      const previous = storedById.get(listing.id);
      if (previous) {
        out.push(normalize(previous)); // already built in a past session
        continue;
      }
      // Brand-new id: probe only what the gateway does not declare.
      const probed =
        options.probe === false ? undefined : await probeNewModel(listing, baseUrl, key, ctx.signal);
      if (ctx.signal.aborted) return undefined;
      out.push(probed ?? gatewayModel(listing));
    }

    for (const alias of catalog.aliases) {
      if (ctx.signal.aborted) return undefined;
      const known = curatedById.get(alias.id);
      if (known) {
        out.push(known);
        continue;
      }
      const previous = storedById.get(alias.id);
      out.push(previous ? normalize(previous) : aliasModel(alias, bounds));
    }

    const persisted = await ctx.publish({ persist: { models: out, checkedAt: Date.now() } });
    if (!persisted || ctx.signal.aborted) return undefined;

    // Maintenance-only, and only after publish so the catalog is never delayed.
    if (truthyEnv(options.reprobeEnv ?? "PI_ENCLAVE_REPROBE")) {
      await runReprobeAudit({
        agentDir: options.agentDir,
        baseUrl,
        key,
        signal: ctx.signal,
        curated,
        catalog,
      });
    }

    return out;
  };
}