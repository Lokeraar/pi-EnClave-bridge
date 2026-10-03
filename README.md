# pi-EnClave-bridge

EnClave provider bridge for [Pi](https://pi.dev). `/login` once and the live
router catalog appears in `/model` with **real context windows, real per-token
prices, live membership and the router's task aliases** — auto-synced from
`https://router.enclave.ai/v1`.

Local install:

```bash
cp index.ts enclave-live.ts ~/.pi/agent/extensions/
mv ~/.pi/agent/extensions/index.ts ~/.pi/agent/extensions/enclave-bridge.ts
```

Then `/reload`. Do **not** leave it named `index.ts`: every `extensions/*.ts` is
loaded as an extension factory, so a generic name collides and registers the
provider twice.

## Why this bridge exists

Most gateways expose `/models` and nothing else: just a list of ids. A coding
agent then has to *guess* a context window, an output ceiling and which
reasoning levels exist, and every guess looks exactly like a fact.

EnClave is not most gateways. Its catalog is OpenRouter-shaped and it already
**declares** the values that matter:

| Field | What it gives |
|---|---|
| `context_length` | The real window per model: 131 072 / 262 144 / 524 288 / 1 010 000 / 1 048 576 |
| `pricing.prompt` / `.completion` | Real USD **per 1M tokens** — the same unit Pi's `cost` uses |
| `routeable_endpoint_count` | Whether *your key* has a healthy route right now |
| `aliases` | Five router pseudo-models, including `cyberouter/auto` |

So this bridge does not re-derive what the endpoint already states. It trusts
those fields, probes only the two things the endpoint is silent about, and
labels every value with where it came from.

## Provenance: "is this value real?"

Every published model carries a `provenance` block:

| Origin | Meaning |
|---|---|
| `measured` | A request was made and the answer observed |
| `gateway` | The endpoint's own claim — context, price, modality |
| `curated` | Hand-written in `<agentDir>/enclave-curated.json` |
| `vanilla` | A conservative default, because nothing better existed |

Two fields are **never** `measured`, on purpose:

- **`contextWindow` cannot be probed.** An over-long prompt is silently
  truncated, which is indistinguishable from success. It stays `gateway`.
- **`input` is a weak claim.** `architecture.modality` is currently the literal
  string `"text"` for all fourteen models with `tokenizer:"unknown"`, which
  looks like a templated fill rather than a real declaration. It is reported as
  `gateway` and never as `measured`. Audio/video in the catalog are not
  representable in Pi's model schema.

`cacheRead`/`cacheWrite` are `0` because the catalog publishes no cache rates.
That `0` means *unpriced by the endpoint*, not *free* — hence the label.

## Two retirement signals

EnClave can retire a model two ways, and only the obvious one gets caught:

1. **`not-listed`** — a successful fetch stopped returning the id.
2. **`not-routable`** — the id *is* listed, but `routeable_endpoint_count` is `0`
   for your key. The router fails closed and every request 404s:

   > No routeable endpoint matched filters (healthy, zdr, data_collection).
   > Cyberouter fails closed: it will not downgrade ZDR, health, quant, or model.

   Publishing such a model is the ghost-model bug: it looks selectable and fails
   100% of the time. As of 2026-10-03 that is `cyberouter/qwen3.8-flash`, which
   also has no published price.

Both are recorded in `<agentDir>/enclave-retired.json` with the reason, and both
are enforced offline: a retired id is never restored from the store, so it
cannot resurrect. Self-correcting — an id the endpoint serves again is
un-retired with its curated values intact.

## Router aliases

The catalog has a sibling field `aliases`, **not inside `data`,** so any parser
that only reads `data` silently loses all five:

```
cyberouter/auto             → best model per task (sort: task_perf)
cyberouter/vuln-discovery   → best for vulnerability discovery
cyberouter/exploit-dev      → best for exploit development
cyberouter/remediation      → best for remediation
cyberouter/triage           → best for triage
```

An alias has no window and no price of its own — both depend on which concrete
model the router picks per request. They are **bounded**, not guessed, and the
asymmetry is deliberate:

- **Context = the smallest window in the catalog.** A guaranteed floor: some
  routed model is the narrow one.
- **Price = the largest price in the catalog.** An upper bound, because
  understating what a call will cost is the worse error.

Capability fields are biased low. Money fields are biased high.

## What actually gets probed

Only the reasoning levels and the output ceiling, because the catalog says
nothing about either. A probe measures `reasoning_effort` acceptance per level,
the real semantics of `off`, and walks the output ceiling upward.

The walk reports the **last accepted candidate**, which is a floor on the real
ceiling and never an overstatement of it.

Only HTTP `400`/`422` count as a measurement. Quota (`402`), auth (`401`/`403`),
no-route (`404`), rate limit (`429`), `5xx` and transport errors are
request-level failures that say nothing about a model — deriving values from
them is how a probe concludes "no reasoning, 16k ceiling" while the account
simply cannot pay or the router is down.

## Maintenance CLI

Report-only. It never writes; the diff is the deliverable.

```bash
node --experimental-strip-types scripts/probe-models.mjs            # free: catalog only
node --experimental-strip-types scripts/probe-models.mjs --all      # also probes (costs tokens)
node --experimental-strip-types scripts/probe-models.mjs --json
```

## Curated layer

Hand-tuned values go in `<agentDir>/enclave-curated.json`:

```json
{ "models": [ { "id": "cyberouter/glm-5.3", "maxTokens": 131072 } ] }
```

Curated entries are authoritative for their values and are never overwritten by
the live layer. That is what makes the file the right place to record something
the gateway does not declare.

## Environment

| Variable | Effect |
|---|---|
| `ENCLAVE_API_KEY` | Credential for the CLI. The extension takes it from `/login` |
| `PI_ENCLAVE_LIVE=0` | Kill switch — freezes the catalog |
| `PI_ENCLAVE_REPROBE=1` | Re-check curated values against the endpoint and write `<agentDir>/enclave-reprobe.json` |

## Tests

```bash
node --experimental-strip-types scripts/test-bridge.mjs
```

28 checks against a **mock** gateway: live membership, the routability filter,
both retirement signals, ledger-blocked offline resurrection, the 500-is-not-a-
measurement rule, measured vs gateway provenance, ceiling conservatism, and
curated precedence.

## Known endpoint state (2026-10-03)

`GET /v1/models` answers `200`. **`POST /v1/chat/completions` answers `500
Internal Server Error` from Vercel on every model, every alias, with and
without `stream:true`, and with OpenRouter-style headers.** Without a
credential it answers `401`, so the key is valid — this is an upstream router
failure, not a local one.

The consequence: reasoning levels and output ceilings cannot be measured yet.
The bridge degrades honestly — those fields stay `vanilla` and say so in
`provenance`, instead of inventing values. When the router recovers:

```bash
node --experimental-strip-types scripts/probe-models.mjs --all
```

## Privacy

The router **fails closed on ZDR** (Zero Data Retention). It will not downgrade
retention, health, quantization or model to find a route. A model it cannot
serve under those constraints is simply unavailable — which is what makes the
`not-routable` signal trustworthy rather than a transient health blip.

## License

MIT