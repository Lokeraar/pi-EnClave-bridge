#!/usr/bin/env node
/**
 * test-refresh.mjs — offline checks for EnClave's automatic model refresh.
 * Automatic refresh is catalog discovery only: one GET /models, never an inference.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const home = process.env.HOME;
if (!home) throw new Error("HOME is required to create the test agent directory");
const agentDir = mkdtempSync(join(home, ".enclave-refresh-test-"));

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

const catalog = {
  data: [
    { id: "cyberouter/model-a", name: "Model A", context_length: 131072, pricing: { prompt: 1, completion: 2 }, routeable_endpoint_count: 1 },
    { id: "cyberouter/auto", name: "Auto", context_length: 131072, pricing: { prompt: 1, completion: 2 }, routeable_endpoint_count: 1 },
  ],
  aliases: [{ id: "cyberouter/auto", task: null }, { id: "cyberouter/triage", task: "triage" }],
};

try {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { EnClave: { models: [] } } }));

  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    requests.push({ url: String(input), method });
    if (method !== "GET") throw new Error(`Unexpected non-GET refresh request: ${method} ${input}`);
    return { ok: true, json: async () => catalog };
  };

  // Replace fetch before importing the module.
  const { makeRefreshModels } = await import(pathToFileURL(join(ROOT, "enclave-live.ts")).href);
  const refreshModels = makeRefreshModels(agentDir, "https://router.example/v1");
  const signal = new AbortController().signal;

  console.log("automatic refresh is catalog-only");
  let persisted;
  const result = await refreshModels({
    credential: { type: "api_key", key: "test-key" },
    allowNetwork: true,
    signal,
    publish: async (value) => { persisted = value.persist; return true; },
  });
  check("one refresh makes exactly one GET /models and no other request", requests.length === 1 && requests[0]?.method === "GET" && requests[0]?.url === "https://router.example/v1/models", JSON.stringify(requests));
  check("catalog ids are published", ["cyberouter/model-a", "cyberouter/auto", "cyberouter/triage"].every((id) => persisted?.models.some((model) => model.id === id)), JSON.stringify(persisted?.models.map((model) => model.id)));
  check("an alias already in data is published only once", persisted?.models.filter((model) => model.id === "cyberouter/auto").length === 1, String(persisted?.models.filter((model) => model.id === "cyberouter/auto").length));
  check("successful refresh returns the published model list", result === persisted?.models, String(result?.length));

  console.log("cache-only and credential-free calls stay offline");
  const storedModels = [{ id: "cyberouter/cached", name: "Cached", api: "openai-completions" }];
  let cachePublishCalled = false;
  const beforeCacheOnly = requests.length;
  const cacheContext = {
    credential: { type: "api_key", key: "test-key" },
    allowNetwork: false,
    stored: { models: storedModels },
    signal,
    publish: async () => { cachePublishCalled = true; return true; },
  };
  const cacheResult = await refreshModels(cacheContext);
  // Pi keeps the cached models when refreshModels returns undefined.
  const restoredModels = cacheResult ?? cacheContext.stored.models;
  const cacheChecks = [requests.length === beforeCacheOnly, cacheResult === undefined, !cachePublishCalled, restoredModels === storedModels];
  check("cache-only makes no request and restores the stored models", cacheChecks.every(Boolean) && JSON.stringify(restoredModels) === JSON.stringify(storedModels), JSON.stringify({ cacheChecks, restored: restoredModels.map((model) => model.id) }));

  const beforeNoCredential = requests.length;
  const noCredential = await refreshModels({
    credential: undefined,
    allowNetwork: true,
    signal,
    publish: async () => { throw new Error("publish must not run without a credential"); },
  });
  check("missing credential makes no request and returns undefined", requests.length === beforeNoCredential && noCredential === undefined, JSON.stringify({ noCredential, requests: requests.length }));
} catch (error) {
  failed.push("refresh test setup and execution");
  console.log(`  FAIL refresh test setup and execution — ${error?.stack ?? error}`);
} finally {
  rmSync(agentDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const name of failed) console.log(`  - ${name}`);
  process.exit(1);
}
