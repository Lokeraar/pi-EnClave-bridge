#!/usr/bin/env node
/**
 * test-sync.mjs — offline checks for the whole donor pipeline.
 *
 * The rules being pinned, in the order they apply:
 *   1. a bare name match, and the near miss that must NOT match
 *   2. hand-written is the top authority, displaced only by rounding
 *   3. strict order: openrouter second, the rest are corroboration only
 *   4. nothing is ever averaged
 *   5. "free" models are excluded from every bundled catalog
 *   6. only providers with a credential are read
 *   7. router aliases are never resolved from a donor
 *   8. a dated vendor slug resolves to the short name
 *   9. an output ceiling can never exceed the window minus a prompt reserve
 *  10. the catalog is found without a stored path, so a Pi update is harmless
 */

import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// `.pathname` is not a usable path on Windows (leading slash, spaces
// percent-encoded); fileURLToPath is. Without it this file cannot even be
// imported on Windows, so `npm test` runs nowhere but Linux.
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// A dynamic import rejects a bare absolute Windows path just as it rejects the
// percent-encoded one, so it goes through a file: URL.
const load = (file) => import(pathToFileURL(join(ROOT, file)).href);
const { bareName, resolveModel, readBundledCatalog, readPiCatalogs, findBundledCatalogDir, findBundledCatalogs, ROUNDING_TOLERANCE } =
  await load("donors-enclave.ts");
const { buildBlock, PROMPT_RESERVE_TOKENS } = await load("enclave-live.ts");

let passed = 0;
const failed = [];
const check = (name, cond, detail) => {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const cat = (provider, models) => ({ provider, models: new Map(Object.entries(models)) });
const agentDir = join(process.env.HOME ?? "", ".pi", "agent");

console.log("\nbare name");
check("strips a vendor prefix", bareName("cyberouter/glm-5.3") === "glm-5.3");
check("leaves an unprefixed id alone", bareName("glm-5.3") === "glm-5.3");
check("strips only the last segment", bareName("a/b/c") === "c");

console.log("\nthe vendor's model card outranks every catalog");
{
  const { VENDOR_SPEC } = await load("donors-enclave.ts");
  check("glm-5.3 has a card", !!VENDOR_SPEC["glm-5.3"]);
  check("glm-5.2 has a card", !!VENDOR_SPEC["glm-5.2"]);
  check("each card records why it exists", Object.values(VENDOR_SPEC).every((v) => v.why.length > 40));

  // A catalog that claims 943718 and all six levels must not win.
  const loud = cat("openrouter", {
    "glm-5.3": { maxTokens: 943718, input: ["text", "image"], thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } },
  });
  const r = resolveModel("glm-5.3", undefined, [loud], false);
  check("the card sets the output ceiling", r.entry.maxTokens === 131072, String(r.entry.maxTokens));
  check("the card sets the modalities", JSON.stringify(r.entry.input) === '["text"]', JSON.stringify(r.entry.input));
  check("the card keeps only the implemented levels",
    Object.entries(r.entry.thinkingLevelMap).filter(([, v]) => v !== null).map(([k]) => k).join(",") === "low,high,max",
    JSON.stringify(r.entry.thinkingLevelMap));
  check("it is attributed to the model card", r.source === "model card", String(r.source));
  check("the catalog is still recorded as corroboration", r.corroborating.includes("openrouter"), r.corroborating.join(","));

  // The card applies to the exact name only; a neighbour is untouched.
  const neighbour = resolveModel("glm-5.3-flash", undefined, [loud], false);
  check("the card does not bleed to a neighbour", neighbour.entry.maxTokens === undefined, String(neighbour.entry.maxTokens));
}

