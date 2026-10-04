#!/usr/bin/env node
/**
 * test-sync.mjs — checks for the join that matters: bare model name.
 *
 * Runs offline. The point of these is one specific thing that is easy to get
 * wrong and invisible when it is wrong — matching `cyberouter/glm-5.3-flash`
 * against `glm-5.3-flash`, and NOT against `glm-5.3`.
 */

import { join } from "node:path";

const ROOT = join(new URL(".", import.meta.url).pathname, "..");
const { bareName, buildBlock, donorIndex } = await import(join(ROOT, "enclave-live.ts"));

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

console.log("\nbare name");
check("strips a vendor prefix", bareName("cyberouter/glm-5.3") === "glm-5.3");
check("leaves an unprefixed id alone", bareName("glm-5.3") === "glm-5.3");
check("strips only the last segment", bareName("a/b/c") === "c");

console.log("\njoin by bare name");
const data = {
  providers: {
    opendesign: {
      models: [
        {
          id: "deepseek-v4.1-flash",
          reasoning: true,
          thinkingLevelMap: { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
          input: ["text", "image"],
          contextWindow: 1048000,
          maxTokens: 232000,
        },
        { id: "glm-5.3-flash", thinkingLevelMap: { off: null, low: "low", high: "high", max: "max" }, maxTokens: 128000 },
      ],
    },
  },
};
const donor = donorIndex(data);

const catalog = {
  models: [
    { id: "cyberouter/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", contextLength: 1048576, pricingPrompt: 0.3, pricingCompletion: 1.2, routeable: true },
    // glm-5.3 is NOT glm-5.3-flash: a prefix relationship is not an identity.
    { id: "cyberouter/glm-5.3", name: "GLM 5.3", contextLength: 1048576, pricingPrompt: 1.4, pricingCompletion: 4.4, routeable: true },
    { id: "cyberouter/glm-5.3-flash", name: "GLM 5.3 Flash", contextLength: 1048576, pricingPrompt: 0.15, pricingCompletion: 0.5, routeable: true },
    // listed but no healthy route for this key
    { id: "cyberouter/dead", name: "Dead", contextLength: 262144, routeable: false },
    { id: "cyberouter/orphan", name: "Orphan", contextLength: 262144, pricingPrompt: 1, pricingCompletion: 2, routeable: true },
  ],
  aliases: [{ id: "cyberouter/auto", task: null }],
};

const out = buildBlock(catalog, donor, [], "https://x", () => true);
const by = Object.fromEntries(out.models.map((m) => [m.id, m]));

check("donor matched by bare name", out.fromDonor.includes("cyberouter/deepseek-v4.1-flash"), out.fromDonor.join(","));
check("donor values copied wholesale", by["cyberouter/deepseek-v4.1-flash"].maxTokens === 232000, String(by["cyberouter/deepseek-v4.1-flash"].maxTokens));
check("donor thinking map copied", by["cyberouter/deepseek-v4.1-flash"].thinkingLevelMap.xhigh === "xhigh");
check("donor images copied", JSON.stringify(by["cyberouter/deepseek-v4.1-flash"].input) === '["text","image"]');
check("gateway owns the context window", by["cyberouter/deepseek-v4.1-flash"].contextWindow === 1048576, String(by["cyberouter/deepseek-v4.1-flash"].contextWindow));
check("gateway owns the price", by["cyberouter/deepseek-v4.1-flash"].cost.input === 0.3, String(by["cyberouter/deepseek-v4.1-flash"].cost.input));

check("a near-miss name does NOT inherit", !out.fromDonor.includes("cyberouter/glm-5.3"), out.fromDonor.join(","));
check("the near-miss is reported as pending", out.pending.includes("cyberouter/glm-5.3"), out.pending.join(","));
check("glm-5.3-flash matched its own donor", out.fromDonor.includes("cyberouter/glm-5.3-flash"));
check("a model with no route is excluded", !by["cyberouter/dead"]);
check("the exclusion says why", out.skipped.find((s) => s.id === "cyberouter/dead")?.why.includes("ruta"), JSON.stringify(out.skipped));

check("compat defaults on", by["cyberouter/deepseek-v4.1-flash"].compat?.supportsDeveloperRole === false, JSON.stringify(by["cyberouter/deepseek-v4.1-flash"].compat));
check("aliases are published", !!by["cyberouter/auto"]);
check("alias context is the catalog floor", by["cyberouter/auto"].contextWindow === 262144, String(by["cyberouter/auto"].contextWindow));
check("alias price is the catalog ceiling", by["cyberouter/auto"].cost.input === 1.4, String(by["cyberouter/auto"].cost.input));

console.log("\nexisting values are kept when there is no donor");
const out2 = buildBlock(catalog, donor, [{ id: "cyberouter/orphan", reasoning: true, maxTokens: 999, thinkingLevelMap: { low: "low" } }], "https://x", () => true);
check("existing maxTokens survives", by2(out2, "cyberouter/orphan").maxTokens === 999);
function by2(result, id) {
  return result.models.find((m) => m.id === id);
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f}`);
  process.exit(1);
}