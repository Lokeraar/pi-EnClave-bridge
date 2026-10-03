#!/usr/bin/env node
/**
 * test-bridge.mjs — behavioural tests against a MOCK gateway.
 *
 * The live chat endpoint is down (Vercel 500 on every model), so testing against
 * it would prove nothing. This harness stands up a local HTTP server that speaks
 * the EnClave catalog dialect and answers chat requests on demand, which lets us
 * assert the parts that matter without spending a token or waiting on a router.
 *
 * Run:  node --experimental-strip-types scripts/test-bridge.mjs
 */

import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = join(HERE, "..");
const { makeRefreshModels, readRetiredLedgerState } = await import(join(ROOT, "enclave-live.ts"));

// ---------------------------------------------------------------- mock gateway
const CATALOG = {
  data: [
    {
      id: "cyberouter/glm-5.3",
      name: "GLM 5.3",
      context_length: 1048576,
      architecture: { modality: "text", tokenizer: "unknown" },
      pricing: { prompt: 1.4, completion: 4.4 },
      routeable_endpoint_count: 3,
      endpoint_count: 3,
    },
    {
      id: "cyberouter/deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash",
      context_length: 1048576,
      architecture: { modality: "text" },
      pricing: { prompt: 0.3, completion: 1.2 },
      routeable_endpoint_count: 2,
      endpoint_count: 2,
    },
    {
      id: "cyberouter/dead-model",
      name: "Dead Model",
      context_length: 262144,
      architecture: { modality: "text" },
      pricing: { prompt: 1, completion: 2 },
      routeable_endpoint_count: 0, // listed but no healthy route for this key
      endpoint_count: 1,
    },
    {
      id: "cyberouter/gpt-oss-120b",
      name: "GPT-OSS 120B",
      context_length: 131072,
      architecture: { modality: "text" },
      pricing: { prompt: 0.1, completion: 0.5 },
      routeable_endpoint_count: 2,
      endpoint_count: 2,
    },
  ],
  aliases: [
    { id: "cyberouter/auto", task: null, sort: "task_perf" },
    { id: "cyberouter/triage", task: "triage", sort: "task_perf" },
  ],
};

/** mutable knobs the tests flip */
const state = {
  chatMode: "ok", // "ok" | "reject-effort" | "server-error" | "ceiling-32768"
  calls: [],
};