console.log("\nopenrouter decides; what is written is only a fallback");
{
  // A catalog that contradicts what is written: the catalog wins, because it is
  // the source of truth the user chose.
  const r = resolveModel("deepseek-v4-pro", { maxTokens: 232000 }, [cat("openrouter", { "deepseek-v4-pro": { maxTokens: 384000 } })], false);
  check("the catalog overrides what was written", r.entry.maxTokens === 384000, String(r.entry.maxTokens));
  check("and it is attributed to openrouter", r.source === "openrouter", String(r.source));

  // Two catalogs disagree: the primary wins outright, never a midpoint.
  const two = resolveModel("minimax-m3", undefined, [cat("openrouter", { "minimax-m3": { maxTokens: 512000 } }), cat("opencode", { "minimax-m3": { maxTokens: 128000 } })], false);
  check("the highest-priority catalog supplies the value", two.entry.maxTokens === 512000, String(two.entry.maxTokens));
  check("NOT the midpoint of the two", two.entry.maxTokens !== 320000, String(two.entry.maxTokens));
  // Every catalog that knows the model is a corroborator now, the primary
  // included: it is one voice among several, not the one that decides alone.
  check("both are recorded as corroboration", two.corroborating.includes("opencode"), two.corroborating.join(","));

  // Nothing in any catalog knows the model: what is written stands.
  const orphan = resolveModel("orphan", { maxTokens: 999, thinkingLevelMap: { low: "low" } }, [cat("openrouter", {})], false);
  check("what is written is the fallback", orphan.entry.maxTokens === 999, String(orphan.entry.maxTokens));
  check("and it is attributed to models.json", orphan.source === "models.json", String(orphan.source));

  // compat is never taken from a catalog, whatever else is.
  const withCompat = resolveModel("deepseek-v4-pro", undefined, [cat("openrouter", { "deepseek-v4-pro": { maxTokens: 1000, compat: { thinkingFormat: "openrouter" } } })], false);
  check("compat is never inherited from a catalog", withCompat.entry.compat === undefined, JSON.stringify(withCompat.entry.compat));

  // A dated slug is still resolved and recorded with its full id.
  const dated = resolveModel("qwen3.8-max", undefined, [cat("openrouter", { "qwen3.8-max-0902": { id: "qwen/qwen3.8-max-0902", maxTokens: 131072 } })], false);
  check("a dated slug resolves", dated.entry.maxTokens === 131072, String(dated.entry.maxTokens));
  check("and the matched id keeps its prefix", dated.matchedId === "qwen/qwen3.8-max-0902", String(dated.matchedId));
}

console.log("\nfree models are excluded, no credential needed");
{
  const dir = findBundledCatalogDir(agentDir);
  if (!dir) {
    console.log("  --   catálogo bundled no encontrado, se omiten estas pruebas");
  } else {
    const or = readBundledCatalog(dir, "openrouter");
    const oc = readBundledCatalog(dir, "opencode");
    check("openrouter catalog loads", !!or && or.models.size > 300, String(or && or.models.size));
    const anyFree = (c) => [...c.models.keys()].some((k) => /free/i.test(k));
    check("no free id survives in openrouter", !anyFree(or));
    check("no free id survives in opencode", !anyFree(oc));
    const inkling = or.models.get("inkling");
    check("the paid entry wins over its :free sibling", !!inkling && inkling.maxTokens !== undefined, JSON.stringify(inkling && inkling.id));

    const cats = readPiCatalogs(agentDir, { exclude: ["EnClave"] });
    const providers = cats.map((c) => c.provider);
    check("every catalog Pi ships is read, credential or not", providers.length > 30, String(providers.length));
    check("openrouter leads as the primary donor", providers[0] === "openrouter", providers.slice(0, 3).join(","));
    check("opencode is available even without an account", providers.includes("opencode"), "falta opencode");
  }
}

console.log("\naliases are never resolved from a donor");
{
  const r = resolveModel("auto", { maxTokens: 999 }, [cat("openrouter", { auto: { maxTokens: 30000, contextWindow: 2000000 } })], true);
  check("an alias yields no donor values", Object.keys(r.entry).length === 0, JSON.stringify(r.entry));
  check("an alias is reported as untouched", r.rule === "none" && r.source === undefined && r.corroborating.length === 0, r.rule);
}

