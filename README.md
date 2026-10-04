# pi-EnClave-bridge

EnClave provider for [Pi](https://pi.dev). The live router catalog appears in
`/model` with real context windows and real per-token prices.

## Local install

```bash
cp index.ts enclave-live.ts ~/.pi/agent/extensions/
mv ~/.pi/agent/extensions/index.ts ~/.pi/agent/extensions/enclave-bridge.ts
```

Rename it: Pi loads every `extensions/*.ts` as a factory, so a file called
`index.ts` collides and registers the provider twice. Then `/reload`.

## How values are decided

The model values live in `models.json` under `providers.EnClave`. One script
rebuilds that block:

```bash
node --experimental-strip-types scripts/sync-models.mjs --dry-run
node --experimental-strip-types scripts/sync-models.mjs
```

It reads the live catalog, then for each model, in order:

1. **Donor** — `providers.opendesign` in the same `models.json`, matched on the
   **bare model name**: the id with any `vendor/` prefix stripped on both sides,
   so `cyberouter/glm-5.3-flash` matches `glm-5.3-flash`. The donor's values are
   copied onto the EnClave entry wholesale.
2. **Existing** — with no donor, whatever the block already says. That is where
   hand-measured values live.
3. **Pending** — with neither, the script reports it. That is the work left to
   do by hand; nothing is invented.

**The donor is the source of truth.** Its numbers are copied as they are, even
when they are larger than a local measurement found. A value chosen on purpose
beats one the tool inferred. If a value ever causes a problem, lower it
deliberately then — not preemptively in the script.

Two fields are never taken from the donor, because they describe the endpoint
rather than the model:

| Field | Source |
|---|---|
| `contextWindow` | the catalog's `context_length` — what actually serves |
| `cost` | `pricing.prompt` / `pricing.completion` — the donor has no price at all |

A prefix relationship is not an identity: `cyberouter/glm-5.3` does **not**
inherit from `glm-5.3-flash`.

## Which models get published

A model appears only if the catalog lists it, `routeable_endpoint_count > 0`,
and it answers a request. `--no-check` skips the liveness probe.

As of 2026-10-03 that excludes three: `qwen3.8-flash` (listed with no healthy
route), and `kimi-k2.6` + `inkling` (healthy in the catalog, but the inference
provider answers `502 "Inference provider returned HTTP 410"`). The
`cyberouter/remediation` alias goes with them, because it routes by task score
and its two best remediation models are the dead ones.

## Router aliases

`cyberouter/auto` plus one per security task. They live in a sibling field of the
catalog, not inside `data`, so a parser that only reads `data` loses all five.
Their window and price depend on which concrete model the router picks per
request, so both are bounded: context at the catalog floor, price at the ceiling.

## Extension

`index.ts` registers the provider and keeps the model list in step with the
endpoint — adding ids the endpoint started serving, dropping ones it stopped. It
never invents a value. `PI_ENCLAVE_LIVE=0` freezes the catalog.

## Tests

```bash
node --experimental-strip-types scripts/test-sync.mjs
```

19 offline checks: bare-name stripping, the donor join, the near-miss guard, the
route filter, gateway ownership of context and price, and alias bounds.

## Privacy

The router fails closed on ZDR — it will not downgrade retention, health,
quantization or model to find a route. A model it cannot serve under those
constraints is simply unavailable.

## License

MIT
