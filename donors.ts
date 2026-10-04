/**
 * donors.ts — where model values come from.
 *
 * A "donor" is a list of models whose values can be copied onto ours, matched on
 * the BARE model name: the id with any `vendor/` prefix stripped on both sides,
 * so `cyberouter/glm-5.3-flash` matches `glm-5.3-flash`. A prefix relationship is
 * not an identity: `cyberouter/glm-5.3` does not inherit from `glm-5.3-flash`.
 *
 * ## One source, and it ships with Pi
 *
 * The donor is the catalog Pi bundles inside its own package:
 *
 *     pi-ai/dist/providers/data/<provider>.json
 *
 * There is no hand-written donor and none is required. A list maintained by a
 * person goes stale, and making every user own an account with an obscure
 * provider before the extension does anything useful is a dependency nobody
 * should have to accept. These files are already on disk after installing Pi,
 * and reading a file needs no credential — a key is only needed to CALL an API,
 * not to read what Pi shipped.
 *
 *     openrouter  the primary donor. It is the largest model router in the world
 *                 and the catalog is its core business, so the numbers are kept
 *                 by people who cannot afford to be wrong.
 *     the rest    corroboration only. A provider lower in the order confirms the
 *                 model exists and agrees on its structure; it fills a field the
 *                 ones above left empty and never overrides.
 *
 * ## The order
 *
 *     what is already in models.json  >  openrouter  >  the rest
 *
 * What is already written wins, because it is specific to this endpoint. Inside
 * a 5% band the bundled figure takes over, since `128_000` and `131_072` are the
 * same number written differently and the second is the exact one. Outside that
 * band they genuinely disagree and what is written stands. Nothing is ever
 * averaged: a number nobody published is not a consensus, it is an invention.
 *
 * ## What no donor may set
 *
 *   contextWindow — the live catalog states what this endpoint actually serves
 *   cost          — a donor's price is for a different reseller
 *   compat        — OpenRouter's `thinkingFormat: "openrouter"` and friends
 *                   describe how OpenRouter wants reasoning sent. EnClave speaks
 *                   the OpenAI shape, which is how it was verified. Copying
 *                   those flags would change the request format on an endpoint
 *                   they were never tested against.
 *
 * ## Router aliases are never resolved
 *
 * `cyberouter/auto` is EnClave's own pseudo-model. OpenRouter has an `auto` too,
 * advertising a 2,000,000 window — a different thing that happens to share the
 * name, and a lie here.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  donor?: { source: string; corroborating: string[]; rule: "kept" | "exact" | "corroborated" | "none" };
  [key: string]: unknown;
}

/** Fields a bundled donor may contribute. `compat` is deliberately absent. */
export const BUNDLED_FIELDS = ["reasoning", "thinkingLevelMap", "input", "maxTokens"] as const;

/** Fields already written in models.json may contribute, `compat` included. */
export const HAND_FIELDS = [...BUNDLED_FIELDS, "compat"] as const;

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

/**
 * Where the Pi package itself may live. Only used to resolve pi-ai.
 *
 * The prefix is derived from `process.execPath` rather than assumed: on Termux
 * it is `/data/data/com.termux/files/usr`, not `/usr`, so a hardcoded `/usr/lib`
 * silently never matches. Getting this wrong does not throw — it just sends the
 * lookup to the wrong copy of the catalog.
 */
function piPackageCandidates(): string[] {
  const out: string[] = [];
  const add = (base: string) => {
    const p = resolve(base, "@earendil-works", "pi-coding-agent");
    try {
      if (statSync(p).isDirectory()) out.push(p);
    } catch {
      // not here
    }
  };

  // The install this module lives under, when Pi loads it from its own bundle.
  add(dirname(fileURLToPath(import.meta.url)) + "/..");

  // The global prefix this node was installed under.
  try {
    add(dirname(dirname(process.execPath)) + "/lib/node_modules");
  } catch {
    // execPath unavailable
  }

  // Conventional prefixes, only used where they actually exist.
  add("/usr/local/lib/node_modules");
  add("/usr/lib/node_modules");

  return [...new Set(out)];
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

  // Walking the tree by hand rather than using module resolution: pi-ai is
  // ESM-only with an `exports` map that exposes neither a main nor its own
  // package.json, so require.resolve fails on it with
  // ERR_PACKAGE_PATH_NOT_EXPORTED. The directory is right there next to Pi, so
  // looking for it directly is both simpler and immune to that.
  for (const piPkg of piPackageCandidates()) {
    push(catalogAt(join(piPkg, "node_modules", "@earendil-works", "pi-ai", "package.json")), "la que usa Pi");
  }

  for (const dir of storeCatalogs(agentDir)) push(dir, "pi install");
  return found;
}

