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

## Three states of "you can't use this"

Only the first is obvious, and the third is the one that will bite you.

1. **`not-listed`** — a successful fetch stopped returning the id.
2. **`not-routable`** — the id *is* listed, but `routeable_endpoint_count` is `0`
   for your key. The router fails closed and every request 404s:

   > No routeable endpoint matched filters (healthy, zdr, data_collection).
   > Cyberouter fails closed: it will not downgrade ZDR, health, quant, or model.

   Publishing such a model is the ghost-model bug: it looks selectable and fails
   100% of the time. As of 2026-10-03 that is `cyberouter/qwen3.8-flash`, which
   also has no published price.
3. **`upstream-gone`** — the catalog says the model is healthy
   (`routeable_endpoint_count > 0`) but the inference provider behind it is
   gone. The router tunnels it as `502` with:

   > Inference provider returned HTTP 410

   `410 Gone` is a permanent HTTP semantic, not a blip, and the gateway's own
   catalog has not caught up. `cyberouter/kimi-k2.6` and `cyberouter/inkling`
   were retired on this basis, after two sightings separated by more than two
   minutes:

   ```bash
   node --experimental-strip-types scripts/probe-models.mjs --retire-upstream
   ```

   This signal never fires from the refresh path, only from that deliberate
   sweep — see below for why the separation matters.

States 1 and 2 are the gateway asserting structure, so they retire an id
automatically and are cleared as soon as the gateway lists it again. State 3 is
the gateway being *wrong*, so it is different in two ways:

- It requires **two sightings separated by at least two minutes**. A deployment
  can be pulled for maintenance and returned, and a proxy can mislabel a
  temporary condition as `410`. One observation is a data point; two are
  evidence.
- It is **never cleared by the refresh path**. `reconcileRetired` only clears
  retirements whose reason the gateway asserts about itself; otherwise the very
  next refresh would resurrect the model, because the catalog still lists it as
  routable. Only the sweep revives an `upstream-gone`, and only after the model
  actually answers.

Retiring those two models also repaired the `cyberouter/remediation` alias,
which routes by `task_perf` and had been picking the highest-scoring
remediation model — `kimi-k2.6` at 0.802 — which is one of the dead ones.

Retirements live in `<agentDir>/enclave-retired.json` with the reason, and are
enforced offline: a retired id is never restored from the store, so it cannot
resurrect. Self-correcting — an id the endpoint serves again is un-retired with
its curated values intact.

## The router is a tunnel — read the body, not just the status

EnClave proxies other providers, and when the upstream rejects a request the
router answers **`502`** with a body naming the upstream status:

```
POST /chat/completions  max_tokens=262144   → 200
POST /chat/completions  max_tokens=393216   → 502 "Inference provider returned HTTP 400"
POST /chat/completions  max_tokens=1048576  → 400 "This request needs about 1,048,594 tokens
                                                (messages + tools + max_tokens)"
```

A `502` carrying an upstream `400` is a **parameter rejection wearing a 5xx
costume**. Judging by status alone throws away a valid measurement and loses the
real output ceiling — which is exactly what happened here: 12 of 14 models
reported `probe-failed` until the classifier started reading the body. So
`classifyFailure` prefers the upstream status when the body carries one:

| Upstream status in body | Treated as |
|---|---|
| `400`, `422` | parameter rejection — a real measurement |
| `410` | upstream permanently gone — reported, not auto-retired |
| anything else | not a measurement |

A bare `502`, or `402`, `401`, `403`, `429`, transport errors, remain
non-measurements.

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

## Donor layer — reusing another provider's curated values

The same open-weight model is often sold through several gateways. The facts
about the *model* — which `reasoning_effort` enum it accepts, whether it takes
images — do not change with the seller. Everything about the *gateway* does.

So this bridge can read another provider's curated layer and inherit those
model-intrinsic values, indexed by **bare model name** (the id with any
`vendor/` prefix stripped on both sides). By default it reads the sibling
`opendesign` provider from the same `models.json`; override in
`<agentDir>/enclave-donor.json`:

```json
{
  "enabled": true,
  "modelsJson": "/path/to/models.json",
  "provider": "opendesign",
  "authority": true
}
```

**What may cross over:**

| Field | Inherited | Why |
|---|---|---|
| `reasoning` | ✅ | A vendor that rejects a value rejects it through every reseller |
| `thinkingLevelMap` | ✅ | Same — it is the vendor's enum, not the router's |
| `input` | ✅ | And it beats EnClave's `modality`, which is a templated fill |
| `contextWindow` | ✅, clamped | The donor sets it; it may not exceed what the gateway declares |
| `maxTokens` | ✅, clamped | The donor sets it; it may not exceed what we already have evidence for |

`cost` is the only field the donor never owns. It has no price at all, so
inheriting it would publish every model as free.

### Every path goes through one funnel