const server = createServer((req, res) => {
  if (req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(CATALOG));
    return;
  }
  if (req.url?.endsWith("/chat/completions")) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      state.calls.push(body);
      const send = (code, payload) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
      };

      if (state.chatMode === "server-error") return send(500, "Internal Server Error");
      // The gateway tunnelling an upstream parameter rejection in a 502.
      if (state.chatMode === "tunneled-502" && (body.max_tokens ?? 0) > 32768) {
        return send(502, { error: { message: "Inference provider returned HTTP 400", type: "api_error", code: "provider_error" } });
      }
      // The upstream resource being permanently gone.
      if (state.chatMode === "upstream-410") {
        return send(502, { error: { message: "Inference provider returned HTTP 410", type: "api_error", code: "provider_error" } });
      }

      const effort = body.reasoning_effort;
      if (state.chatMode === "reject-effort" && effort && !["low", "high"].includes(effort)) {
        return send(400, { error: { message: `unsupported effort ${effort}` } });
      }
      if (state.chatMode === "ceiling-32768" && (body.max_tokens ?? 0) > 32768) {
        return send(400, { error: { message: "max_tokens too large" } });
      }
      send(200, {
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: {
          completion_tokens: 1,
          completion_tokens_details: { reasoning_tokens: effort ? 12 : 0 },
        },
      });
    });
    return;
  }
  res.writeHead(404).end();
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/v1`;

// ---------------------------------------------------------------- harness
let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const agentDir = mkdtempSync(join(tmpdir(), "enclave-test-"));
const signal = AbortSignal.any([AbortSignal.timeout(30_000)]);

function makeCtx({ stored, allowNetwork = true } = {}) {
  let persisted = null;
  return {
    persisted: () => persisted,
    ctx: {
      credential: { type: "api_key", key: "test-key" },
      stored,
      allowNetwork,
      signal,
      async publish(pub) {
        if (pub.persist) persisted = pub.persist;
        return true;
      },
    },
  };
}

const refresh = makeRefreshModels({ agentDir, fallbackBaseUrl: BASE, baseUrlOverride: BASE });

// ---------------------------------------------------------------- 1. live + exclusion
console.log("\n1. Live membership, routability filter, alias bounds");
{
  const { ctx } = makeCtx();
  const out = await refresh(ctx);
  const ids = out.map((m) => m.id);

  check("live ids are published", ids.includes("cyberouter/glm-5.3"), ids.join(","));
  check("listed-but-not-routable is EXCLUDED", !ids.includes("cyberouter/dead-model"), "ghost model leaked");
  check("aliases are published", ids.includes("cyberouter/auto") && ids.includes("cyberouter/triage"));

  const glm = out.find((m) => m.id === "cyberouter/glm-5.3");
  check("contextWindow comes from the gateway", glm.contextWindow === 1048576, String(glm.contextWindow));
  check("cost.input maps from pricing.prompt", glm.cost.input === 1.4, String(glm.cost.input));
  check("cost.output maps from pricing.completion", glm.cost.output === 4.4, String(glm.cost.output));

  const alias = out.find((m) => m.id === "cyberouter/auto");
  check("alias context = catalog FLOOR (min)", alias.contextWindow === 131072, String(alias.contextWindow));
  check("alias cost = catalog CEILING (max)", alias.cost.input === 1.4 && alias.cost.output === 4.4);
}

// ---------------------------------------------------------------- 2. ledger
console.log("\n2. Retirement ledger");
{
  // The realistic path: the id was published by an earlier session, so the
  // store knows it. An id we never published is not recorded as retired.
  const seeded = makeCtx({
    stored: {
      models: [
        { id: "cyberouter/dead-model", provider: "EnClave", contextWindow: 262144, maxTokens: 16384 },
        { id: "cyberouter/glm-5.3", provider: "EnClave", contextWindow: 1048576, maxTokens: 16384 },
      ],
    },
  });
  const out = await refresh(seeded.ctx);
  check("dead model dropped from the live catalog", !out.some((m) => m.id === "cyberouter/dead-model"));

  const ledgerPath = join(agentDir, "enclave-retired.json");
  check("ledger file was written", existsSync(ledgerPath));
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  check(
    "not-routable recorded with its reason",
    ledger.retired["cyberouter/dead-model"]?.reason === "not-routable",
    JSON.stringify(ledger.retired),
  );
  check("a healthy id is NOT retired", ledger.retired["cyberouter/glm-5.3"] === undefined);
}

// not-listed: a curated id the endpoint stops serving
{
  const curatedFile = join(agentDir, "enclave-curated.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    curatedFile,
    JSON.stringify({ models: [{ id: "cyberouter/vanished", name: "Vanished", contextWindow: 1000, maxTokens: 100 }] }),
  );
  const { ctx } = makeCtx();
  await refresh(ctx);
  const ledger = JSON.parse(readFileSync(join(agentDir, "enclave-retired.json"), "utf8"));
  check("not-listed recorded", ledger.retired["cyberouter/vanished"]?.reason === "not-listed", JSON.stringify(ledger.retired));

  // Phase 1 offline must not resurrect it.
  const offline = makeCtx({ allowNetwork: false });
  offline.ctx.stored = { models: [{ id: "cyberouter/vanished", provider: "EnClave", contextWindow: 1000, maxTokens: 100 }] };
  const merged = await refresh(offline.ctx);
  check("ledger blocks offline resurrection", !merged.some((m) => m.id === "cyberouter/vanished"));
}

// ---------------------------------------------------------------- 3. probe vs 500
console.log("\n3. A 500 must NOT become a measurement");
{
  state.chatMode = "server-error";
  state.calls = [];
  const fresh = mkdtempSync(join(tmpdir(), "enclave-500-"));
  const refresh500 = makeRefreshModels({ agentDir: fresh, baseUrlOverride: BASE, probe: true });
  const { ctx } = makeCtx();
  const out = await refresh500(ctx);
  const glm = out.find((m) => m.id === "cyberouter/glm-5.3");

  check("probe aborted on 500, not derived from it", glm.provenance.maxTokens !== "measured", glm.provenance.maxTokens);
  check("gateway contextWindow survived", glm.contextWindow === 1048576);
  check("thinkingLevelMap stayed vanilla", glm.provenance.thinkingLevelMap === "vanilla", glm.provenance.thinkingLevelMap);
  check("contextWindow is labelled gateway", glm.provenance.contextWindow === "gateway", glm.provenance.contextWindow);
  check("cost is labelled gateway", glm.provenance.cost === "gateway", glm.provenance.cost);
  rmSync(fresh, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 4. probe measures
console.log("\n4. A real measurement is labelled measured");
{
  state.chatMode = "ok";
  const fresh = mkdtempSync(join(tmpdir(), "enclave-probe-"));
  const refresh2 = makeRefreshModels({ agentDir: fresh, baseUrlOverride: BASE, probe: true });
  const { ctx } = makeCtx();
  const out = await refresh2(ctx);
  const glm = out.find((m) => m.id === "cyberouter/glm-5.3");

  check("maxTokens measured from a probe", glm.provenance.maxTokens === "measured", glm.provenance.maxTokens);
  check("thinkingLevelMap measured", glm.provenance.thinkingLevelMap === "measured");
  check("contextWindow STILL gateway (never probed)", glm.provenance.contextWindow === "gateway");
  check("ceiling walked to the top candidate", glm.maxTokens === 2097152 || glm.maxTokens === 1048576, String(glm.maxTokens));
  rmSync(fresh, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 5. 400 is a measurement
console.log("\n5. A 400 IS a measurement (rejected levels and ceiling)");
{
  state.chatMode = "ceiling-32768";
  const fresh = mkdtempSync(join(tmpdir(), "enclave-ceil-"));
  const refresh3 = makeRefreshModels({ agentDir: fresh, baseUrlOverride: BASE, probe: true });
  const { ctx } = makeCtx();
  const out = await refresh3(ctx);
  const glm = out.find((m) => m.id === "cyberouter/glm-5.3");

  check("ceiling walk reports the last ACCEPTED candidate", glm.maxTokens === 32768, String(glm.maxTokens));
  check("never overstates the ceiling", glm.maxTokens <= 32768, String(glm.maxTokens));
  rmSync(fresh, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 6. curated wins
console.log("\n6. Curated values are never overwritten");
{
  state.chatMode = "ok";
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    join(agentDir, "enclave-curated.json"),
    JSON.stringify({
      models: [{ id: "cyberouter/glm-5.3", name: "GLM 5.3 (mi valor)", maxTokens: 65536, contextWindow: 1048576 }],
    }),
  );
  const { ctx } = makeCtx();
  const out = await refresh(ctx);
  const glm = out.find((m) => m.id === "cyberouter/glm-5.3");
  check("curated maxTokens kept", glm.maxTokens === 65536, String(glm.maxTokens));
  check("curated name kept", glm.name === "GLM 5.3 (mi valor)", glm.name);
  check("curated is labelled curated", glm.provenance.maxTokens === "curated", glm.provenance.maxTokens);
}

// ---------------------------------------------------------------- 6b. tunneled rejection
console.log("\n6b. A 502 tunnelling an upstream 400 IS a measurement");
{
  state.chatMode = "tunneled-502";
  const fresh = mkdtempSync(join(tmpdir(), "enclave-tunnel-"));
  const refresh4 = makeRefreshModels({ agentDir: fresh, baseUrlOverride: BASE, probe: true });
  const { ctx } = makeCtx();
  const out = await refresh4(ctx);
  const glm = out.find((m) => m.id === "cyberouter/glm-5.3");
  check(
    "tunneled 502/400 closes the ceiling walk instead of discarding the model",
    glm.provenance.maxTokens === "measured",
    glm.provenance.maxTokens,
  );
  check("ceiling stops at the last accepted candidate", glm.maxTokens === 32768, String(glm.maxTokens));
  rmSync(fresh, { recursive: true, force: true });
  state.chatMode = "ok";
}

// ---------------------------------------------------------------- 6c. upstream gone
console.log("\n6c. An upstream 410 is NOT a parameter rejection");
{
  state.chatMode = "upstream-410";
  const fresh = mkdtempSync(join(tmpdir(), "enclave-410-"));
  const refresh5 = makeRefreshModels({ agentDir: fresh, baseUrlOverride: BASE, probe: true });
  const { ctx } = makeCtx();
  const out = await refresh5(ctx);
  const glm = out.find((m) => m.id === "cyberouter/glm-5.3");
  check("upstream 410 discards the probe (no fake ceiling)", glm.provenance.maxTokens !== "measured", glm.provenance.maxTokens);
  check("gateway values survive an upstream 410", glm.contextWindow === 1048576);
  rmSync(fresh, { recursive: true, force: true });
  state.chatMode = "ok";
}

// ---------------------------------------------------------------- 7. donor
console.log("\n7. Donor layer (inherit from another provider, same base model)");
{
  const { applyDonor, buildDonorIndex, readDonorConfig } = await import(join(ROOT, "enclave-live.ts"));
  const { writeFileSync } = await import("node:fs");

  // A donor models.json with one exact bare-name match and one near-miss.
  const donorDir = mkdtempSync(join(tmpdir(), "enclave-donor-"));
  writeFileSync(
    join(donorDir, "models.json"),
    JSON.stringify({
      providers: {
        opendesign: {
          models: [
            {
              id: "deepseek-v4.1-flash",
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 1048000,
              maxTokens: 232000,
              thinkingLevelMap: { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
            },
            {
              // near-miss: must NOT bleed into cyberouter/glm-5.3
              id: "glm-5.3-flash",
              input: ["text", "image"],
              maxTokens: 128000,
              thinkingLevelMap: { off: null, low: "low", high: "high", max: "max" },
            },
          ],
        },
      },
    }),
  );

  const index = buildDonorIndex(readDonorConfig(donorDir));
  check("donor indexed by bare name", index.byBareName.size === 2, String(index.byBareName.size));

  const gateway = {
    id: "cyberouter/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    provider: "EnClave",
    reasoning: true,
    input: ["text"],
    contextWindow: 1048576,
    maxTokens: 16384,
    cost: { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
    compat: { supportsDeveloperRole: false },
    provenance: { contextWindow: "gateway", maxTokens: "vanilla", thinkingLevelMap: "vanilla", input: "gateway", cost: "gateway" },
  };

  const r = applyDonor(gateway, index).model;
  check("thinkingLevelMap inherited", r.thinkingLevelMap.low === "low" && r.thinkingLevelMap.off === "none");
  check("input inherited over the templated gateway fill", JSON.stringify(r.input) === '["text","image"]', JSON.stringify(r.input));
  check("inherited fields are labelled 'inherited'", r.provenance.thinkingLevelMap === "inherited" && r.provenance.input === "inherited");
  check("contextWindow NOT inherited (gateway-specific)", r.contextWindow === 1048576, String(r.contextWindow));
  check("maxTokens NOT inherited (the 232000 trap)", r.maxTokens === 16384, String(r.maxTokens));
  check("cost NOT inherited", r.cost.input === 0.3, String(r.cost.input));

  // near-miss must not bleed
  const near = applyDonor(
    { ...gateway, id: "cyberouter/glm-5.3", provenance: { ...gateway.provenance } },
    index,
  );
  check("near-miss glm-5.3 does NOT inherit from glm-5.3-flash", near.model.provenance.thinkingLevelMap === "vanilla", near.model.provenance.thinkingLevelMap);

  // measurement must not be overwritten
  const measured = applyDonor(
    { ...gateway, provenance: { ...gateway.provenance, thinkingLevelMap: "measured" } },
    index,
  ).model;
  check("a MEASURED value is never overwritten by a donor", measured.provenance.thinkingLevelMap === "measured");

  // disabled donor
  const off = buildDonorIndex({ enabled: false, modelsJson: join(donorDir, "models.json"), provider: "opendesign" });
  check("disabled donor yields an empty index", off.byBareName.size === 0);
  check("empty donor is a no-op", applyDonor(gateway, off).model === gateway);

  rmSync(donorDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- cleanup
server.close();
rmSync(agentDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}