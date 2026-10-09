# @lokeraar/pi-enclave-bridge

[![Version: 0.1.10](https://img.shields.io/badge/version-0.1.10-blue.svg)](https://www.npmjs.com/package/@lokeraar/pi-enclave-bridge)
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

Straight from the repository, if you would rather follow `main` than a release:

```bash
pi install git:github.com/Lokeraar/pi-EnClave-bridge
```

The git form tracks `main`, so it can change under you. Prefer npm unless you are
testing something specific, or a fix has not been published yet — during that
window this is the only way to get it. To pin a release:

```bash
pi install git:github.com/Lokeraar/pi-EnClave-bridge#v0.1.10
```


> 💛 If this bridge ever saved you from guessing a model's limits, a ⭐ on the
> repo goes a long way — it is the only thing that helps somebody else find it.
> Every star is read by a human, and so is every bug report.

## 📋 Releases

### 0.1.10 — vendor reasoning levels resolve key by key

An official catalog can declare a partial `thinkingLevelMap`. That does not mean
it owns levels it omitted. Each level now follows the same source rule as other
fields: the vendor decides if it explicitly declares that level (including an
explicit `null`); if it is silent, corroboration decides that key. A partial
Anthropic map can therefore supply `max` without erasing `low` or `high` that
other catalogs agree on. Added regression coverage for full official maps,
partial official maps, and explicit vendor nulls.

Tests: 107 passing, up from 100.

### 0.1.9 — the vendor's catalog decides, and agreement settles the rest

The order that decides a model's values has changed, and it was worth getting
wrong twice before it was right.

**The vendor's own catalog now decides.** For `deepseek-v4.1-flash`, eight
catalogs say `maxTokens` 384000 — DeepSeek's own first among them — and
openrouter alone says 943718, a figure this endpoint rejects. The published ceiling
followed openrouter, so it was wrong. A catalog the vendor maintains records
what the model implements; a reseller's records what one gateway accepts, and
gateways disagree.

**Models are matched to their vendor by family**: `kimi` → moonshotai,
`claude` → anthropic, `gpt` → openai, `glm` → zai, `deepseek` → deepseek,
`mimo` → xiaomi, `nemotron` → nvidia. It cannot be derived automatically —
every catalog stamps `provider` on its entries, but a reseller stamps its own
name on a model it resells — so it is data, one line per family.

**When there is no vendor catalog, the value most catalogs agree on stands.**
`qwen3.8-max` has no first-party catalog in Pi. It now publishes
`minimal: null` and `high: null`, which is exactly what this endpoint accepts:
`low`, `medium` and `xhigh` work; `minimal`, `off` and `high` return
`502 ... provider returned HTTP 400`. The rule found that without being told.

**A ceiling that reaches the model's own window is treated as silence.**
Moonshot lists `kimi-k3` with `contextWindow: 1048576` and `maxTokens: 1048576`
— the same number twice. A ceiling equal to the window leaves no room for the
prompt, so it cannot describe output; the field falls through to the catalogs
that state a ceiling a model can serve, and `kimi-k3` stays at 131072.

**A model is found by its human name as well as its id.** DeepSeek's catalog
writes `id: "deepseek-flash"` with `name: "DeepSeek V4.1 Flash"`, so the
endpoint's id and that name are one key once punctuation is stripped. This is
an exact match on a different field, not a similarity guess: dated variants
stay apart because the date is in the name too.

**`cost` is still never published from a catalog**, and never will be — a
price belongs to a reseller, so averaging prices from several would produce a
number nobody charges. What is available instead is a range, asked for
explicitly, showing the spread across every catalog.


### 0.1.8 — the maintenance script runs anywhere, and each alias is published once

`scripts/sync-models.mjs` is the only writer of `providers.EnClave.models`, and it
could not run at all in two independent ways. The result was a picker with ids and
names only: no context window, no ceiling, no price, no reasoning levels, because
the values were never written.

**Windows could not even start it.** `new URL(".", import.meta.url).pathname`
returns `/C:/Users/My%20Name/...` — a leading slash and percent-encoded spaces —
which Node rejects as a package name:

```
ERR_INVALID_MODULE_SPECIFIER: Invalid module "\C:\Users\My%20Name\...\donors-enclave.ts"
is not a valid package name
```

Fixing that is not enough on its own: a dynamic `import()` also refuses a bare
absolute Windows path (`C:\...`) with `ERR_UNSUPPORTED_ESM_URL_SCHEME`. Both are
now `fileURLToPath` / `pathToFileURL`, and `scripts/test-sync.mjs` carried the
same bug, so `npm test` ran nowhere but Linux.

**On every platform it imported a name that no longer existed.** The donor module
became `donors-enclave.ts` in 0.1.4, when the two bridges stopped overwriting each
other. `enclave-live.ts`, `package.json` and `test-sync.mjs` were updated;
`sync-models.mjs` was missed, so the script has failed with
`Cannot find module .../donors.ts` since that release.

**Each router alias was published twice.** The live catalog returns the five
`cyberouter/*` task aliases in **both** `data` and the sibling `aliases` array,
and both loops published them — the same id twice, with different windows, names
and prices. The alias fallback now only covers ids `data` does not carry, so the
entry keeps the endpoint's own window and name.

The price needed the other half of the same idea: an alias states no price (which
model the router picks decides it, per request), so the `data` entry published it
as `0` — free. The alias rule was already "price at the ceiling" for exactly that
reason, and now applies however the alias was reached. A value nobody published is
not a price of zero, it is an unstated one.

At this release, the suite has 107 offline checks and runs on Windows. It covers
one entry per router alias, the endpoint's own window and name, catalog matching
by id and normalized name, vendor authority, key-by-key reasoning resolution,
majority fallback, catalog discovery and the output ceiling clamp.

### 0.1.7 — a version you can read, and a bug report you can fill

Three gaps that made an incoming report unusable.

**No version.** A user running loose files in `~/.pi/agent/extensions` had no way
to tell which build they were on, and the diagnose script read the repository's
`package.json`, which does not exist next to an npm install. The version is now
exported, printed on load, and shown in the provider name in `/model`.

**No form.** `.github/ISSUE_TEMPLATE/bug-report.yml` asks for the one thing that
locates a cause: the diagnose output, which lists every directory searched for
the catalogs. Plus OS, Node version, Pi version, install method, and the provider
block with the key hidden.

**The diagnose was not in the package.** The form pointed at
`scripts/diagnose.mjs`, which existed on disk but was never committed, so the
command in the form would have failed on every version before this one. It ships
now, and runs with plain `node`, no flags, no repository.

### 0.1.6 — a broken catalog tree no longer takes the provider down

Pi refreshes every provider in one batch. An exception thrown while looking for
catalogs therefore aborted the batch for **all** of them, and Pi reported
`could not refresh N model catalogs` for providers that were working fine —
right after a successful `/login`:

```
Saved API key for EnClave, but local model state could not be synchronized
```

The credential was saved; the refresh that followed it failed. Every donor lookup
is now wrapped, and a catalog that cannot be read degrades to "no donors" instead
of throwing. A donor layer is an enhancement and is not allowed to take the
provider down with it.

The version comparison also split the path on `/`, which is wrong on Windows where
the separator is a backslash, so the pick was arbitrary there.

### 0.1.5 — catalogs from a flat install too

Catalogs can occupy several locations depending on how Pi was installed. The
bridge first discovers the active Pi package at runtime, then checks supported
agent-local store and flat-install layouts as fallbacks:

```
<active Pi package>/node_modules/@earendil-works/pi-ai/dist/providers/data
<agent>/npm/node_modules/.pnpm/@earendil-works+pi-ai@…/node_modules/…/pi-ai/dist/providers/data
<agent>/npm/node_modules/@earendil-works/pi-ai/providers/data
```

The first path is not hardcoded: Pi may be global, local, under a custom prefix,
or installed by a different package manager. A flat install may have no `.pnpm`
and no `dist`. If Pi upgrades its bundled `pi-ai`, restart Pi or refresh the
provider so the bridge reads the updated catalogs.

Two bugs fixed alongside it. The sibling roots were built from
`dirname(agentDir)` as if that were the home directory, which for
`agentDir = ~/.pi/agent` produces the nonsense `~/.pi/.pi/agent`. And the root
walk tested an entry for `@` before testing it for `+`, so a pnpm entry like
`@earendil-works+pi-ai@0.85.1_hash` — which is both — was treated as an empty
scope and skipped, losing the very copy being looked for.

### 0.1.4 — find the catalog by content, and stop the two bridges colliding

Discovery was keyed on the package name, so a store named after a different
package returned nothing. It is now by content: any package containing
`dist/providers/data/*.json` counts, whatever it is named.

Two bridges installed a file called `donors.ts` into the same extensions
directory, so whichever was copied last overwrote the other. Here it was worse
than lost time: the model cards for `glm-5.3` and `glm-5.2` are what keep their
ceilings at `131,072`, a value this endpoint actually accepts. With an empty
table instead, both would have dropped to a placeholder and started failing every
call with a `400`.

Renamed per bridge, so installing one can never displace the other.

### 0.1.3 — find the catalog by content

First pass at the same fix, before the flat install shape was known.

### 0.1.2 — documentation

Links in both directions, so the npm page and the source repo point at each
other, and a note asking for a star. No behaviour change.

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

> **First check how the older copy was installed.** Pi can load an extension as
> an installed package, or directly from a `.ts` file in `~/.pi/agent/extensions/`.
> If both copies are present, both can register EnClave and conflict. Updating a
> package does not remove a loose file.
>
> `pi list` shows installed packages. If this package is already listed from npm,
> update it in place:
>
> ```bash
> pi update npm:@lokeraar/pi-enclave-bridge
> ```
>
> If `pi list` shows it was installed from git, update that same source instead:
>
> ```bash
> pi update git:github.com/Lokeraar/pi-EnClave-bridge
> ```
>
> **Do not run both commands.** Use the one that matches the source already
> installed; switching sources can leave two package entries. If you also have
> an old loose EnClave file in `~/.pi/agent/extensions/`, remove it or move it
> outside that folder, then restart Pi. `PI_ENCLAVE_LIVE=0` only turns off model
> refresh; it does not remove a duplicate extension.

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

The rules are applied per field, in this order:

```text
hand-written vendor card (VENDOR_SPEC)
  > the catalog belonging to the model's official vendor
  > simple majority among catalogs that state the field (only when there is no vendor catalog)
  > OpenRouter fallback (when there is no vendor catalog or majority)
  > values already kept in models.json, when no catalog states the field
```

**The official vendor catalog is authoritative for the values it actually
states.** A reseller's catalog describes what one gateway accepts; the vendor's
catalog describes the model itself. The vendor is mapped by model family because
resellers stamp their own provider name on models they resell. If there is no
first-party catalog in Pi, the value most catalogs agree on wins. A simple
majority is required; a plurality falls back to OpenRouter. Nothing is averaged.

**Thinking levels follow the same rule one key at a time.** An explicit vendor
value — including `null` — decides that level. If the vendor omits a level, that
is silence, and corroboration decides only that key. This lets a partial official
map coexist with values other catalogs state, without allowing a reseller to
replace levels the vendor did declare.

A ceiling equal to or above its catalog's own context window is treated as an
impossible claim and falls through. `contextWindow` belongs to the endpoint and is never overwritten by a donor.
`cost` is not published from a bundled catalog: prices belong to resellers, so
combining them would make up a price EnClave may not charge. The donor module
exposes a min/max cost range for inspection only.

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

The endpoint lists them twice: once inside `data` and once in a sibling field of
the catalog. Both are read, and each alias is published **once** — from the `data`
entry, which carries the endpoint's own window and name. A parser that reads only
one of the two either loses all five (sibling only) or publishes each of them
twice with different values (`data` only).

Their price depends on which concrete model the router picks per request, so it is
bounded rather than guessed: at the catalog ceiling. When the endpoint states no
window either, the context falls back to the catalog floor.

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

**Catalog claims are resolved per field, and thinking maps per key.** An
explicit vendor value — including `null` — is authoritative. If the vendor omits
a thinking level, that omission is silence; only that level falls through to
the other catalogs and their majority rule. A reseller's partial map cannot
replace levels the vendor declared, and a partial vendor map can be completed
from corroboration.

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

Pi bundles one catalog per provider inside `pi-ai`:

```text
<active Pi package>/node_modules/@earendil-works/pi-ai/dist/providers/data/<provider>.json
```

The bridge discovers Pi's active package at runtime; it does not hardcode a
Termux, Windows, global-prefix or agent-specific path. It reads the catalogs in
that active package whether or not the user has logged into those providers.
Supported agent-local store and flat-install layouts are fallbacks. Updating Pi
updates this source of model knowledge; restart Pi or refresh the provider to
load the new catalogs.

Models whose id ends in `free` are skipped: they routinely ship with capabilities
cut down, so their numbers describe a reduced product.

#### The order

```
the vendor's own model card
  > the catalog named after the model's vendor
  > the value most catalogs agree on
  > openrouter
  > what is already written
```

**The vendor's own catalog decides, and it is not one vote among many.** A
catalog the vendor maintains records what the model implements. A reseller's
records what one gateway happens to accept, and gateways disagree: for
`deepseek-v4.1-flash`, eight catalogs say `maxTokens` 384000 — DeepSeek's own
first among them — while openrouter alone says 943718, a figure this endpoint
rejects. So when the vendor's number differs from everybody else's, the
vendor's number is the one published.

**A model is matched to its vendor by family**, not by guessing: `kimi` belongs
to Moonshot, `claude` to Anthropic, `gpt` to OpenAI, `glm` to zai, `deepseek` to
DeepSeek. This cannot be derived automatically — every catalog stamps
`provider` on its entries, but a reseller stamps its own name on a model it
resells. So it is recorded as data, one line per family, the same way the dated
model aliases are recorded.

**When there is no vendor catalog, agreement decides.** A model like
`qwen3.8-max` has no first-party catalog in Pi, and there the value most
catalogs agree on is what stands. It needs a simple majority of the catalogs
that state the field: three votes out of ten is a plurality, not corroboration,
and a plurality falls back to openrouter. Nothing is averaged — a number nobody
published is not a consensus, it is an invention.

**A ceiling that reaches the model's own window is treated as silence.** Some
catalogs write the row that way: Moonshot lists `kimi-k3` with
`contextWindow: 1048576` and `maxTokens: 1048576`, the same number twice. A
ceiling equal to the window leaves no room for the prompt that goes with it, so
it cannot be a statement about output, and the field falls through to the
catalogs that state a ceiling a model can serve.

**A model is found by its human name as well as its id.** Pi's vendor catalog
writes `id: "deepseek-flash"` with `name: "DeepSeek V4.1 Flash"`, so the id the
endpoint uses and that name are the same key once punctuation is stripped. This
is an exact match on a different field, not a similarity guess, which is what
keeps it safe: `deepseek-v4-flash` and `deepseek-v4-flash-0731` stay apart
because the date is in the name too, and `glm-5.3` never reaches `glm-5.3-flash`.


### Maintaining the curated values

Report-only. It never writes without you asking, and the diff is the deliverable.

```bash
node --experimental-strip-types scripts/sync-models.mjs --dry-run
node --experimental-strip-types scripts/sync-models.mjs
```

It reports which donor supplied each value, who corroborated it, what is still
missing, and what it excluded. Then it writes `models.json` and leaves a backup.

To add a vendor correction, add it to `VENDOR_SPEC` in `donors-enclave.ts` with the reason
it exists, so a later reader can check it against the model card.

### Tests

```bash
node --experimental-strip-types scripts/test-sync.mjs
```

107 offline checks: bare-id and normalized-name matching, dated near misses,
model-card and vendor-family authority, per-key reasoning maps (including
partial official maps and explicit nulls), majority fallback, alias exclusion,
free-model exclusion, impossible ceiling rejection, router-alias handling, and
simulated catalog layouts.

## License

MIT