`finalize()` / `finalizeAll()` is the single place a model is built: normalize,
then donor. Retirement is a list operation — a single model cannot remove itself
— so it lives in `finalizeAll()` and nowhere else.

This exists because the layers used to be applied per-path by hand, and each
omission was a silent bug that shipped:

1. the offline baked snapshot skipped the retirement ledger, so retired models
   stayed selectable;
2. the eagerly registered snapshot skipped the ledger too, from a second door;
3. the offline path then skipped the donor as well, so `pi --list-models` — which
   never touches the network — showed vanilla `16.4K` max-out and `no` images for
   the four models the donor governs, while the live path showed the inherited
   values for the same models.

The third one is the reason this is a funnel and not a patch. A reader of
`pi --list-models` is looking at the offline path; if that disagrees with the
live path, the offline path is what they will believe.

### The snapshot's provenance is machine-generated, not curated

The baked snapshot carries explicit provenance: `gateway` for the figures it
read from the catalog, `vanilla` for the `16384` output placeholder. It must
not be left to `normalize()`'s "absent provenance means curated" invariant,
because a snapshot is generated by a script, not written by a person. Labelling
it `curated` made the clamp believe `16384` was evidence, so the donor's `232000`
lost to `Math.min(232000, 16384)` and the max-out inheritance silently did
nothing.

### The clamp, and why the direction matters

The donor's numbers are accepted **clamped to the evidence already in hand**: it
may *lower* a value, never raise it above something already confirmed. A field
with no evidence yet is filled outright, so a wider window is adopted there.

The direction is the whole point. Adopted unchecked, a donor claiming a wider
window than the endpoint serves would be a false claim published as truth.
Adopted clamped, the worst case is that Pi under-promises a model that could
have done more — which costs capability and never correctness.

Verified against the live endpoint on 2026-10-03: **every** donor value for
these fields is *lower* than what EnClave actually allows, for all four matching
models. The clamp never binds, and the donor's numbers stand:

| Model | ctx donor / real | max out donor / measured |
|---|---|---|
| `glm-5.3-flash` | 1 048 000 / 1 048 576 | 128 000 / 524 288 |
| `deepseek-v4-pro` | 1 048 000 / 1 048 576 | 232 000 / 524 288 |
| `deepseek-v4.1-flash` | 1 048 000 / 1 048 576 | 232 000 / 524 288 |
| `deepseek-v4-flash` | 1 048 000 / 1 048 576 | 232 000 / 262 144 |

What this costs: Pi will now cap output at 232k for the DeepSeek family where
EnClave would have allowed 524k. That is a real loss of headroom, taken
deliberately in exchange for a single source of truth. **A sighting is not a
retirement**, and the reverse also holds — **a value is not a fact just because
the donor says so**: the clamp still stands between the donor and any claim the
endpoint has already contradicted.

### The donor is the source of truth

By default (`authority: true`) the donor **overrides** the probe and the local
curated layer for the same base model. Precedence for the inheritable fields:

```
donante  >  enclave-curated.json  >  medición del probe  >  store  >  gateway
```

This is a deliberate inversion, and it has a real cost. Where the two disagree,
you publish the donor's claim instead of a value confirmed on this endpoint:

| Model | was (measured here) | now (donor rules) |
|---|---|---|
| `glm-5.3-flash` | `mlmhxm` | `lhm` — Pi stops offering `minimal` and `medium` |
| `deepseek-v4.1-flash` | `lhxm` | `mlmhxm` — Pi now offers `minimal` and `medium` |

`deepseek-v4-pro` and `deepseek-v4-flash` are unaffected: donor and measurement
agree there.

To restore evidence-first behaviour, set it explicitly in
`<agentDir>/enclave-donor.json`:

```json
{ "authority": false }
```

With `false`, the donor only fills fields that have no evidence yet and any
successful probe wins. The measurements are not deleted either way — they stay
in `<agentDir>/enclave-curated.json`.

Whatever the mode, the origin written is `inherited` — never `curated` and
never `measured` — so a reader can always tell which values were confirmed on
this endpoint and which were carried in.

### Why it is a prior and not a truth

Measured on this gateway, 2026-10-03, against what the donor claims:

| Model | donor (amr-link) | measured (enclave) | |
|---|---|---|---|
| `deepseek-v4-pro` | `mlmhxm` | `mlmhxm` | ✅ |
| `deepseek-v4-flash` | `mlmhxm` | `mlmhxm` | ✅ |
| `glm-5.3-flash` | `lhm` | `mlmhxm` | ⚠️ donor **too restrictive** |
| `deepseek-v4.1-flash` | `mlmhxm` | `lhxm` | ⚠️ donor **too permissive** |

The misses go in **both** directions. A different host accepts a different slice
of the enum, and nothing in the donor can tell you which way. That is the
argument for measuring here — and the reason a probe, when it succeeds, always
overrides the donor.