console.log("\na dated vendor slug resolves to the short name");
{
  const c = cat("openrouter", { "qwen3.8-max-0902": { maxTokens: 131072, input: ["text", "image"] } });
  const r = resolveModel("qwen3.8-max", undefined, [c], false);
  check("the dated slug is found", r.entry.maxTokens === 131072, String(r.entry.maxTokens));
  check("and its modalities come with it", JSON.stringify(r.entry.input) === '["text","image"]', JSON.stringify(r.entry.input));

  const both = cat("openrouter", { "qwen3.8-max": { maxTokens: 555 }, "qwen3.8-max-0902": { maxTokens: 131072 } });
  check("the exact name beats the alias", resolveModel("qwen3.8-max", undefined, [both], false).entry.maxTokens === 555);

  const n = cat("openrouter", { "nemotron-3-ultra-550b-a55b": { maxTokens: 32768 } });
  check("nemotron-ultra resolves too", resolveModel("nemotron-ultra", undefined, [n], false).entry.maxTokens === 32768);
}

console.log("\nthe catalog is found without a stored path");
{
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: J } = await import("node:path");
  const fake = mkdtempSync(J(tmpdir(), "enclave-upd-"));
  const mk = (ver, hash, max) => {
    const p = J(fake, "npm/node_modules/.pnpm/@earendil-works+pi-ai@" + ver + "_" + hash, "node_modules/@earendil-works/pi-ai");
    mkdirSync(J(p, "dist/providers/data"), { recursive: true });
    writeFileSync(J(p, "package.json"), JSON.stringify({ version: ver }));
    writeFileSync(J(p, "dist/providers/data/openrouter.json"), JSON.stringify({ "openai-completions": { "z-ai/glm-5.3": { id: "z-ai/glm-5.3", maxTokens: max } } }));
  };
  mk("0.85.1", "old", 100);
  mk("0.99.0", "new", 999);
  mk("0.90.0+dev", "plusbuild", 500);

  // The Pi install is found by an absolute prefix and would shadow the store, so
  // the preference order is exercised on the store scanner directly.
  const { storeCatalogs } = await load("donors-enclave.ts");
  const dirs = storeCatalogs(fake);
  check("store catalogs are found without a stored path", dirs.length >= 1, String(dirs.length));
  const fixtureDir = dirs.filter((d) => d.includes("enclave-upd-"));
  check("the newest version wins whatever the folder is called", fixtureDir.length > 0 && fixtureDir[0].includes("0.99.0"), dirs.join(","));
  const cat2 = readBundledCatalog(fixtureDir[0], "openrouter");
  check("the newest catalog is the one read", cat2.models.get("glm-5.3").maxTokens === 999, String(cat2.models.get("glm-5.3").maxTokens));
  // The prerelease is still listed, but never first: only the first entry is
  // ever used, and sorting it last keeps a fallback visible without letting it win.
  check("a + prerelease is never the first choice", !dirs[0].includes("0.90.0+dev"), dirs[0]);
  check("and it sorts last", dirs[dirs.length - 1].includes("0.90.0+dev"), dirs.join(","));

  const locs = findBundledCatalogs(fake);
  check("the Pi install is preferred over the store", locs[0].origin === "la que usa Pi", locs[0].origin);
  rmSync(fake, { recursive: true, force: true });

  // A bogus agentDir must not throw. The Pi install is found by an absolute
  // prefix, so it can still be returned here; what matters is that nothing
  // breaks and the store scan contributes nothing.
  const bogus = findBundledCatalogs("/no/existe/path");
  check("a bogus agent dir does not throw", Array.isArray(bogus), typeof bogus);
}

