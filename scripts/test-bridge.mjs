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
  const { ctx } = makeCtx();
  const out = await refresh(ctx);
  const glm = out.find((m) => m.id === "cyberouter/glm-5.3");

  check("probe aborted on 500, not derived from it", glm.provenance.maxTokens !== "measured", glm.provenance.maxTokens);
  check("gateway contextWindow survived", glm.contextWindow === 1048576);
  check("thinkingLevelMap stayed vanilla", glm.provenance.thinkingLevelMap === "vanilla", glm.provenance.thinkingLevelMap);
  check("contextWindow is labelled gateway", glm.provenance.contextWindow === "gateway", glm.provenance.contextWindow);
  check("cost is labelled gateway", glm.provenance.cost === "gateway", glm.provenance.cost);
}

// ---------------------------------------------------------------- 4. probe measures
console.log("\n4. A real measurement is labelled measured");
{
  state.chatMode = "ok";
  const fresh = mkdtempSync(join(tmpdir(), "enclave-probe-"));
  const refresh2 = makeRefreshModels({ agentDir: fresh, baseUrlOverride: BASE });
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
  const refresh3 = makeRefreshModels({ agentDir: fresh, baseUrlOverride: BASE });
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

// ---------------------------------------------------------------- cleanup
server.close();
rmSync(agentDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}