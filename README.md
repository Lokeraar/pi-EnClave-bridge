# @lokeraar/pi-enclave-bridge

[![Version: 0.1.10](https://img.shields.io/badge/version-0.1.10-blue.svg)](https://www.npmjs.com/package/@lokeraar/pi-enclave-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

EnClave provider for [Pi](https://pi.dev).

Pi is a coding assistant that talks to AI models. EnClave is a gateway: one
address that reaches many models from many companies. The problem is that
EnClave tells Pi very little about each model — how much text it can read, how
much it can write back, whether it understands images, which "thinking effort"
settings it accepts. Without those numbers, Pi has to guess.

This package supplies them. When you run `/model` you see each model with its
real context window, its real price per million tokens, whether your key can
actually reach it, and the router's task aliases. Every number is read from a
catalog Pi already has on disk, so no extra account is needed.

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

That is all. The model list builds itself, and `/model` shows every model the
router serves for your key. Each one carries a note saying where its numbers came
from, so you can check them instead of trusting them.

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

EnClave's router lives at `https://router.enclave.ai/v1`. It speaks the same
language as OpenAI's API, so any tool built for OpenAI can talk to it. Its
`/models` address is unusually helpful: for each model it reports the context
window, the price per million tokens, and whether *your* key has a working route
to it.

But three things it never mentions matter just as much to a coding assistant:

- **Which thinking-effort values the model really accepts.** "Think harder" is a
  real setting, and models disagree about which values they honour.
- **Whether it can read images.**
- **How much output it will actually produce.**

When a tool is not told these, it fills them with round, plausible-looking
defaults — numbers that look like facts but were never measured. This package
finds them in Pi's own catalog and reports them. When no source states a value,
it leaves the value alone rather than inventing one.

## ⚙️ How it works

Every model needs values for the same handful of fields. Where each value comes
from follows one priority order, decided **field by field** — not model by model,
and not averaged:

```text
1. a hand-written vendor card (VENDOR_SPEC)
2. the catalog belonging to the model's own vendor
3. a simple majority among catalogs that state the field   (only if step 2 is absent)
4. OpenRouter                                              (only if step 3 has no majority)
5. whatever models.json already says                       (only if no catalog states the field)
```

**Why the vendor comes first.** Many of the catalogs Pi ships belong to
*resellers* — companies that host other companies' models. A reseller's catalog
describes what one gateway happens to accept. The vendor's own catalog describes
the model itself. When they disagree, the vendor is describing the thing; the
reseller is describing one doorway to it.

A concrete case: for `deepseek-v4.1-flash`, eight catalogs state an output ceiling
of 384,000 tokens — DeepSeek's own first among them — while OpenRouter alone says
943,718. The old rule published OpenRouter's figure, and this gateway rejected it.
The vendor's number is now the one published.

**How the vendor is found.** By the model's family name: `kimi` belongs to
Moonshot, `claude` to Anthropic, `gpt` to OpenAI, `glm` to zai, `deepseek` to
DeepSeek, `mimo` to Xiaomi, `nemotron` to NVIDIA. This cannot be worked out from
the files, because every catalog stamps its own name as the provider — including a
reseller stamping its name on a model it did not make. So the list is written down
explicitly, one line per family, exactly like the dated-model aliases.

**When there is no vendor catalog**, the catalogs vote. A value needs a *simple
majority* of those that state the field at all: three votes out of ten is not
agreement, it is a split, and a split falls back to OpenRouter. Nothing is ever
averaged — an average of two real numbers is a third number that nobody published.

**Thinking levels are decided one level at a time.** A model's
`thinkingLevelMap` says which effort levels work. It is not one value but seven
independent ones (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). If
the vendor states a level — even to say "not supported" with an explicit `null` —
that answer stands. If the vendor simply does not mention a level, that silence
says nothing, and only that single level is decided by the other catalogs. Two
consequences worth knowing:

- A reseller listing only two levels cannot erase the five its vendor declared.
- A vendor listing only one level does not block the others from being filled in.

**A ceiling as large as the window is treated as impossible, not generous.** Some
catalogs write the row that way: Moonshot lists `kimi-k3` with a context window of
1,048,576 and an output ceiling of 1,048,576 — the same number twice. But a prompt
must fit in the window alongside the output, so a ceiling that fills the whole
window cannot be served. That figure is treated as no answer at all, and the field
falls through to the catalogs that state a ceiling a model can keep.

**Two fields are never taken from a catalog at all.**

| Field | Why it belongs to EnClave |
|---|---|
| `contextWindow` | It describes what *this* gateway serves, not what the model can do. |
| `cost` | A price belongs to whoever charges it. Combining prices from several resellers would produce a number EnClave may never charge. |

The donor module can report an approximate minimum-to-maximum cost range when
asked directly, for inspection only. It is not published as a price.

**No account is needed to read these catalogs.** They are plain JSON files that
ship inside Pi itself, under `pi-ai/dist/providers/data/`. An API key is needed to
*call* a model; reading what Pi already installed on your disk needs nothing. A
brand-new Pi with no logins at all still gets the full catalog.

### 🔎 Two refresh phases

The list is built in two separate steps, and worth understanding because they do
different jobs.

| Phase | When it runs | What it does |
|---|---|---|
| **Restore from cache** | Every time Pi starts the provider | Rebuilds the list from `models.json` plus Pi's saved state. Instant, and works with no network. |
| **Refresh membership** | Interactive startup, and when you search in `/model` | Asks the endpoint which models exist right now, adds any that appeared, and drops any that disappeared. |

The second step only ever changes *who is on the list*, never what their numbers
are. The numbers come from `models.json`, which `scripts/sync-models.mjs` is the
only writer of.

One environment variable controls this: setting `PI_ENCLAVE_LIVE=0` freezes the
list, which is useful when you want to test without the network changing things
underneath you.

### 🏷️ Which models get published

A model is published only if all three of these hold: the router lists it, your
key has a working route to it, and it actually answers a request.

Listing is not enough, and there are three separate ways a listed model can turn
out to be unusable. Each is handled:

| What you see | What is really happening |
|---|---|
| Listed, but `routeable_endpoint_count: 0` — the check is `routeable_endpoint_count > 0` | You have no working route. Every request returns `404`. |
| Answers `502 "provider returned HTTP 410"` | The catalog calls it healthy, but the provider behind it is gone. `410 Gone` means permanently, not "try again later". |
| Simply absent from `/models` | Retired upstream. |

The third case caused a real failure worth naming: `cyberouter/remediation` is a
router alias that picks a model by task quality score. It kept failing because the
highest-scoring remediation model was one of the dead ones.

### 🔀 Router aliases

Five entries are not ordinary models. `cyberouter/auto` and one alias per security
task (`vuln-discovery`, `exploit-dev`, `remediation`, `triage`) are *instructions*:
you pick one and the router decides which concrete model to use, per request. They
behave like models, so they are published like models.

They are also the reason a naive parser breaks. The endpoint lists each of them
**twice** — once inside `data` and once in a sibling field of the catalog. Code
that reads only the sibling field loses all five. Code that reads only `data`
publishes each of them twice, with different windows, names and prices. This
package reads both and publishes each exactly once, taking the `data` entry
because it carries the endpoint's own window and name.

Their price cannot be known in advance, because the router picks the model later.
Rather than guess, the answer is bounded: priced at the catalog ceiling. If the
endpoint states no window either, the context falls back to the catalog's floor
value.

One thing is deliberately refused. These aliases are **never** looked up in a
catalog. OpenRouter also has a model called `auto`, advertising a 2,000,000-token
window. It is a different thing that happens to share a name, and using its numbers
here would be a lie.

## 🐞 Fixes

These are real problems that were found by using the thing, not by reading it.

**A ceiling bigger than the window is not generous, it is impossible.**
OpenRouter listed `inkling` with a 471,859-token ceiling against a 262,144-token
window here, and the endpoint refused every request with *"This request needs
about N tokens (messages + tools + max_tokens)"*. Fixed by clamping the ceiling to
the window minus a reserve for the prompt.

**The reserve has to survive a real conversation, not a test one.** The first
version held back 2,048 tokens, which is fine for the word "hi" and useless in
practice. The router counts `messages + tools + max_tokens` together against the
window, and a real Pi request carries the system prompt plus every tool's schema —
on the order of 20,000 tokens. `gpt-oss-120b` was publishing a 117,964-token
ceiling inside a 131,072-token window, leaving about 13,000 tokens for input.
Every call failed with `400` as soon as the conversation had anything in it.

**`maxTokens` must never be `null`.** Pi's model list calls `.toString()` on it,
crashes with *"Cannot read properties of undefined"*, and takes the entire list
down with it.

**`compat` is never copied from a catalog.** OpenRouter ships a field called
`thinkingFormat: "openrouter"` plus seven other flags describing how *OpenRouter*
wants reasoning requests framed. This gateway speaks the plain OpenAI shape,
verified by sending `reasoning_effort` and watching what came back. Copying those
flags would silently change the request format on a gateway where nobody tested
them.

**Accepting a value is not the same as implementing it.** For `glm-5.3`, the
gateway accepts all six effort levels. The vendor's own card says the model only
implements three of them. The extra three are accepted and then quietly ignored —
which is worse than refusing them, because Pi would offer you a thinking level
that does nothing at all.

**A claim and a silence are different things, and this applies per level.** If a
vendor states a thinking level — even `null`, meaning "not supported" — that
answer is final. If the vendor does not mention the level, that is silence:
another catalog's answer is used for that single level. So a reseller's short
list cannot delete levels the vendor declared, and a vendor's short list does not
block the missing ones from being filled in.

**A scoped package publishes as private by default.** `npm publish` failed with
`E402 "You must sign up for private packages"`, which sounds like a billing
problem and is not one: private packages need a paid plan. Fixed by declaring
`"publishConfig": { "access": "public" }` in the manifest, so a plain `npm
publish` does the right thing.

## 🔑 Authentication

```
/login EnClave
```

Your key is stored by Pi in `~/.pi/agent/auth.json`; you never edit it by hand.
The catalog itself needs no key — only the two network steps do: checking which
models your key can reach, and confirming they still answer.

## 📊 Models

Each model's values are worked out and written to `providers.EnClave.models` in
`models.json`. Every entry also records where its numbers came from, so you can
audit them rather than trust them:

```json
"donor": {
  "source": "openrouter",
  "matchedId": "qwen/qwen3.8-max-0902",
  "corroborating": ["opencode", "opencode-go", "qwen-token-plan", "…"],
  "rule": "corroborated"
}
```

`matchedId` is the **complete id, prefix included** — not the shortened name. That
matters because the same model carries different prefixes in different catalogs.
Keeping the full id means you can see exactly which entry was used, including
when it was found through a dated variant.

### What a donor may not set

| Field | Owner | Why |
|---|---|---|
| `contextWindow` | the live catalog | It states what this endpoint actually serves. |
| `cost` | the live catalog | A catalog's price is for a different reseller. |
| `compat` | never inherited | `thinkingFormat: "openrouter"` and friends describe how *OpenRouter* wants reasoning framed. EnClave speaks the OpenAI shape. |

### The ceiling clamp

An output ceiling larger than the context window is not an ambitious claim, it is
an impossible one: a request cannot ask for more room than the window contains.
The endpoint says so plainly:

> This request needs about N tokens (messages + tools + max_tokens)

So a catalog value is clamped to the window minus a reserve for the prompt. It
cannot be *equal* to the window either — measured directly, 262,144 was rejected
while 261,120 passed.

A value that already fits is used exactly as given. The clamp only removes
impossibilities; it never second-guesses a catalog that stayed inside the limit.

It helps to know what the published number actually means: it is a **ceiling, not
a fixed request size**. On every turn, Pi lowers it to
`min(published, contextWindow − prompt − 4096)`.

## 🧠 Reasoning controls

Every model gets a `thinkingLevelMap`, which says which thinking-effort levels it
really accepts. Think of it as a row of switches. A level set to `null` is a
switch that is simply not offered, so Pi picks the closest supported level instead
of sending one the gateway will reject. When `off: null` is set, thinking cannot
be turned off at all, and Pi hides that option completely.

Two models carry a hand-written vendor card that overrides what the catalogs claim,
because the catalogs are more optimistic than the models actually are:

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

This script is the only thing that writes to `models.json`. Run it without
arguments and it reports only — it shows what it would change and stops. Adding
`--dry-run` makes that explicit:

```bash
node --experimental-strip-types scripts/sync-models.mjs --dry-run
node --experimental-strip-types scripts/sync-models.mjs
```

Its report answers four questions: which source supplied each value, which other
catalogs agreed, what is still unknown, and what it deliberately excluded. When
you run it for real, it writes `models.json` and leaves a backup beside it.

To record a correction from a vendor's documentation, add it to `VENDOR_SPEC` in
`donors-enclave.ts` — and write down the reason in the same entry, so the next
person can check it against the model card instead of taking it on faith.

### Tests

```bash
node --experimental-strip-types scripts/test-sync.mjs
```

107 checks that run offline, with no network and no API key. They cover: matching
a model by its id and by its written name, near misses that must *not* match
(dated variants), authority of the model card and the vendor's family, reasoning
maps resolved level by level including partial vendor maps and explicit `null`
values, majority fallback, exclusion of router aliases, exclusion of `free`
models, rejection of impossible ceilings, handling of router aliases, and the
different folder layouts Pi can be installed into.

## License

MIT