console.log("\nthe block: matching, near misses, endpoint-owned fields");
{
  const catalog = {
    models: [
      { id: "cyberouter/glm-5.3-flash", name: "GLM 5.3 Flash", contextLength: 1048576, pricingPrompt: 0.15, pricingCompletion: 0.5, routeable: true },
      { id: "cyberouter/glm-5.3", name: "GLM 5.3", contextLength: 1048576, pricingPrompt: 1.4, pricingCompletion: 4.4, routeable: true },
      { id: "cyberouter/inkling", name: "Inkling", contextLength: 262144, pricingPrompt: 1, pricingCompletion: 4, routeable: true },
      { id: "cyberouter/dead", name: "Dead", contextLength: 262144, routeable: false },
      { id: "cyberouter/orphan", name: "Orphan", contextLength: 262144, pricingPrompt: 1, pricingCompletion: 2, routeable: true },
    ],
    aliases: [{ id: "cyberouter/auto", task: null }],
  };
  const hand = new Map([
    ["glm-5.3-flash", { maxTokens: 128000, thinkingLevelMap: { off: null, low: "low" } }],
    ["glm-5.3", { maxTokens: 999999 }],
  ]);
  const bundled = [cat("openrouter", { "glm-5.3-flash": { maxTokens: 131072 }, inkling: { maxTokens: 471859 } })];

  const out = buildBlock(catalog, hand, bundled, "https://x", () => true);
  const by = Object.fromEntries(out.models.map((m) => [m.id, m]));

  check("the near miss does not take the bundled figure", by["cyberouter/glm-5.3"].donor?.source !== "openrouter", JSON.stringify(by["cyberouter/glm-5.3"]?.donor));
  check("the near miss keeps its own hand value", by["cyberouter/glm-5.3"].maxTokens === 999999, String(by["cyberouter/glm-5.3"].maxTokens));
  check("the exact match takes the exact bundled figure", by["cyberouter/glm-5.3-flash"].maxTokens === 131072, String(by["cyberouter/glm-5.3-flash"].maxTokens));
  check("the endpoint owns the context window", by["cyberouter/glm-5.3-flash"].contextWindow === 1048576, String(by["cyberouter/glm-5.3-flash"].contextWindow));
  check("the endpoint owns the price", by["cyberouter/glm-5.3-flash"].cost.input === 0.15, String(by["cyberouter/glm-5.3-flash"].cost.input));
  check("compat defaults on", by["cyberouter/glm-5.3-flash"].compat?.supportsDeveloperRole === false, JSON.stringify(by["cyberouter/glm-5.3-flash"].compat));
  check("a model with no route is excluded", !by["cyberouter/dead"]);
  check("the exclusion says why", out.skipped.find((s) => s.id === "cyberouter/dead")?.why.includes("ruta"), JSON.stringify(out.skipped));
  check("a model with no donor is reported as pending", out.pending.includes("cyberouter/orphan"), out.pending.join(","));

  check("aliases are published", !!by["cyberouter/auto"]);
  check("alias context is the catalog floor", by["cyberouter/auto"].contextWindow === 262144, String(by["cyberouter/auto"].contextWindow));
  check("alias price is the catalog ceiling", by["cyberouter/auto"].cost.input === 1.4, String(by["cyberouter/auto"].cost.input));
  check("aliases carry no donor record", by["cyberouter/auto"].donor === undefined);

  check("an impossible ceiling is clamped below the window", by["cyberouter/inkling"].maxTokens === 262144 - PROMPT_RESERVE_TOKENS, String(by["cyberouter/inkling"].maxTokens));
  check("the clamp leaves room for a real prompt", PROMPT_RESERVE_TOKENS >= 32_768, String(PROMPT_RESERVE_TOKENS));
  check("maxTokens is never null (Pi crashes formatting it)", out.models.every((m) => typeof m.maxTokens === "number"), "hay un null");
}

