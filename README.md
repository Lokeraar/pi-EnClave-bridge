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

## Donors: where the values come from

A **donor** is another list of models whose values get copied onto ours, matched
on the **bare model name** — the id with any `vendor/` prefix stripped on both
sides, so `cyberouter/glm-5.3-flash` matches `glm-5.3-flash`. A prefix
relationship is not an identity: `cyberouter/glm-5.3` does **not** inherit from
`glm-5.3-flash`.

There are two kinds, and they are not equal in authority.

### The order

```
what is already in models.json  >  openrouter  >  the rest of Pi's catalogs
```

There is **no hand-written donor**, and none is required. Two reasons:

- A list maintained by a person goes stale. The person maintaining it will,
  eventually, be wrong and not notice.
- It would be a prerequisite: every user would need an account with an obscure
  provider before the extension does anything useful. A hand-written list also
  cannot travel with the package — it belongs to whoever wrote it, not to
  everyone who installs it.

So the donor is the catalog **Pi already ships**:

```
pi-ai/dist/providers/data/<provider>.json
```

42 of them, and reading a file needs **no credential** — a key is only needed to
CALL an API, not to read what Pi installed. A fresh Pi install with no accounts
anywhere still resolves the full catalog.

```
openrouter   the primary donor. It is the largest model router in the world and
             the catalog is its core business, so the numbers are kept by
             people who cannot afford to be wrong.
the rest     corroboration only. They confirm the model exists and agree on its
             structure; they fill a field the ones above left empty and never
             override.
```

**What is already written wins**, because it is specific to this endpoint. Inside
a 5% band the catalog takes over, since `128_000` and `131_072` are the same
number written differently and the second is exact. Outside the band they
genuinely disagree and what is written stands.

**Nothing is ever averaged.** A number nobody published is not a consensus, it is
an invention — and averaging a correct catalog against a wrong one produces a
value neither stands behind. Where catalogs disagree, the higher-ranked one wins
and the others are recorded as dissent.

`compat` is deliberately **never** inherited from a catalog. OpenRouter ships
`thinkingFormat: "openrouter"` and friends, which describe how *OpenRouter*
wants reasoning sent. EnClave speaks the OpenAI shape — that is how it was
verified, by sending `reasoning_effort` and watching what came back. Copying
those flags would change the request format on an endpoint they were never
tested against.

### What no donor may set

| Field | Owner | Why |
|---|---|---|
| `contextWindow` | the live catalog | it is what this endpoint actually serves |
| `cost` | the live catalog | a donor's price is for a different reseller |

### Router aliases are never resolved

`cyberouter/auto` is EnClave's own pseudo-model. OpenRouter has an `auto` too,
advertising a 2,000,000 window — a different thing that happens to share the
name, and a lie here. Aliases are left vanilla on purpose.

### The one clamp: an impossible ceiling

An output ceiling larger than the context can hold is not a bigger claim, it is
an impossible one — a request cannot ask for more output than the window
contains. EnClave rejects it outright:

> This request needs about N tokens (messages + tools + max_tokens)

OpenRouter lists `inkling` at 471,859 against a 262,144 window here, so this is
not hypothetical. The ceiling is clamped to the window **minus a 2,048-token
prompt reserve**. Note it cannot equal the window either: measured on `inkling`,
262,144 was rejected while 261,120 passed.

A value inside the limit is used exactly as given. The clamp removes
impossibilities; it does not second-guess the donor.

`maxTokens` must also never be `null`: Pi's model list calls `.toString()` on it
and crashes with `Cannot read properties of undefined`.
