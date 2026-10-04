/**
 * donors.ts — every source of model values, in one readable place.
 *
 * A "donor" is some other list of models whose values we can copy onto ours,
 * matched on the BARE model name: the id with any `vendor/` prefix stripped on
 * both sides, so `cyberouter/glm-5.3-flash` matches `glm-5.3-flash`.
 *
 * There are two kinds, and they are NOT equal in authority.
 *
 *   1. HAND-WRITTEN — `providers.opendesign` in `models.json`. A person chose
 *      those numbers. This is the top authority, full stop. A rounded hand
 *      value stays.
 *
 *   2. BUNDLED — the catalogs Pi ships inside its own package, at
 *      `pi-ai/dist/providers/data/<provider>.json`. Pi rewrites them on every
 *      update, they cover 39 providers, and they are the only donors available
 *      for a provider nobody has configured by hand. These are consulted only
 *      for providers that are ACTIVE (a credential exists in `auth.json`),
 *      because an inactive provider's models are not reachable anyway.
 *
 * Together they complement each other, and when two bundled catalogs disagree
 * the value is averaged. They are independent companies describing the same
 * third-party model, so a disagreement is two opinions and not a fact — and the
 * midpoint is the spot both have some claim to.
 *
 * A bundled value AGREES with a hand value when it is within `ROUNDING_TOLERANCE`
 * (the hand value was rounded by a person, so `128_000` and `131_072` are the
 * same number written differently). It is then allowed to replace it, because
 * it is the exact figure. Outside that band they genuinely differ, and the hand
 * value wins.
 *
 * Two things are never copied from any donor, because they describe the
 * endpoint rather than the model:
 *
 *   contextWindow — the live catalog states what it actually serves
 *   cost          — a donor's price is for a different reseller
 *
 * And one class of id is never copied onto: ROUTER ALIASES. `cyberouter/auto`
 * is EnClave's own pseudo-model; OpenRouter's `auto` is a different thing that
 * happens to share the name, and it advertises a 2,000,000 window that would be
 * a lie here. Aliases stay vanilla.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
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
  /** Set by the sync script: which donors contributed, and how. */
  donor?: { sources: string[]; rule: "hand" | "exact" | "midpoint" };
  [key: string]: unknown;
}

/** Fields a donor may contribute. */
export const DONOR_FIELDS = [
  "reasoning",
  "thinkingLevelMap",
  "input",
  "maxTokens",
  "compat",
] as const;

/** The two numeric fields that get averaged between bundled catalogs. */
const AVERAGED_FIELDS = ["maxTokens"] as const;

/**
 * How close a hand-written value must be to a bundled one to count as the same
 * number. `128_000` vs `131_072` is 2.3%; `232_000` vs `384_000` is 66%.
 */
export const ROUNDING_TOLERANCE = 0.05;