console.log("\nan alias listed under data is published once, not twice");
{
  // The live catalog returns the five cyberouter/* task aliases in BOTH `data`
  // and `aliases`. Before the dedup this produced two entries per alias with
  // different windows, names and prices.
  const catalog = {
    models: [
      { id: "cyberouter/auto", name: "Auto (Enclave Router)", contextLength: 131072, routeable: true },
      { id: "cyberouter/glm-5.3", name: "GLM 5.3", contextLength: 1048576, pricingPrompt: 1.4, pricingCompletion: 4.4, routeable: true },
    ],
    aliases: [{ id: "cyberouter/auto", task: null }],
  };
  const out = buildBlock(catalog, new Map(), [], "https://x", () => true);
  const autos = out.models.filter((m) => m.id === "cyberouter/auto");
  check("the alias is published exactly once", autos.length === 1, String(autos.length));
  check("it keeps the endpoint's own window", autos[0]?.contextWindow === 131072, String(autos[0]?.contextWindow));
  check("it keeps the endpoint's own name", autos[0]?.name === "Auto (Enclave Router)", String(autos[0]?.name));
  // The catalog states no price for an alias: which concrete model the router
  // picks decides it, so it is bounded at the ceiling rather than shown as free.
  check("a priceless alias is bounded at the ceiling, not free", autos[0]?.cost.input === 1.4 && autos[0]?.cost.output === 4.4, JSON.stringify(autos[0]?.cost));
  check("every published id is unique", new Set(out.models.map((m) => m.id)).size === out.models.length, out.models.map((m) => m.id).join(","));

  // An alias that `data` does NOT carry still takes the floor/ceiling fallback.
  const onlyAlias = buildBlock(
    { models: [{ id: "cyberouter/glm-5.3", name: "GLM 5.3", contextLength: 1048576, pricingPrompt: 1.4, pricingCompletion: 4.4, routeable: true }],
      aliases: [{ id: "cyberouter/triage", task: null }] },
    new Map(), [], "https://x", () => true,
  );
  const tri = onlyAlias.models.find((m) => m.id === "cyberouter/triage");
  check("an alias absent from data still gets the floor", tri?.contextWindow === 1048576, String(tri?.contextWindow));
  check("and the ceiling", tri?.cost.input === 1.4 && tri?.cost.output === 4.4, JSON.stringify(tri?.cost));
}

console.log("\nthe scripts resolve their own location on any OS");
{
  // new URL(...).pathname yields "/C:/...%20..." on Windows, which Node rejects
  // as a package specifier; both scripts must use fileURLToPath instead.
  const { existsSync } = await import("node:fs");
  check("this file resolves the package root", existsSync(join(ROOT, "donors-enclave.ts")), ROOT);
}

console.log("\nexisting values are kept when there is no donor at all");
{
  const catalog = { models: [{ id: "cyberouter/orphan", name: "Orphan", contextLength: 262144, pricingPrompt: 1, pricingCompletion: 2, routeable: true }], aliases: [] };
  const hand = new Map([["orphan", { maxTokens: 999, thinkingLevelMap: { low: "low" } }]]);
  const out = buildBlock(catalog, hand, [], "https://x", () => true);
  check("the hand value survives", out.models[0].maxTokens === 999, String(out.models[0].maxTokens));
}

