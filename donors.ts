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
 * They are consulted in a strict order, and the first one that knows the model
 * supplies its values:
 *
 *     hand-written  >  openrouter  >  every other active provider
 *
 * OpenRouter ranks second because it is the largest model router and its
 * catalog is its core business, maintained for years. The rest are NOT
 * competing sources: they corroborate. A provider lower in the order only fills
 * a field the ones above it left empty, and is otherwise reported as agreement.
 * Nothing is ever averaged — a number nobody published is not a consensus, it
 * is an invention.
 *
 * A hand value AGREES with a lower-priority one when it is within
 * `ROUNDING_TOLERANCE` (the hand value was rounded by a person, so `128_000`
 * and `131_072` are the same number written differently). The exact figure then
 * wins, because it is the same number with more precision. Outside that band
 * they genuinely differ, and the hand value stands.
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

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
  /**
   * Set by the sync script. `source` supplied the values; `corroborating`
   * lists the other providers that also know the model and agree it exists.
   */
  donor?: { source: string; corroborating: string[]; rule: "hand" | "exact" | "corroborated" | "none" };
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

/**
 * How close a hand-written value must be to a bundled one to count as the same
 * number. `128_000` vs `131_072` is 2.3%; `232_000` vs `384_000` is 66%.
 */
export const ROUNDING_TOLERANCE = 0.05;

export function bareName(id: string): string {
  const i = id.lastIndexOf("/");
  return i === -1 ? id : id.slice(i + 1);
}

/**
 * EnClave sells a model under a short name; a catalog lists the same weights
 * under the dated slug the vendor publishes. These are the same model, so the
 * dated slug is looked up when the short one finds nothing.
 *
 * Kept as data, not a rule: each line is a fact about one model, not a general
 * "strip the date" heuristic. Stripping dates automatically would be wrong —
 * `deepseek-v4-flash` and `deepseek-v4-flash-0731` are different checkpoints,
 * and so is `qwen3.8-max` from `qwen3.8-max-0902`.
 */
export const NAME_ALIASES: Record<string, readonly string[]> = {
  "qwen3.8-max": ["qwen3.8-max-0902"],
  "nemotron-ultra": ["nemotron-3-ultra-550b-a55b"],
};

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
export interface CatalogLocation {
  dir: string;
  /** Which copy this is, for the report. */
  origin: "pi install" | "global install";
}

function catalogAt(piAiPackage: string): string | undefined {
  const candidate = join(dirname(piAiPackage), "dist", "providers", "data");
  try {
    if (statSync(candidate).isDirectory()) return candidate;
  } catch {
    return undefined;
  }
  return undefined;
}

/** Where the Pi package itself may live. Only used to resolve pi-ai. */
function piPackageCandidates(): string[] {
  const out = [
    // Resolved from this process, which is Pi's own bundle when Pi loads us.
    fileURLToPath(new URL("..", import.meta.url)),
    "/usr/lib/node_modules/@earendil-works/pi-coding-agent",
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
  ];
  try {
    out.push(dirname(dirname(process.execPath)) + "/../lib/node_modules/@earendil-works/pi-coding-agent");
  } catch {
    // execPath unavailable
  }
  return [...new Set(out.map((p) => resolve(p)))];
}

/**
 * Find Pi's bundled catalogs without depending on a version or a hash.
 *
 * The directory is named `@earendil-works+pi-ai@<version>_<dependency hash>`, so
 * any stored path dies on the next update. Only stable prefixes are used and the
 * tree is searched at run time.
 *
 * Order matters, because there can be more than one copy of pi-ai and reading
 * the wrong one fails silently:
 *
 *   1. ASK NODE. `createRequire` from Pi's own package resolves the exact pi-ai
 *      that Pi loads its models from. That is ground truth, not a guess.
 *   2. FALL BACK to the agent's pnpm store, which is where `pi install npm:…`
 *      puts things on this device. When several versions sit there, the one whose
 *      version matches Pi's package wins; otherwise the highest, never a `+` build.
 *
 * On this device step 1 currently fails: the global install of pi-ai is an empty
 * directory, so Pi resolves it from the agent's store. Both steps are kept
 * because either can be true after an update.
 */
export function findBundledCatalogs(agentDir: string): CatalogLocation[] {
  const found: CatalogLocation[] = [];
  const push = (dir: string | undefined, origin: CatalogLocation["origin"]) => {
    if (dir && !found.some((f) => f.dir === dir)) found.push({ dir, origin });
  };

  for (const piPkg of piPackageCandidates()) {
    try {
      const require = createRequire(join(piPkg, "package.json"));
      push(catalogAt(require.resolve("@earendil-works/pi-ai/package.json")), "la que usa Pi");
    } catch {
      // Pi does not resolve pi-ai from here.
    }
  }

  const store = join(agentDir, "npm", "node_modules", ".pnpm");
  let entries: string[] = [];
  try {
    entries = readdirSync(store).filter((e) => e.startsWith("@earendil-works+pi-ai@"));
  } catch {
    entries = [];
  }
  const piVersion = piPackageVersion();
  entries
    .map((e) => ({ entry: e, version: e.slice("@earendil-works+pi-ai@".length).split("_")[0] }))
    .filter((c) => !c.version.includes("+"))
    .sort((a, b) => {
      if (piVersion && a.version === piVersion) return -1;
      if (piVersion && b.version === piVersion) return 1;
      return compareVersions(b.version, a.version);
    })
    .forEach((c) => {
      try {
        push(catalogAt(join(store, c.entry, "node_modules", "@earendil-works", "pi-ai", "package.json")), "pi install");
      } catch {
        // not a usable copy
      }
    });

  return found;
}

