# @lokeraar/pi-enclave-bridge

[![Version: 0.1.1](https://img.shields.io/badge/version-0.1.1-blue.svg)](https://www.npmjs.com/package/@lokeraar/pi-enclave-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

EnClave provider for [Pi](https://pi.dev). The live router catalog shows up in
`/model` with **real context windows, real per-token prices, live membership and
the router's task aliases** — resolved from the model catalog Pi already ships,
with no extra account required.

<a href="https://github.com/Gentleman-Programming/gentle-ai">
  <img width="220" src="https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/docs/assets/brand/built-with-gentle-ai.png" alt="Built with Gentle-AI" />
</a>

## 🔗 Where to find me

| | |
|---|---|
| 📦 **npm** | [`@lokeraar/pi-enclave-bridge`](https://www.npmjs.com/package/@lokeraar/pi-enclave-bridge) |
| 🌐 **Pi catalog** | [pi.dev/packages/@lokeraar/pi-enclave-bridge](https://pi.dev/packages/@lokeraar/pi-enclave-bridge) |
| ⭐ **Source** | [github.com/Lokeraar/pi-EnClave-bridge](https://github.com/Lokeraar/pi-EnClave-bridge) |

Install it in Pi:

```bash
pi install npm:@lokeraar/pi-enclave-bridge
```

> 💛 If this bridge ever saved you from guessing a model's limits, a ⭐ on the
> repo goes a long way. It is the only thing that helps somebody else find it,
> and it tells me which of these two bridges is worth polishing next. Every star
> is read by a human, and so is every bug report.

## 📋 Releases

### 0.1.1 — a clamp that left room for an actual prompt

The ceiling clamp kept back 2,048 tokens for the prompt. That router counts
`messages + tools + max_tokens` against the window, not the output alone, and a
real Pi call carries the system prompt plus every tool schema — order 20k
tokens. The reserve only covered a toy request.

`gpt-oss-120b` exposed it: a 131,072 window with a 117,964 ceiling left 13,108
tokens for input, below what Pi sends, so **every** call failed with `400` as
soon as the conversation carried anything. Measured with the same prompt:

```
input ~16k   ceiling 117964   HTTP 400   "needs about 133,972 tokens"
input ~16k   ceiling  98304   HTTP 200
input ~28k   ceiling  98304   HTTP 200
```

The published value is a ceiling, not a fixed request: Pi reduces it per turn to
`min(published, contextWindow − prompt − reserve)`. The reserve just had to be
realistic.

### 0.1.0 — first release

Values resolved from the model catalog Pi ships, with the vendor's model card
outranking every catalog. `/login` once and the live router catalog appears in
`/model` with real context windows, real per-token prices, live membership and
the router's task aliases.

## ⚡ Quick Start

```bash
pi install npm:@lokeraar/pi-enclave-bridge
```

Then log in once:

```
/login EnClave
```

The catalog builds itself. `/model` shows every model the router serves for your
key, with the values resolved and each one attributed to where it came from.

> **Local copies conflict.** If you also keep `enclave-bridge.ts` in
> `~/.pi/agent/extensions/`, remove it first. Two registrations of the same
> provider fight over the model list. `PI_ENCLAVE_LIVE=0` does not fix this; only
> removing one of them does.

## Why this package exists

EnClave's router (`https://router.enclave.ai/v1`) is an OpenAI-compatible
gateway, and its `/models` endpoint is unusually honest: it declares the context
window, the price per million tokens, and whether *your* key has a healthy route
to each model.

It is still silent on the things a coding agent actually needs to make decisions:
which reasoning-effort values the model implements, whether it takes images, and
how much output it will really produce. Left alone, a config file fills those
with round placeholder numbers that look exactly like facts.

This package resolves them, and never invents one.

## ⚙️ How it works

Two layers, in strict order:

```
the vendor's own model card  >  openrouter  >  the other 41 catalogs Pi ships
what is already in models.json is the fallback, used only when no catalog
knows the model at all
```

**The vendor's card outranks everything.** A catalog records what a *reseller*
believes a model accepts; the card records what the model *implements*. When they
disagree the catalog is usually not lying — it is describing the gateway's shape.
EnClave accepts all six effort values for `glm-5.3`; the card says the model only
implements low, high and max. The extra values are accepted and then ignored,
which is worse than not offering them: Pi would show a thinking level that
silently does nothing.

**OpenRouter leads the catalogs.** It is the largest model router in the world
and the catalog is its core business. The other catalogs Pi ships (42 of them)
confirm that a model exists and agree on its structure; they fill a field the ones
above left empty and never override.

**Nothing is averaged.** A number nobody published is not a consensus, it is an
invention. Where two sources disagree, the higher-ranked one wins and the other
is recorded as dissent.

**No credential is needed to read a catalog.** The files live in Pi's own package
(`pi-ai/dist/providers/data/`). A key is only needed to *call* an API, not to
read what Pi already installed — so a fresh Pi with no accounts anywhere still
gets the full catalog.

### 🔎 Two refresh phases

Pi drives the refresh; the extension never invents a value in it.

| Phase | When | What it does |
|---|---|---|
| **Cache-only restore** | Every runtime creation | Rebuilds the catalog from `models.json` plus the store. Instant, works offline. |
| **Live membership** | Interactive startup, `/model` search | Fetches `/models` and adds ids the endpoint started serving, drops ids it stopped. |

Live membership only ever changes *who* is in the list. The values come from
`models.json`, which `scripts/sync-models.mjs` owns.

Kill switch: `PI_ENCLAVE_LIVE=0` freezes the catalog.

### 🏷️ Which models get published

A model appears only if the router lists it, `routeable_endpoint_count > 0`, and
it answers a request.

Three ways a listed model can still be unusable, and all three are handled:

| Signal | What it means |
|---|---|
| listed, `routeable_endpoint_count: 0` | Your key has no healthy route. Every request 404s. |
| answers `502 "provider returned HTTP 410"` | The catalog calls it healthy; the inference provider behind it is gone. `410 Gone` is permanent, not a blip. |
| simply absent from `/models` | Retired upstream. |

The third one had a real effect: `cyberouter/remediation` is a router alias that
routes by task score, and it was failing because the top-scoring remediation
model was one of the dead ones.

### 🔀 Router aliases

`cyberouter/auto` plus one per security task (`vuln-discovery`, `exploit-dev`,
`remediation`, `triage`) are usable as a model and are published.

They live in a sibling field of the catalog, not inside `data`, so a parser that
only reads `data` silently loses all five. Their window and price depend on which
concrete model the router picks per request, so both are bounded rather than
guessed: context at the catalog floor, price at the catalog ceiling.

They are deliberately **never** resolved from a catalog. OpenRouter has a model
called `auto` too, advertising a 2,000,000 window — a different thing that shares
the name, and a lie here.

## 🐞 Fixes

**A ceiling that the window cannot hold is impossible, not large.** OpenRouter
listed `inkling` at 471,859 against a 262,144 window here, and the endpoint
refused it with *"This request needs about N tokens (messages + tools +
max_tokens)"*. Clamped to the window minus a prompt reserve.

**The reserve has to survive a real conversation.** 2,048 tokens covered a toy
request. This router counts `messages + tools + max_tokens` against the window,
not the output alone, and a real Pi call carries the system prompt plus every
tool schema — order 20k tokens. `gpt-oss-120b` had 13,108 tokens of input room
and **every** call returned `400` as soon as the conversation carried anything.

**`maxTokens` must never be `null`.** Pi's model list calls `.toString()` on it
and crashes with *"Cannot read properties of undefined"*, taking the whole list
with it.

**`compat` is never inherited from a catalog.** OpenRouter ships
`thinkingFormat: "openrouter"` plus seven other flags describing how *it* wants
reasoning framed. This endpoint speaks the OpenAI shape — verified by sending
`reasoning_effort` and watching what came back. Copying those flags would change
the request format on an endpoint they were never tested against.

**An accepted value is not an implemented one.** The endpoint accepts all six
effort levels for `glm-5.3`; the vendor card says the model only implements
low, high and max. The extras are accepted and then ignored, which is worse than
not offering them: Pi would show a thinking level that silently does nothing.

**A catalog that omits a key has not claimed anything.** An explicit `null` is a
claim and is applied; an absent key is silence and does not erase a known value.
Thinking maps are merged key by key, so a one-key catalog entry cannot delete a
seven-key one.

**A scoped package publishes private by default.** `npm publish` failed with
`E402 "You must sign up for private packages"`, which reads like a billing
problem and is not one: restricted packages need a paid plan. Declared in the
manifest as `"publishConfig": { "access": "public" }`.

## 🔑 Authentication

```
/login EnClave
```

The key lives in `~/.pi/agent/auth.json`, managed by Pi. The catalog needs no key;
only live membership and the liveness check do.

## 📊 Models

Values are resolved per model and written to `providers.EnClave.models` in
`models.json`. Each one records exactly where it came from:

```json
"donor": {
  "source": "openrouter",
  "matchedId": "qwen/qwen3.8-max-0902",
  "corroborating": ["opencode", "opencode-go", "qwen-token-plan", "…"],
  "rule": "corroborated"
}
```

`matchedId` is the **full id with its prefix**, not the short name, so a match can
be audited without guessing — including when it resolved through a dated vendor
slug.

### What a donor may not set

| Field | Owner | Why |
|---|---|---|
| `contextWindow` | the live catalog | It states what this endpoint actually serves. |
| `cost` | the live catalog | A catalog's price is for a different reseller. |
| `compat` | never inherited | `thinkingFormat: "openrouter"` and friends describe how *OpenRouter* wants reasoning framed. EnClave speaks the OpenAI shape. |

### The ceiling clamp

An output ceiling larger than the context can hold is not a bigger claim, it is an
impossible one — a request cannot ask for more output than the window contains,
and the endpoint says so:

> This request needs about N tokens (messages + tools + max_tokens)

A donor value is therefore clamped to the window minus a 2,048-token prompt
reserve. It cannot equal the window either: measured, 262,144 was rejected while
261,120 passed.

A value inside the limit is used exactly as given. The clamp removes
impossibilities; it does not second-guess the catalog.

In practice the published value is a **ceiling, not a fixed request**. Pi reduces
it per turn to `min(published, contextWindow − prompt − 4096)`.

## 🧠 Reasoning controls

Each model gets a `thinkingLevelMap`. A level mapped to `null` is not offered, so
Pi snaps to the nearest supported level instead of sending a value the gateway
refuses. `off: null` means thinking cannot be switched off and the option is
hidden entirely.

Two models carry a vendor card that narrows what the catalog claims:

| Model | Card says | Catalog claims |
|---|---|---|
| `glm-5.3` | 131 072 out · low, high, max · text only | 943 718 out · six levels |
| `glm-5.2` | 131 072 out · high, max · text only | 943 718 out · six levels |

## ⚙️ Configuration

| Variable | Effect |
|---|---|
| `ENCLAVE_API_KEY` | Credential for the maintenance script. The extension takes it from `/login`. |
| `PI_ENCLAVE_LIVE=0` | Kill switch — freezes the catalog. |

## 🚀 Development

```bash
git clone https://github.com/Lokeraar/pi-EnClave-bridge
cd pi-EnClave-bridge
npm test
```

### Where each value comes from

The catalog Pi ships is at:

```
<pi-ai>/dist/providers/data/<provider>.json
```

42 of them, keyed by API and then by model id. The directory name carries the
pi-ai version and a dependency hash, so it changes on every Pi update and any
stored path dies with it — the lookup therefore walks the tree at run time, asking
Node to resolve the copy Pi loads first and falling back to the agent's store.

Models whose id ends in `free` are skipped: they routinely ship with capabilities
cut down, so their numbers describe a reduced product.

### Maintaining the curated values

Report-only. It never writes without you asking, and the diff is the deliverable.

```bash
node --experimental-strip-types scripts/sync-models.mjs --dry-run
node --experimental-strip-types scripts/sync-models.mjs
```

It reports which donor supplied each value, who corroborated it, what is still
missing, and what it excluded. Then it writes `models.json` and leaves a backup.

To add a vendor correction, add it to `VENDOR_SPEC` in `donors.ts` with the reason
it exists, so a later reader can check it against the model card.

### Tests

```bash
node --experimental-strip-types scripts/test-sync.mjs
```

58 offline checks: bare-name matching and the near miss that must not match, the
model-card precedence, the strict donor order, nothing-averaged, free-model
exclusion, dated slugs, alias exclusion, the ceiling clamp, and a simulated Pi
update that renames the catalog folder.

## License

MIT