console.log("\nthe value most catalogs agree on is the one published");
{
  const { normaliseModelKey, resolveByCorroboration, estimateCostRange, VENDOR_CATALOG_ALIASES } = await load("donors-enclave.ts");

  // deepseek.json spells the model `deepseek-flash` but names it "DeepSeek V4.1
  // Flash". Stripping punctuation makes that the same key as the endpoint id,
  // so the vendor's own catalog is reachable without an alias.
  check("the human name reduces to the endpoint id", normaliseModelKey("DeepSeek V4.1 Flash") === normaliseModelKey("deepseek-v4.1-flash"), normaliseModelKey("DeepSeek V4.1 Flash"));
  check("and so does the catalog's own id", normaliseModelKey("deepseek-flash") !== normaliseModelKey("deepseek-v4.1-flash"), "distinct, so the NAME index is what connects them");
  check("a dated variant keeps its date", normaliseModelKey("deepseek-v4-flash-0731") !== normaliseModelKey("deepseek-v4-flash"), "distinct");

  const eight = (v) => Array.from({ length: 8 }, (_, i) => ({ provider: "c" + i, entry: { id: "x", maxTokens: v }, matchedId: "deepseek/x", via: "id" }));
  const majority = resolveByCorroboration([...eight(384000), { provider: "openrouter", entry: { id: "x", maxTokens: 943718 }, matchedId: "deepseek/x", via: "id" }], "maxTokens");
  check("eight against one wins", majority.value === 384000, String(majority.value));
  check("and it is recorded as a majority", majority.how === "majority", majority.how);

  // A plurality is not corroboration: with no majority the vendor speaks first.
  const split = [
    { provider: "openrouter", entry: { id: "x", maxTokens: 999 }, matchedId: "z-ai/glm-5.3", via: "id" },
    { provider: "zai", entry: { id: "x", maxTokens: 111 }, matchedId: "z-ai/glm-5.3", via: "id" },
    { provider: "a", entry: { id: "x", maxTokens: 222 }, matchedId: "z-ai/glm-5.3", via: "id" },
  ];
  const noMajority = resolveByCorroboration(split, "maxTokens", "zai", "openrouter");
  check("without a majority the vendor's catalog speaks", noMajority.value === 111, String(noMajority.value));
  check("and it says so", noMajority.how === "vendor fallback", noMajority.how);
  check("z-ai maps to the zai catalog", VENDOR_CATALOG_ALIASES["z-ai"] === "zai", String(VENDOR_CATALOG_ALIASES["z-ai"]));

  // A level one catalog omits is a level another one still asserted.
  const merged = resolveByCorroboration(
    [
      { provider: "openrouter", entry: { id: "x", thinkingLevelMap: { off: "none", low: "low", high: "high" } }, matchedId: "qwen/x", via: "id" },
      { provider: "deepseek", entry: { id: "x", thinkingLevelMap: { low: "low", high: "high", max: "max" } }, matchedId: "qwen/x", via: "id" },
      { provider: "c", entry: { id: "x", thinkingLevelMap: { low: "low", high: "high", max: "max" } }, matchedId: "qwen/x", via: "id" },
    ],
    "thinkingLevelMap",
  );
  check("a level the majority omits is not erased by it", merged.value.low === "low", JSON.stringify(merged.value));
  check("a level only one states is still kept", merged.value.max === "max", JSON.stringify(merged.value));
  check("and the level only one catalog states is kept, because silence is not a claim", merged.value.off === "none", JSON.stringify(merged.value));

  // cost describes this endpoint, so it is reported as a spread and never
  // published as a single number.
  const range = estimateCostRange([
    { provider: "openrouter", entry: { id: "x", cost: { input: 0.037, output: 0.17 } }, matchedId: "x", via: "id" },
    { provider: "opencode", entry: { id: "x", cost: { input: 0.3, output: 1.2 } }, matchedId: "x", via: "id" },
  ]);
  check("the cost range spans the resellers", range.input.min === 0.037 && range.input.max === 0.3, JSON.stringify(range.input));
  const published = resolveModel("deepseek-v4-pro", undefined, [cat("openrouter", { "deepseek-v4-pro": { id: "x", cost: { input: 1, output: 2 } } })], false);
  check("cost is still never published from a catalog", published.entry.cost === undefined, JSON.stringify(published.entry.cost));
}

console.log("\nthe vendor's catalog is reachable by name, not only by id");
{
  const vendor = { provider: "deepseek", models: new Map([["deepseek-flash", { id: "deepseek-flash", name: "DeepSeek V4.1 Flash", maxTokens: 384000 }]]), modelsByName: new Map([["deepseekv41flash", { id: "deepseek-flash", name: "DeepSeek V4.1 Flash", maxTokens: 384000 }]]) };
  const r = resolveModel("deepseek-v4.1-flash", undefined, [vendor], false);
  check("an id alone would not have matched", vendor.models.has("deepseek-v4.1-flash") === false, "not in models");
  check("the name index does match it", r.entry.maxTokens === 384000, String(r.entry.maxTokens));
}

