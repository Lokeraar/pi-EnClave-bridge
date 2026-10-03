#!/usr/bin/env node
/**
 * probe-models.mjs — maintain the EnClave catalog without hand-editing it.
 *
 * Re-runs the SAME probe the extension uses for brand-new ids, against models
 * the curated layer already knows, and prints a table plus the exact patch to
 * apply. It never writes anything: the diff IS the deliverable. A script that
 * silently rewrites your config is worse than one that makes you approve it.
 *
 * Unlike the sibling OpenDesign CLI, most rows here need NO probe at all —
 * EnClave declares context, price and routability itself. The probe is only
 * needed for reasoning levels and the output ceiling, so `--all` is opt-in and
 * the default run is free.
 *
 * Usage (from the package root):
 *   node --experimental-strip-types scripts/probe-models.mjs
 *   node --experimental-strip-types scripts/probe-models.mjs --all
 *   node --experimental-strip-types scripts/probe-models.mjs cyberouter/glm-5.3
 *   node --experimental-strip-types scripts/probe-models.mjs --all --json
 *
 * Flags:
 *   --all        also probe reasoning levels + output ceiling (costs tokens)
 *   --json       machine-readable output instead of the table
 *   --base-url   override the endpoint (default: models.json, then the built-in)
 *   --agent-dir  override ~/.pi/agent
 *
 * `--all` needs a reachable CHAT endpoint. EnClave's router currently answers
 * HTTP 500 to every chat request, so every probed row will come back
 * `probe-failed` — reported honestly rather than guessed around.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const {
  probeNewModel,
  fetchLiveCatalog,
  gatewayModel,
  aliasModel,
  catalogBounds,
  readCurated,
  retiredIds,
  ENCLAVE_BASE_URL,
  PROVIDER_ID,
} = await import(join(ROOT, "enclave-live.ts"));

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));

if (flag("--help")) {
  console.log(
    [
      "probe-models — inspect the live EnClave catalog and emit a patch",
      "",
      "  node --experimental-strip-types scripts/probe-models.mjs",
      "  node --experimental-strip-types scripts/probe-models.mjs --all",
      "  node --experimental-strip-types scripts/probe-models.mjs <model-id>...",
      "",
      "Flags: --all --json --base-url <url> --agent-dir <dir>",
    ].join("\n"),
  );
  process.exit(0);
}

const agentDir = opt("--agent-dir", join(homedir(), ".pi", "agent"));
const asJson = flag("--json");
const doProbe = flag("--all");

// ---------------------------------------------------------------- credential
function readModelsJson(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
  } catch {
    return {};
  }
}

const modelsJson = readModelsJson(agentDir);
const cfg = modelsJson?.providers?.[PROVIDER_ID] ?? {};
const baseUrl = opt("--base-url", cfg.baseUrl ?? ENCLAVE_BASE_URL);

let key = process.env.ENCLAVE_API_KEY?.trim() || cfg.apiKey?.trim();
if (!key) {
  console.error(
    `No API key found. Set ENCLAVE_API_KEY, or add providers.${PROVIDER_ID}.apiKey in ${join(agentDir, "models.json")}.`,
  );
  process.exit(2);
}

// ---------------------------------------------------------------- helpers
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-US") : "—");
const usd = (v) => (typeof v === "number" ? `$${v}` : "—");
const pad = (s, n) => String(s ?? "").padEnd(n);

function originOf(model, field) {
  return model?.provenance?.[field] ?? "?";
}

// ---------------------------------------------------------------- fetch
// A full probe is ~16 sequential requests per model (1 no-param + 6 levels +
// none + up to 8 ceiling candidates) at roughly a second each. Fourteen models
// is minutes of work, so the budget has to scale or the run aborts halfway and
// every remaining model is mislabelled "probe-failed".
const PROBE_TIMEOUT_MS = doProbe ? 15 * 60_000 : 60_000;
const signal = AbortSignal.any([AbortSignal.timeout(PROBE_TIMEOUT_MS)]);
const catalog = await fetchLiveCatalog(baseUrl, key, signal);
if (!catalog) {
  console.error(`GET ${baseUrl}/models failed — endpoint unreachable or unauthorized.`);
  process.exit(1);
}

if (doProbe) {
  console.error(`Probing ${catalog.models.length} models (~16 requests each); this takes minutes.\n`);
}

const curated = readCurated(agentDir).map((m) => ({ ...m, provenance: m.provenance }));
const curatedById = new Map(curated.map((m) => [m.id, m]));
const retired = retiredIds(agentDir);
const bounds = catalogBounds(catalog.models);

const selected = positional.length
  ? catalog.models.filter((m) => positional.includes(m.id))
  : catalog.models;

if (positional.length) {
  const missing = positional.filter((id) => !catalog.models.some((m) => m.id === id));
  for (const id of missing) {
    console.error(`  ! ${id} is not in the live catalog.`);
  }
}

// ---------------------------------------------------------------- probe
const rows = [];
for (const listing of selected) {
  if (listing.routeable === false) {
    rows.push({
      listing,
      built: gatewayModel(listing),
      observed: null,
      state: "not-routable",
    });
    continue;
  }
  if (!doProbe) {
    rows.push({ listing, built: gatewayModel(listing), observed: null, state: "gateway-only" });
    continue;
  }
  const probed = await probeNewModel(listing, baseUrl, key, signal);
  rows.push({
    listing,
    built: probed ?? gatewayModel(listing),
    observed: probed,
    state: probed ? "measured" : "probe-failed",
  });
}

const aliasRows = catalog.aliases.map((alias) => ({
  alias,
  built: curatedById.get(alias.id) ?? aliasModel(alias, bounds),
}));

// ---------------------------------------------------------------- output
if (asJson) {
  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        baseUrl,
        probed: doProbe,
        retired: [...retired],
        models: rows.map((r) => ({
          id: r.listing.id,
          state: r.state,
          routeable: r.listing.routeable,
          routeableEndpointCount: r.listing.routeableCount ?? null,
          endpointCount: r.listing.endpointCount ?? null,
          built: r.built,
          observed: r.observed,
        })),
        aliases: aliasRows.map((r) => ({ id: r.alias.id, task: r.alias.task, built: r.built })),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(`\nEnClave catalog — ${baseUrl}`);
console.log(`${catalog.models.length} models, ${catalog.aliases.length} aliases, ${retired.size} retired\n`);

console.log(
  pad("MODEL", 34) + pad("CTX", 11) + pad("IN $/M", 9) + pad("OUT $/M", 10) + pad("ROUTE", 8) + pad("STATE", 15) + "MAXTOK",
);
console.log("-".repeat(104));

for (const r of rows) {
  const m = r.built;
  console.log(
    pad(r.listing.id.replace(/^cyberouter\//, ""), 34) +
      pad(num(m.contextWindow), 11) +
      pad(usd(r.listing.pricingPrompt), 9) +
      pad(usd(r.listing.pricingCompletion), 10) +
      pad(
        r.listing.routeable === false
          ? "NO"
          : `${r.listing.routeableCount ?? "?"}/${r.listing.endpointCount ?? "?"}`,
        8,
      ) +
      pad(r.state, 15) +
      num(m.maxTokens),
  );
}

if (aliasRows.length) {
  console.log("\nRouter aliases (routed per request — context = catalog floor, price = catalog ceiling)");
  for (const r of aliasRows) {
    console.log(
      `  ${pad(r.alias.id.replace(/^cyberouter\//, ""), 32)}${pad(r.alias.task ?? "auto", 20)}ctx≤${num(r.built.contextWindow)}  ≤${usd(r.built.cost.input)}/$${r.built.cost.output}`,
    );
  }
}

if (retired.size) {
  console.log("\nRetired (excluded from the published catalog)");
  for (const id of retired) console.log(`  ${id}`);
}

// ---------------------------------------------------------------- patch
const fresh = [];
const drift = [];
for (const r of rows) {
  const known = curatedById.get(r.listing.id);
  if (r.state === "not-routable") continue;
  if (!known) {
    fresh.push(r.built);
    continue;
  }
  if (!r.observed) continue;
  const fields = ["contextWindow", "maxTokens", "thinkingLevelMap", "reasoning", "input"];
  const changed = fields.filter((f) => JSON.stringify(known[f]) !== JSON.stringify(r.observed[f]));
  if (changed.length) drift.push({ id: r.listing.id, changed, observed: r.observed });
}

console.log("");
if (fresh.length) {
  console.log(`— ${fresh.length} live model(s) with no curated entry. Add to enclave-curated.json:`);
  console.log(JSON.stringify({ models: fresh }, null, 2));
}
if (drift.length) {
  console.log(`— ${drift.length} curated model(s) drifted. Review, then update enclave-curated.json:`);
  for (const d of drift) console.log(`  ${d.id}: ${d.changed.join(", ")}`);
}
if (!fresh.length && !drift.length) {
  console.log("— curated layer is consistent with the live catalog. No patch needed.");
}

const failed = rows.filter((r) => r.state === "probe-failed").length;
if (failed) {
  console.log(
    `\n! ${failed} row(s) came back probe-failed: the router did not answer with a measurement.\n  Gateway values were kept for those; nothing was guessed.`,
  );
}
if (!doProbe) {
  console.log("\n  Reasoning levels and output ceilings are unprobed. Run with --all when the chat endpoint answers.");
}
console.log("");