function piPackageVersion(): string | undefined {
  for (const piPkg of piPackageCandidates()) {
    try {
      const pkg = JSON.parse(readFileSync(join(piPkg, "package.json"), "utf8")) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // try the next
    }
  }
  return undefined;
}

/** Numeric dotted comparison, so 0.9 sorts below 0.10. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number(n) || 0);
  const pb = b.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The catalogs to read, best location first. Never throws. */
export function findBundledCatalogDir(agentDir: string): string | undefined {
  return findBundledCatalogs(agentDir)[0]?.dir;
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
  // Strict order: the first provider that knows a model supplies its values.
  // The hand-written layer is passed separately and always outranks these.
  const rank = (p: string) => {
    const i = PROVIDER_PRIORITY.indexOf(p as (typeof PROVIDER_PRIORITY)[number]);
    return i === -1 ? PROVIDER_PRIORITY.length : i;
  };
  return out.sort((a, b) => rank(a.provider) - rank(b.provider) || a.provider.localeCompare(b.provider));
}

// ---------------------------------------------------------------------------
// Resolving one model
// ---------------------------------------------------------------------------

/**
 * Which provider's catalog outranks which. Anything not listed falls after
 * these, in the order they appear in auth.json.
 */
export const PROVIDER_PRIORITY = ["opendesign", "openrouter"] as const;

export interface Resolved {
  entry: ModelEntry;
  /** The source that supplied the values, if any. */
  source?: string;
  /** Every other provider that also knows this model: corroboration only. */
  corroborating: string[];
  rule: "hand" | "exact" | "corroborated" | "none";
}

const withinTolerance = (a: number, b: number) =>
  Math.abs(a - b) <= ROUNDING_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));

/**
 * Resolve one model's values, in strict priority order:
 *
 *     hand-written  >  openrouter  >  the rest of the active providers
 *
 * The first source that knows the model supplies its values. Every other source
 * that knows it is recorded as corroboration — it confirms the model exists and
 * agrees on its structure, but it never overrides a higher source. Nothing is
 * averaged.
 */
export function resolveModel(
  bare: string,
  hand: ModelEntry | undefined,
  bundled: readonly BundledCatalog[],
  isAlias: boolean,
): Resolved {
  // Aliases are left alone: the same bare name is a different thing in a
  // different router, and its catalog numbers would be false here.
  if (isAlias) return { entry: {}, corroborating: [], rule: "none" };

  // The exact name first; a dated slug only when the catalog does not know the
  // short one.
  const candidates = [bare, ...(NAME_ALIASES[bare] ?? [])];
  const knowing = bundled
    .map((c) => {
      for (const name of candidates) {
        const entry = c.models.get(name);
        if (entry) return { provider: c.provider, entry };
      }
      return undefined;
    })
    .filter((h): h is { provider: string; entry: ModelEntry } => h !== undefined);

  // 1. The hand layer, when it has the model. It is the top authority; lower
  //    sources only get to correct it within the rounding band, where they are
  //    the same number with more precision.
  if (hand) {
    const entry = copyFields(hand);
    const corroborating = knowing.map((h) => h.provider);
    for (const { provider, entry: b } of knowing) {
      for (const field of DONOR_FIELDS) {
        const bundledValue = b[field];
        if (bundledValue === undefined) continue;
        const handValue = entry[field];
        if (handValue === undefined) {
          (entry as Record<string, unknown>)[field] = bundledValue; // gap the hand layer left open
          continue;
        }
        if (typeof handValue === "number" && typeof bundledValue === "number" && withinTolerance(handValue, bundledValue)) {
          (entry as Record<string, unknown>)[field] = bundledValue; // same number, exact wins
        }
        // Otherwise the values genuinely differ and the hand value stands.
      }
      void provider;
    }
    return { entry, source: "hand", corroborating, rule: corroborating.length ? "corroborated" : "hand" };
  }

  // 2. No hand entry: the highest-priority bundled catalog that knows it.
  if (knowing.length) {
    const [first, ...rest] = knowing;
    return {
      entry: copyFields(first.entry),
      source: first.provider,
      corroborating: rest.map((h) => h.provider),
      rule: "exact",
    };
  }

  return { entry: {}, corroborating: [], rule: "none" };
}

function copyFields(from: ModelEntry): ModelEntry {
  const out: ModelEntry = {};
  for (const field of DONOR_FIELDS) {
    if (from[field] !== undefined) (out as Record<string, unknown>)[field] = from[field];
  }
  return out;
}

/**
 * Pi's extension loader treats EVERY `extensions/*.ts` file as an extension
 * factory and reports "does not export a valid factory function" otherwise.
 * This file is a helper imported by `index.ts`, so it needs a no-op default
 * export to load silently beside it.
 */
export default async function donorsHelper(): Promise<void> {}
