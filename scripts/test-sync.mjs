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

const ROOT = join(new URL(".", import.meta.url).pathname, "..");
const { bareName, resolveModel, readBundledCatalog, readPiCatalogs, findBundledCatalogDir, findBundledCatalogs, ROUNDING_TOLERANCE } =
  await import(join(ROOT, "donors-enclave.ts"));
const { buildBlock, PROMPT_RESERVE_TOKENS } = await import(join(ROOT, "enclave-live.ts"));

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
  const { VENDOR_SPEC } = await import(join(ROOT, "donors-enclave.ts"));
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
  check("the lower one is recorded as corroboration", two.corroborating.join(",") === "opencode", two.corroborating.join(","));

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
  const { storeCatalogs } = await import(join(ROOT, "donors-enclave.ts"));
  const dirs = storeCatalogs(fake);
  check("store catalogs are found without a stored path", dirs.length >= 1, String(dirs.length));
  check("the newest version wins whatever the folder is called", dirs[0].includes("0.99.0"), dirs[0]);
  const cat2 = readBundledCatalog(dirs[0], "openrouter");
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
  check("and contributes no store catalog", !bogus.some((b) => b.origin === "pi install"));
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

console.log("\nexisting values are kept when there is no donor at all");
{
  const catalog = { models: [{ id: "cyberouter/orphan", name: "Orphan", contextLength: 262144, pricingPrompt: 1, pricingCompletion: 2, routeable: true }], aliases: [] };
  const hand = new Map([["orphan", { maxTokens: 999, thinkingLevelMap: { low: "low" } }]]);
  const out = buildBlock(catalog, hand, [], "https://x", () => true);
  check("the hand value survives", out.models[0].maxTokens === 999, String(out.models[0].maxTokens));
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f}`);
  process.exit(1);
}