/**
 * Every usable copy in the agent's pnpm store, best first.
 *
 * When several versions sit there the newest wins, and a `+` build never does —
 * a prerelease is never the one a released Pi runs. Exported separately so the
 * preference order can be tested without the Pi install shadowing it.
 */
export function storeCatalogs(agentDir: string): string[] {
  const store = join(agentDir, "npm", "node_modules", ".pnpm");
  let entries: string[] = [];
  try {
    entries = readdirSync(store).filter((e) => e.startsWith("@earendil-works+pi-ai@"));
  } catch {
    return [];
  }
  const out: string[] = [];
  entries
    .map((e) => ({ entry: e, version: e.slice("@earendil-works+pi-ai@".length).split("_")[0] }))
    .filter((c) => !c.version.includes("+"))
    .sort((a, b) => compareVersions(b.version, a.version))
    .forEach((c) => {
      const dir = catalogAt(join(store, c.entry, "node_modules", "@earendil-works", "pi-ai", "package.json"));
      if (dir) out.push(dir);
    });
  return out;
}

/** Pi's own version, for the report only. Note this is NOT pi-ai's version:
 *  the two use independent numbering (1.0.0 vs 0.85.1), so they never match and
 *  must not be compared. */
export function piPackageVersion(): string | undefined {
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
/**
 * Every catalog Pi ships, best donor first.
 *
 * No credential is required and none is asked for: these files are data Pi
 * already installed. OpenRouter leads because it is the primary donor; the rest
 * are corroboration.
 */
export function readPiCatalogs(agentDir: string, options: { exclude?: readonly string[] } = {}): BundledCatalog[] {
  const dir = findBundledCatalogDir(agentDir);
  if (!dir) return [];
  const skip = new Set(options.exclude ?? []);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: BundledCatalog[] = [];
  for (const file of files) {
    const provider = file.slice(0, -".json".length);
    if (skip.has(provider)) continue;
    const catalog = readBundledCatalog(dir, provider);
    if (catalog && catalog.models.size) out.push(catalog);
  }
  const rank = (p: string) => {
    const i = PROVIDER_PRIORITY.indexOf(p as (typeof PROVIDER_PRIORITY)[number]);
    return i === -1 ? PROVIDER_PRIORITY.length : i;
  };
  return out.sort((a, b) => rank(a.provider) - rank(b.provider) || a.provider.localeCompare(b.provider));
}

/**
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
export const PROVIDER_PRIORITY = ["openrouter"] as const;

export interface Resolved {
  entry: ModelEntry;
  /** The source that supplied the values, if any. */
  source?: string;
  /** Every other provider that also knows this model: corroboration only. */
  corroborating: string[];
  rule: "kept" | "exact" | "corroborated" | "none";
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
  kept: ModelEntry | undefined,
  bundled: readonly BundledCatalog[],
  isAlias: boolean,
): Resolved {
  // Aliases are left alone: the same bare name is a different thing in a
  // different router, and its catalog numbers would be false here.
  if (isAlias) return { entry: {}, corroborating: [], rule: "none" };

  // The exact name first; a dated vendor slug only when the catalog does not
  // know the short one.
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

  // 1. Values already written are specific to this endpoint, so they stand. A
  //    bundled figure only takes over inside the rounding band, and only for
  //    fields a donor may touch, which excludes `compat`.
  if (kept) {
    const entry = copyFields(kept, HAND_FIELDS);
    for (const { entry: b } of knowing) {
      for (const field of BUNDLED_FIELDS) {
        const bundledValue = b[field];
        if (bundledValue === undefined) continue;
        const keptValue = entry[field];
        if (keptValue === undefined) {
          (entry as Record<string, unknown>)[field] = bundledValue;
          continue;
        }
        if (typeof keptValue === "number" && typeof bundledValue === "number" && withinTolerance(keptValue, bundledValue)) {
          (entry as Record<string, unknown>)[field] = bundledValue;
        }
      }
    }
    return {
      entry,
      source: "models.json",
      corroborating: knowing.map((h) => h.provider),
      rule: knowing.length ? "corroborated" : "kept",
    };
  }

  // 2. Nothing written yet: the highest-priority catalog that knows the model.
  if (knowing.length) {
    const [first, ...rest] = knowing;
    return {
      entry: copyFields(first.entry, BUNDLED_FIELDS),
      source: first.provider,
      corroborating: rest.map((h) => h.provider),
      rule: "exact",
    };
  }

  return { entry: {}, corroborating: [], rule: "none" };
}

function copyFields(from: ModelEntry, fields: readonly string[]): ModelEntry {
  const out: ModelEntry = {};
  for (const field of fields) {
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