export function bareName(id: string): string {
  const i = id.lastIndexOf("/");
  return i === -1 ? id : id.slice(i + 1);
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// ---------------------------------------------------------------------------
// Where Pi keeps its bundled catalogs
// ---------------------------------------------------------------------------

/**
 * Find `pi-ai/dist/providers/data` without hardcoding the version.
 *
 * The directory is named `@earendil-works+pi-ai@<version>_<dependency hash>`,
 * so the hash changes on every Pi update and any stored path dies with it. It
 * sits under the pnpm store beneath the agent directory; this walks that store
 * rather than guessing a depth.
 */
export function findBundledCatalogDir(agentDir: string): string | undefined {
  const root = join(agentDir, "npm", "node_modules", ".pnpm");
  let entries: string[];
  try {
    entries = readdirSync(root).filter((e) => e.startsWith("@earendil-works+pi-ai@"));
  } catch {
    return undefined;
  }
  for (const dir of entries) {
    const candidate = join(root, dir, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data");
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // try the next one
    }
  }
  return undefined;
}

/** Provider ids that have a credential in `auth.json`. */
export function activeProviders(agentDir: string): Set<string> {
  try {
    const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")) as Record<string, unknown>;
    return new Set(Object.keys(auth));
  } catch {
    return new Set();
  }
}

export interface BundledCatalog {
  provider: string;
  /** bare name -> entry */
  models: Map<string, ModelEntry>;
}

/** Read one bundled catalog. The JSON is keyed by API, then by model id. */
export function readBundledCatalog(
  catalogDir: string,
  provider: string,
): BundledCatalog | undefined {
  let raw: Record<string, Record<string, ModelEntry>>;
  try {
    raw = JSON.parse(readFileSync(join(catalogDir, `${provider}.json`), "utf8"));
  } catch {
    return undefined;
  }
  const models = new Map<string, ModelEntry>();
  for (const byApi of Object.values(raw)) {
    if (!byApi || typeof byApi !== "object") continue;
    for (const entry of Object.values(byApi)) {
      if (!entry || typeof entry.id !== "string") continue;
      // "free" models are deliberately excluded: they routinely ship with
      // capabilities cut down, so their numbers describe a reduced product.
      if (/free$/i.test(entry.id)) continue;
      const bare = bareName(entry.id);
      if (!models.has(bare)) models.set(bare, entry);
    }
  }
  return { provider, models };
}

/** Every bundled catalog belonging to an active provider, free ids removed. */
export function readActiveBundledCatalogs(
  agentDir: string,
  options: { exclude?: readonly string[] } = {},
): BundledCatalog[] {
  const dir = findBundledCatalogDir(agentDir);
  if (!dir) return [];
  const skip = new Set(options.exclude ?? []);
  const out: BundledCatalog[] = [];
  for (const provider of activeProviders(agentDir)) {
    if (skip.has(provider)) continue;
    const catalog = readBundledCatalog(dir, provider);
    if (catalog && catalog.models.size) out.push(catalog);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolving one model
// ---------------------------------------------------------------------------

export interface Resolved {
  entry: ModelEntry;
  sources: string[];
  rule: "hand" | "exact" | "midpoint" | "none";
}

const withinTolerance = (a: number, b: number) =>
  Math.abs(a - b) <= ROUNDING_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));

/**
 * Resolve one model's values from the hand layer and the bundled catalogs.
 *
 * `hand` is `providers.opendesign` (or whatever provider the user wrote by
 * hand). `bundled` is every active bundled catalog that has this bare name.
 */
export function resolveModel(
  bare: string,
  hand: ModelEntry | undefined,
  bundled: readonly BundledCatalog[],
  isAlias: boolean,
): Resolved {
  // Aliases are left alone: the same bare name is a different thing in a
  // different router, and its catalog numbers would be false here.
  if (isAlias) {
    return { entry: {}, sources: [], rule: "none" };
  }

  const hits = bundled
    .map((c) => ({ provider: c.provider, entry: c.models.get(bare) }))
    .filter((h): h is { provider: string; entry: ModelEntry } => !!h.entry);

  // 1. No bundled source: the hand layer, or nothing.
  if (!hits.length) {
    if (!hand) return { entry: {}, sources: [], rule: "none" };
    return { entry: copyFields(hand), sources: ["hand"], rule: "hand" };
  }

  const sources = hits.map((h) => h.provider);

  // 2. Bundled sources disagree: average the numeric fields, and prefer an
  // exact hand figure for the rest when there is one.
  let base: ModelEntry;
  let rule: Resolved["rule"] = "exact";
  if (hits.length === 1) {
    base = { ...hits[0].entry };
  } else {
    rule = "midpoint";
    base = { ...hits[0].entry };
    for (const field of AVERAGED_FIELDS) {
      const values = hits.map((h) => num(h.entry[field])).filter((v): v is number => v !== undefined);
      if (values.length) (base as Record<string, unknown>)[field] = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
    }
  }

  const out = copyFields(base);

  // 3. The hand layer outranks a bundled value unless the two agree to within
  // rounding — a person writing 128_000 for 131_072 is the same number, so the
  // exact figure is an improvement, not a contradiction.
  if (hand) {
    for (const field of DONOR_FIELDS) {
      const handValue = hand[field];
      if (handValue === undefined) continue;
      const bundledValue = out[field];
      if (bundledValue === undefined) {
        (out as Record<string, unknown>)[field] = handValue;
        continue;
      }
      if (typeof handValue === "number" && typeof bundledValue === "number") {
        if (withinTolerance(handValue, bundledValue)) {
          (out as Record<string, unknown>)[field] = bundledValue; // exact wins over rounded
        } else {
          (out as Record<string, unknown>)[field] = handValue; // genuine disagreement
        }
        continue;
      }
      (out as Record<string, unknown>)[field] = handValue;
    }
    if (!sources.includes("hand")) sources.push("hand");
  }

  return { entry: out, sources, rule: rule === "exact" && hand ? "exact" : rule };
}

function copyFields(from: ModelEntry): ModelEntry {
  const out: ModelEntry = {};
  for (const field of DONOR_FIELDS) {
    if (from[field] !== undefined) (out as Record<string, unknown>)[field] = from[field];
  }
  return out;
}