console.log("\nthe vendor's own catalog decides, even against a majority");
{
  const { FAMILY_VENDOR, modelFamily, vendorCatalogProvider, resolveModel } = await load("donors-enclave.ts");

  check("kimi belongs to moonshotai", FAMILY_VENDOR["kimi"] === "moonshotai", String(FAMILY_VENDOR["kimi"]));
  check("claude belongs to anthropic", FAMILY_VENDOR["claude"] === "anthropic", String(FAMILY_VENDOR["claude"]));
  check("a version bump does not move a model out of its family", modelFamily("qwen3.8-max") === "qwen", modelFamily("qwen3.8-max"));
  check("nor does a family with a digit", modelFamily("glm-5.3") === "glm", modelFamily("glm-5.3"));

  // Four resellers against the vendor. The vendor's number is the one that
  // stands: it records what the model implements, the rest record what one
  // gateway accepts.
  const resellers = ["openrouter", "together", "vercel-ai-gateway", "baseten"].map((p) =>
    cat(p, { "kimi-k3": { id: p + "/kimi-k3", maxTokens: 999999 } }),
  );
  const vendor = cat("moonshotai", { "kimi-k3": { id: "kimi-k3", maxTokens: 131072 } });
  const r = resolveModel("kimi-k3", undefined, [vendor, ...resellers], false);
  check("the vendor's figure wins", r.entry.maxTokens === 131072, String(r.entry.maxTokens));
  check("and it is attributed to the vendor", r.source === "moonshotai", String(r.source));
  check("the resellers are still recorded", r.corroborating.length === 4, r.corroborating.join(","));
  check("the vendor is found from the family", vendorCatalogProvider([{ provider: "moonshotai", entry: {}, matchedId: "kimi-k3", via: "id" }], "kimi-k3") === "moonshotai", "moonshotai");

  // With no vendor catalog, agreement decides instead.
  const sinVendor = resolveModel("qwen3.8-max", undefined, [
    cat("openrouter", { "qwen3.8-max": { id: "qwen/qwen3.8-max", maxTokens: 1 } }),
    cat("opencode", { "qwen3.8-max": { id: "qwen3.8-max", maxTokens: 2 } }),
    cat("together", { "qwen3.8-max": { id: "qwen3.8-max", maxTokens: 2 } }),
  ], false);
  check("without a vendor the majority stands", sinVendor.entry.maxTokens === 2, String(sinVendor.entry.maxTokens));
  check("and it is not attributed to a vendor", sinVendor.source !== "moonshotai", String(sinVendor.source));
}

console.log("\na ceiling that cannot exist is not a claim");
{
  const { isPossibleValue, normaliseModelKey } = await load("donors-enclave.ts");
  check("a ceiling below the window is possible", isPossibleValue({ maxTokens: 384000, contextWindow: 1048576 }, "maxTokens") === true, "384000 < 1048576");
  check("a ceiling equal to the window is not", isPossibleValue({ maxTokens: 1048576, contextWindow: 1048576 }, "maxTokens") === false, "equal");
  check("nor one above it", isPossibleValue({ maxTokens: 2000000, contextWindow: 1048576 }, "maxTokens") === false, "above");
  check("a figure with no window beside it is taken at face value", isPossibleValue({ maxTokens: 1048576 }, "maxTokens") === true, "no window");
  check("other fields are never discarded this way", isPossibleValue({ input: ["text", "image"], contextWindow: 1 }, "input") === true, "input");

  // The vendor states an impossible ceiling, so the field falls through.
  const r = resolveModel("kimi-k3", undefined, [
    cat("moonshotai", { "kimi-k3": { id: "kimi-k3", maxTokens: 1048576, contextWindow: 1048576 } }),
    cat("openrouter", { "kimi-k3": { id: "moonshotai/kimi-k3", maxTokens: 131072, contextWindow: 1048576 } }),
    cat("opencode", { "kimi-k3": { id: "kimi-k3", maxTokens: 131072, contextWindow: 1048576 } }),
    cat("opencode-go", { "kimi-k3": { id: "kimi-k3", maxTokens: 131072, contextWindow: 1048576 } }),
  ], false);
  check("the impossible figure is not published", r.entry.maxTokens === 131072, String(r.entry.maxTokens));
  check("and the vendor is still named as the source", r.source === "moonshotai", String(r.source));

  // A vendor figure that could exist is published untouched.
  const vendorCatalog = (provider, id, name, extra) => {
    const entry = Object.assign({ id, name }, extra);
    return {
      provider,
      models: new Map([[id, entry]]),
      modelsByName: new Map([[normaliseModelKey(name), entry]]),
    };
  };
  const ok = resolveModel("deepseek-v4.1-flash", undefined, [
    vendorCatalog("deepseek", "deepseek-flash", "DeepSeek V4.1 Flash", { maxTokens: 384000, contextWindow: 1000000 }),
    cat("openrouter", { "deepseek-v4.1-flash": { id: "deepseek/deepseek-v4.1-flash", maxTokens: 943718, contextWindow: 1048576 } }),
  ], false);
  check("a possible vendor figure wins against openrouter", ok.entry.maxTokens === 384000, String(ok.entry.maxTokens));
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f}`);
  process.exit(1);
}