Matching is **exact on the bare name**. `cyberouter/glm-5.3` does not inherit
from `glm-5.3-flash`: a prefix relationship is not an identity, and those are
different checkpoints at different prices.

## What actually gets probed

Only the reasoning levels and the output ceiling, because the catalog says
nothing about either. Measured 2026-10-03:

| Model | ctx | max out | effort accepted | `off` |
|---|---|---|---|---|
| `glm-5.3-flash` | 1 048 576 | 524 288 | minimal low medium high xhigh max | rejected |
| `glm-5.2` | 1 048 576 | 262 144 | all six | `none` |
| `deepseek-v4-pro` | 1 048 576 | 524 288 | all six | `none` |
| `deepseek-v4.1-flash` | 1 048 576 | 524 288 | low high xhigh max | `none` |
| `deepseek-v4-flash` | 1 048 576 | 262 144 | all six | `none` |
| `qwen3.8-max` | 1 010 000 | 524 288 | low max | rejected |
| `kimi-k3` | 1 048 576 | 262 144 | all six | `none` |
| `gpt-oss-120b` | 131 072 | 32 768 | all six | `none` |
| `minimax-m3` | 524 288 | 393 216 | all six | rejected |
| `nemotron-ultra` | 262 144 | 131 072 | all six | `none` |
| `glm-5.3` | 1 048 576 | — | probe did not settle |
| `kimi-k2.6`, `inkling` | — | — | upstream 410 gone |

Note the `off` column: `none` means accepted **and** verified to produce zero
reasoning tokens. `rejected` means the gateway refused it, so Pi hides the
option instead of sending a value that would 400. A probe measures `reasoning_effort` acceptance per level,
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
| `PI_ENCLAVE_PROBE=1` | Opt **in** to probing brand-new ids during refresh (off by default — see below) |
| `PI_ENCLAVE_REPROBE=1` | Re-check curated values against the endpoint and write `<agentDir>/enclave-reprobe.json` |

### Why probing is off by default in the refresh path

A probe is ~16 sequential requests per model. On a fourteen-model catalog that is
three minutes, and `refreshModels` is awaited during interactive startup — so
probing there trades a correct catalog for a TUI that appears to hang.

The gateway declares context and price correctly, and the donor fills reasoning
levels, so the default refresh publishes accurate values immediately. Measuring
is a deliberate step: `probe-models.mjs --all`, or `PI_ENCLAVE_PROBE=1` if you
want it automatic. A circuit breaker also caps the damage: after three
consecutive non-measurements, probing is abandoned for the rest of the refresh.

## Tests

```bash
node --experimental-strip-types scripts/test-bridge.mjs
```

77 checks against a **mock** gateway: live membership, the routability filter,
both retirement signals, ledger-blocked offline resurrection, the
500-is-not-a-measurement rule, the tunnelled `502`/upstream-`400` rule, upstream
`410` is not a rejection, measured vs gateway provenance, ceiling conservatism,
curated precedence, and every donor rule including the `maxTokens` trap and the
near-miss guard, donor authority over a measurement, the rule that a donor
missing a field never blanks a known value, the two-strike upstream-gone sweep,
and a direct assertion that the offline static catalog publishes the same values
as the live path.

## Endpoint state (measured 2026-10-03)

The router was briefly returning `500` on every chat request during the first
recon; it recovered within the hour. Do not treat any single observation as
durable — run the CLI to see the current state. As measured:

| | |
|---|---|
| `GET /v1/models` | `200`, 14 models + 5 aliases |
| `POST /v1/chat/completions` | `200` on 15 of 19 ids |
| `qwen3.8-flash` | `404` — no routeable endpoint (matches `routeable_endpoint_count: 0`) |
| `kimi-k2.6`, `inkling`, `remediation` | `502` — upstream returned `410 Gone` |
| latency | 0.6–2.6 s per call; a full `--all` probe is ~3 minutes |

## Fixing a broken `models.json`

Pi drops the **entire** `models.json` if a single entry fails schema validation —
and its `input` only allows `text` and `image`. An entry declaring
`["text","image","audio","video"]` is invalid, which silently kills every
provider in the file, including the inline `apiKey` markers that authenticate
them.

If `pi --list-models` prints `Warning: errors loading models.json` and your
providers vanish, that is why. Check with:

```bash
jq -r '.providers | to_entries[] | .key as $p | .value.models[]
        | select(.input|length>2) | "\($p)/\(.id)"' ~/.pi/agent/models.json
```

Audio and video are not representable in Pi's model schema at all; trim the
array to `["text","image"]`. Doing that restored both this bridge and the
`opendesign` curated layer in one shot.

## Privacy

The router **fails closed on ZDR** (Zero Data Retention). It will not downgrade
retention, health, quantization or model to find a route. A model it cannot
serve under those constraints is simply unavailable — which is what makes the
`not-routable` signal trustworthy rather than a transient health blip.

## License

MIT