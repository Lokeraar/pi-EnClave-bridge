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
const { bareName, resolveModel, readBundledCatalog, readActiveBundledCatalogs, findBundledCatalogDir, findBundledCatalogs, ROUNDING_TOLERANCE } =
  await import(join(ROOT, "donors.ts"));
const { buildBlock } = await import(join(ROOT, "enclave-live.ts"));

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

console.log("\nhand-written is the top authority");
{
  const r = resolveModel("glm-5.2", { maxTokens: 262144, input: ["text"] }, [cat("openrouter", { "glm-5.2": { maxTokens: 131072, input: ["text"] } })], false);
  check("a large disagreement keeps the hand value", r.entry.maxTokens === 262144, String(r.entry.maxTokens));
  check("and records that a hand value was used", r.source === "hand", String(r.source));
}

console.log("\nrounding is not a disagreement");
{
  const far = resolveModel("deepseek-v4-flash", { maxTokens: 232000 }, [cat("openrouter", { "deepseek-v4-flash": { maxTokens: 384000 } })], false);
  check("outside the band the hand value stays", far.entry.maxTokens === 232000, String(far.entry.maxTokens));

  const close = resolveModel("glm-5.3-flash", { maxTokens: 128000 }, [cat("openrouter", { "glm-5.3-flash": { maxTokens: 131072 } })], false);
  check("inside the band the exact bundled figure wins", close.entry.maxTokens === 131072, String(close.entry.maxTokens));
  check("the band is 5%", Math.abs(ROUNDING_TOLERANCE - 0.05) < 1e-9, String(ROUNDING_TOLERANCE));
}

console.log("\nstrict order, nothing is averaged");
{
  const r = resolveModel("minimax-m3", undefined, [cat("openrouter", { "minimax-m3": { maxTokens: 512000 } }), cat("opencode", { "minimax-m3": { maxTokens: 128000 } })], false);
  check("the highest-priority catalog supplies the value", r.entry.maxTokens === 512000, String(r.entry.maxTokens));
  check("NOT the midpoint of the two", r.entry.maxTokens !== 320000, String(r.entry.maxTokens));
  check("the lower one is recorded as corroboration", r.corroborating.join(",") === "opencode", r.corroborating.join(","));
  check("the source is named", r.source === "openrouter", String(r.source));

  const h = resolveModel("minimax-m3", { maxTokens: 400000 }, [cat("openrouter", { "minimax-m3": { maxTokens: 512000 } }), cat("opencode", { "minimax-m3": { maxTokens: 128000 } })], false);
  check("a hand value outranks both", h.entry.maxTokens === 400000, String(h.entry.maxTokens));
  check("both lower providers corroborate", h.corroborating.join(",") === "openrouter,opencode", h.corroborating.join(","));
}

console.log("\nfree models are excluded, active providers only");
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

    const active = readActiveBundledCatalogs(agentDir, { exclude: ["EnClave"] });
    const providers = active.map((c) => c.provider);
    check("only active providers are read", !providers.includes("groq") && !providers.includes("fireworks"), providers.join(","));
    check("configured providers are picked up", providers.includes("openrouter") && providers.includes("opencode"), providers.join(","));
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
  mk("0.90.0", "plusbuild", 500);

  const locs = findBundledCatalogs(fake);
  check("catalogues are found without a stored path", locs.length >= 1, String(locs.length));
  check("the newest version wins whatever the folder is called", locs[0].dir.includes("0.99.0"), locs[0].dir);
  const cat2 = readBundledCatalog(locs[0].dir, "openrouter");
  check("the newest catalog is the one read", cat2.models.get("glm-5.3").maxTokens === 999, String(cat2.models.get("glm-5.3").maxTokens));
  check("a + build is never preferred", !locs[0].dir.includes("plusbuild"), locs[0].dir);
  rmSync(fake, { recursive: true, force: true });

  check("a missing package degrades instead of throwing", findBundledCatalogs("/no/existe/path").length === 0);
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

  check("an impossible ceiling is clamped below the window", by["cyberouter/inkling"].maxTokens === 262144 - 2048, String(by["cyberouter/inkling"].maxTokens));
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