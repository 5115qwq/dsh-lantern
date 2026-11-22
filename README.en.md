# LANtern · LAN Model Gateway

> Expose every model registered in your local **DeepSeek Harness** to the LAN over **OpenAI- and Anthropic-compatible endpoints**.
> Ships API keys, rate limiting with circuit breaking, capability gating, a four-tier reasoning contract, failover and usage statistics.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.2-green.svg)](https://github.com/5115qwq/dsh-lantern/releases)
[![Platform](https://img.shields.io/badge/DSH-%E2%89%A50.1.5-7c3aed.svg)](https://github.com/deepseek-ai/deepseek-harness)

> **This repository is a fork of [Saretheya/dsh-lantern](https://github.com/Saretheya/dsh-lantern).**
> The original was written by [@Saretheya](https://github.com/Saretheya) under the MIT license.
> This fork adds a large set of fixes, capability completions and a rebuilt interface. See [Lineage & credits](#lineage--credits).

---

## Contents

- [What problem it solves](#what-problem-it-solves)
- [Features](#features)
- [Installation](#installation)
- [Quick start](#quick-start)
- [API reference](#api-reference)
- [Core concepts](#core-concepts)
- [Configuration](#configuration)
- [Usage statistics](#usage-statistics)
- [Diagnostics](#diagnostics)
- [Known limitations](#known-limitations)
- [Security](#security)
- [Lineage & credits](#lineage--credits)

---

## What problem it solves

DeepSeek Harness registers many AI models locally — possibly across several providers, accounts and quota pools.
But those models are **only reachable from the machine running DSH**: your phone, tablet, another PC, or any other
tool on the LAN cannot use them.

LANtern translates the DSH model catalog **into a standard API** on the LAN:

```
┌──────────────────────────────────────────────────────┐
│  Any client on the LAN                                │
│  Mobile app · IDE plugin · scripts · another DSH       │
└───────────────────┬──────────────────────────────────┘
                    │  http://192.168.1.x:3080/v1
                    ▼
┌──────────────────────────────────────────────────────┐
│  LANtern (this plugin)                                │
│  auth → rate limit → capability gate → reasoning      │
│  → failover → bookkeeping                             │
└───────────────────┬──────────────────────────────────┘
                    │  ctx.llm.stream(...)
                    ▼
┌──────────────────────────────────────────────────────┐
│  DeepSeek Harness (local)                             │
│  providers · models · quotas · upstream credentials   │
└──────────────────────────────────────────────────────┘
```

**Key design: the plugin never copies, proxies or persists upstream credentials.**
It only reads the model catalog already registered in DSH and issues requests through
DSH's own channel (`ctx.llm.stream()`). SSE decoding, call contracts and artifacts stay inside DSH;
this plugin handles **protocol translation and policy only**.

---

## Features

| Feature | Description |
|---|---|
| **Three protocols** | OpenAI Chat Completions · Anthropic Messages · OpenAI Responses — one model, three ways to call it |
| **Streaming & non-streaming** | Both paths share the same failover and degradation rules |
| **Four-tier reasoning contract** | Exposes `minimal` / `low` / `medium` / `max` externally, maps internally to each model's real vocabulary |
| **Capability gate** | Per-parameter state is `supported` / `unsupported` / **`unknown`**; `unknown` is forwarded as-is, never treated as unsupported |
| **Failover** | One public model can bind several upstreams; ordered by health, retried on failure |
| **Health cooldown** | Failing upstreams enter exponential backoff; cooling upstreams are skipped outright |
| **Background self-check** | When every upstream is cooling, requests get an immediate 503 while a sweep probes recovery |
| **API keys** | Per-key rate limits; plaintext retrievable at any time; keys never expire |
| **Usage stats** | Per model / key / provider / call type / time window; HTML report + CSV + PNG export |
| **Attachment ledger** | Tracks only attachments created by this plugin, reclaimed on expiry (dry-run by default) |
| **Full observability** | 30+ `X-Lantern-*` response headers explaining each result |

---

## Installation

In **Settings → Plugins → Add plugin**, paste either form:

```
https://github.com/5115qwq/dsh-lantern
```

```
github:5115qwq/dsh-lantern
```

**Restart DeepSeek Harness** after installation.

> **Manual install**: download `dsh-lantern-vX.Y.Z.zip` from [Releases](https://github.com/5115qwq/dsh-lantern/releases),
> extract it, and place the `dsh-lantern/` directory into
> `%USERPROFILE%\.dsh\profiles\<profile>\node_modules\`. Then restart DSH.
> Both methods install identical content.

### Requirements

| Item | Requirement |
|---|---|
| DeepSeek Harness | ≥ 0.1.5 (needs `dsh-llm` and `dsh-client-ui-slots`) |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| Network | The plugin makes no outbound requests itself; traffic goes through DSH |

---

## Quick start

### 1. Create an API key

DSH → **Settings → LANtern → API Keys** → enter a label → **Generate key**.

The list shows a fingerprint. **The plaintext is persisted —— click "View" or "Copy" at any time. Keys never expire.**

### 2. Confirm the listener

**Listener & ports** offers two modes:

| Mode | Behavior | When to use |
|---|---|---|
| `reuse` | Reuses DSH's existing port, exposing only `/v1/*` | Recommended. No extra port, coexists with DSH |
| `standalone` | The plugin listens on its own port | DSH listens on loopback only but you need LAN access |

> **Note**: in `reuse` mode the bind address comes from DSH's `--host` launch argument; the plugin cannot change it.
> If DSH starts with the default `--host 127.0.0.1`, the LAN cannot connect. The panel reports the **actual** bind address,
> not the configured expectation. To serve the LAN, start DSH with `--host 0.0.0.0` or switch to `standalone`.

### 3. Connect a client

**OpenAI SDK (Python)**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://192.168.1.100:3080/v1",
    api_key="sk-your-plaintext",
)

resp = client.chat.completions.create(
    model="your-model-name",
    messages=[{"role": "user", "content": "Hello"}],
    max_tokens=1000,
)
print(resp.choices[0].message.content)
```

**Anthropic SDK (Python)**

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://192.168.1.100:3080",
    api_key="sk-your-plaintext",
)

msg = client.messages.create(
    model="your-model-name",
    max_tokens=1000,
    messages=[{"role": "user", "content": "Hello"}],
)
print(msg.content[0].text)
```

**curl**

```bash
# List models
curl http://192.168.1.100:3080/v1/models \
  -H "Authorization: Bearer sk-your-plaintext"

# Chat
curl http://192.168.1.100:3080/v1/chat/completions \
  -H "Authorization: Bearer sk-your-plaintext" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-model-name",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 500
  }'

# Streaming
curl -N http://192.168.1.100:3080/v1/chat/completions \
  -H "Authorization: Bearer sk-your-plaintext" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-model-name",
    "stream": true,
    "messages": [{"role": "user", "content": "Count to ten"}]
  }'
```

---

## API reference

### Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/messages` | Anthropic Messages |
| `POST` | `/v1/responses` | OpenAI Responses |
| `GET` | `/v1/models` | Model list (OpenAI shape, with capability extensions) |
| `GET` | `/v1/models/{id}` | Single model detail |
| `GET` | `/v1/lantern/health` | Health check (includes memory segments) |

All three conversation protocols **share one core**: auth, rate limiting, capability gating,
reasoning contract, failover and bookkeeping. Protocol modules only translate formats —
this is deliberate, so the protocols cannot drift apart.

### `/v1/models` extension fields

```jsonc
{
  "id": "your-model-name",
  "object": "model",
  "owned_by": "lantern",
  "reasoning_efforts": ["minimal", "low", "medium", "max"],

  "x-lantern": {
    "custom": true,
    "bindings": ["real-model-name@provider"],
    "capabilities": {
      "contractLevels": [
        { "level": "minimal", "word": "low" },
        { "level": "low",     "word": "high" },
        { "level": "medium",  "word": "high" },
        { "level": "max",     "word": "max" }
      ]
    },
    "capabilitiesByBackend": [
      { "backend": "#1", "reasoningEfforts": ["low", "high", "max"] }
    ]
  }
}
```

`contractLevels[].word = null` means that level is unsupported and will degrade to the nearest available one.

---

## Core concepts

### Four-tier reasoning contract

**Problem.** Each upstream uses a different vocabulary for reasoning strength:

| Upstream | Example vocabulary |
|---|---|
| A | `light` / `high` / `extra_high` |
| B | `low` / `high` / `max` |
| C | `high` only (single tier) |
| D | No reasoning parameter at all |

Passing the client's value through verbatim means "client said `medium`, upstream ignored it" — silently broken.

**Solution.** Expose exactly four tiers externally; map internally per model.

```
client requests  →  target position  →  upstream receives
──────────────────────────────────────────────────────
minimal              0/3                 vocab[0]
low                  1/3                 vocab[round(1/3 × (n-1))]
medium               2/3                 vocab[round(2/3 × (n-1))]
max                  3/3                 vocab[n-1]
```

**All three protocols converge on one entry point:**

```jsonc
// OpenAI Chat Completions
{ "reasoning_effort": "medium" }

// OpenAI Responses
{ "reasoning": { "effort": "medium" } }

// Anthropic Messages
{ "thinking": { "type": "enabled", "budget_tokens": 8000 } }
```

**With multiple upstreams** the gateway converts per backend and reports both:

- `X-Lantern-Effort-Served` — the aggregated position
- `X-Lantern-Effort-Head` — the word actually sent to the first backend

If a binding's vocabulary contains only switch words (`off` / `on`), no tier mapping is possible and
the gateway returns an explicit `switch-only` error **instead of silently disabling reasoning**.

### Capability gate: `unknown ≠ unsupported`

| State | Meaning | Handling |
|---|---|---|
| `supported` | Confirmed available | Forwarded |
| `unsupported` | **Confirmed** unavailable | Parameter stripped, reported via headers and panel |
| `unknown` | **Cannot confirm** | **Forwarded as-is**, let the upstream decide |

**`unknown` is never equivalent to `unsupported`.** This is a design invariant.

Capability facts come from: static provider declarations, runtime learning from failures,
active probes in the panel, and manual overrides in `data/capabilities.json`.

When a parameter is stripped, the client is told:

```http
X-Lantern-Dropped-Params: tools,tool_choice
X-Lantern-Capability-Unverified: parallel_tool_calls
```

### Failover and health cooldown

A public model can bind multiple upstreams; failures automatically try the next one:

```http
X-Lantern-Failover-Chain: 3
X-Lantern-Served: #2
X-Lantern-Attempt-Codes: #1=backend_timeout(+600s),#2=ok
```

| Failure type | Cooldown | Backoff |
|---|---|---|
| First-byte timeout / `429` / `5xx` | Yes | Exponential (default 600s base, configurable cap) |
| Reasoning-only / completely empty reply | Yes | **Fixed base cooldown, no exponential growth** |
| Client cancelled | No | — |
| 4xx parameter error | No | — |

> **Why empty replies do not escalate**: such failures usually mean the current `max_tokens` budget
> was too small and self-heal once the client adjusts. Treating them as backend faults could make a
> single small-budget request lock a model out for a long time.

When every upstream cools down, requests get an immediate 503 plus a background sweep:

```json
{
  "error": {
    "message": "All upstreams are cooling down, please retry later",
    "code": "model_unavailable",
    "allCooling": true
  }
}
```

A successful probe clears the cooldown immediately.

### Custom models

**A custom model = one public name + a set of upstream bindings.** Clients see only the name;
routing and failover happen internally.

| `customOnly` | Behavior |
|---|---|
| `true` (recommended) | Expose **only** custom models — a clean, controlled catalog |
| `false` | Expose every model in the DSH catalog (possibly hundreds) |

Names may contain letters, digits, underscore, dot, hyphen and slash; **`@` is reserved**
as the real-public-name separator.

### API keys

Keys are created in the panel and **never expire**.

Each row offers **View** and **Copy** — **the plaintext is persisted in `data/keys.json`** so it can be
retrieved at any time.

> **Why store plaintext**: if only a hash were kept, the sole remedy after forgetting the key would be to
> regenerate it, forcing every client to reconfigure. Repeated forgetting means repeated key rotation,
> which costs more in practice than storing plaintext. The `data/` directory is local: anyone able to read it
> can also edit the config and see DSH's own upstream credentials, so plaintext storage **does not widen the
> attack surface**. Two boundaries remain: plaintext **never appears in any external API response** and
> **is never written to logs**.

| Operation | Effect |
|---|---|
| **Disable** | The key itself is unchanged and immediately rejected; re-enabling requires no client change |
| **Delete** | Irreversible. Historical usage is kept and marked "deleted" |

`auth.allowAnonymous: true` lets any client on the subnet connect without a key — **the panel flags this risk prominently**.

---

## Configuration

File: `data/config.json` (editable in the panel, or directly then restart)

### `limits`

| Field | Default | Meaning |
|---|---|---|
| `maxConcurrent` | `100` | Global concurrency cap |
| `reserveForLocal` | `1` | Slots reserved for DSH's own conversations |
| `perKeyRpm` | `100` | Requests per key per minute |
| `perKeyTpm` | `80000` | Tokens per key per minute |
| `maxTokensCap` | `0` | Upper bound for `max_tokens` (`0` = no cap) |
| `maxBodyBytes` | `4194304` | Request body limit (4 MB) |
| `requestTimeoutMs` | `600000` | **First-byte** timeout |
| `maxConcurrentTools` | `8` | Parallel tool calls per request |
| `breaker.enabled` | `true` | Circuit breaker master switch |
| `breaker.consecutiveRateLimits` | `20` | Consecutive rate limits before opening |
| `breaker.cooldownSec` | `60` | Breaker cooldown |
| `backendHealth.enabled` | `true` | Health memory switch |
| `backendHealth.cooldownSec` | `3600` | Base cooldown |
| `backendHealth.maxCooldownSec` | `7200` | Exponential backoff ceiling |

> **Timeout is a first-byte timeout**: the timer clears once the first substantive chunk
> (text / reasoning / tool call) arrives. Long-thinking models that emit nothing for tens of
> seconds are normal and are not misjudged as timed out.

### Other sections

```jsonc
{
  "enabled": true,
  "listenEntries": [{ "id": "default", "mode": "reuse", "bind": "127.0.0.1", "port": 3080, "enabled": true }],
  "protocol": { "openai": true, "anthropic": true, "responses": true },
  "auth": { "format": "sk", "allowAnonymous": false },
  "cors": { "enabled": false, "origins": [], "allowCredentials": false },
  "exposure": { "maskTopology": true, "maskInternalHints": true },
  "customOnly": true,
  "allowImageInput": true,
  "usage": { "enabled": true, "reuseWithinSec": 60, "keepReports": 20, "maxLedgerBytes": 16777216 },
  "perfTest": { "timeoutMs": 20000 },
  "attachments": { "dryRun": false, "reclaimDelayMs": 300000, "sweepIntervalMs": 300000, "checkSessionRefs": true }
}
```

`exposure.maskTopology` controls whether the health endpoint reveals upstream topology
(provider names, model mappings, breaker detail). **Keep it on when sharing screenshots.**

---

## Usage statistics

The panel reports per **model / API key / provider / call type / key × model**, including:

- Today / this week / this month / this year cards
- Month-over-month change and daily average
- Per-model sparkline
- Selectable window (current month / last 1, 7, 30, 90 days)
- Deleted keys and offline models hidden by default, expandable on demand

**Only calls through this plugin are counted**, not DSH's own conversations.

### HTML report

A self-contained single file, openable offline and safe to send.

Nine tables: overview cards · by model · by provider · by key · by call type ·
daily/weekly/monthly/yearly trends · top-100 detail.

Exports: **CSV** (all rows, UTF-8 BOM so Excel opens it correctly) and **PNG** (current trend chart at 2× scale on white).

### Ledger

`data/usage.jsonl`, one line per call, appended.

---

## Diagnostics

Every `X-Lantern-*` header explains *why* this result happened:

| Header | Meaning |
|---|---|
| `X-Lantern-Served` | Which chain entry served the request |
| `X-Lantern-Attempts` | Total attempts |
| `X-Lantern-Attempt-Codes` | Per-entry result, e.g. `#1=backend_timeout(+600s),#2=ok` |
| `X-Lantern-Failover-Chain` | Chain length |
| `X-Lantern-Failover-Skipped` | Skipped bindings and reasons |
| `X-Lantern-Effort-Contract` | Requested tier |
| `X-Lantern-Effort-Served` | Aggregated word actually served |
| `X-Lantern-Effort-Head` | Word actually sent to the first backend |
| `X-Lantern-Effort-Votes` | Per-backend conversions |
| `X-Lantern-Effort-Winner` | Winning result and mode (`scaled` / `exact`) |
| `X-Lantern-Dropped-Params` | Stripped parameters |
| `X-Lantern-Capability-Unverified` | Unknown-but-forwarded parameters |
| `X-Lantern-Message-Roles` | Role sequence actually sent |
| `X-Lantern-Tools-Sent` | Whether tool definitions were sent |
| `X-Lantern-Queue-MS` | Queue wait time |
| `X-Lantern-Concurrency` | Concurrency usage |
| `X-Lantern-Max-Tokens` | `max_tokens` actually sent |
| `X-Lantern-Warnings` | Aggregated warnings |

### Status codes

| Status | Scenario |
|---|---|
| `400` | Bad parameters (invalid tier, empty messages, malformed JSON) |
| `401` | Key invalid / missing / disabled |
| `404` | Model or endpoint not found, or protocol disabled |
| `429` | Rate limited |
| `503` | All upstreams cooling / empty upstream reply / breaker open |

### Internal failure codes

| Code | Meaning | Cooldown |
|---|---|---|
| `backend_timeout` | First-byte timeout | Yes |
| `reasoning_only_empty` | Reasoning but no text | Yes (no escalation) |
| `empty_completion` | Completely empty | Yes (no escalation) |
| `tool_markup_leaked` | Tool markup leaked into text | Yes |
| `binding_offline` | Bound upstream unavailable | No |
| `switch-only` | Vocabulary is switch-only, no tier mapping | No |

### Troubleshooting

**LAN cannot connect** — check the listener mode (`reuse` inherits DSH's `--host`), check the firewall,
and read the panel's *actual* bind address.

**401 from a client** — confirm the key is enabled, and that the header is
`Authorization: Bearer sk-xxx` or `x-api-key: sk-xxx` with no stray whitespace.

**First request is slow** — the upstream may genuinely be slow (thinking models can think for tens of seconds),
the tier may be cooling (look for `(+600s)` in `X-Lantern-Attempt-Codes`), or failover is walking the chain
(look at `X-Lantern-Attempts`).

**503 "all upstreams cooling"** — wait for the cooldown, or use *Health & diagnostics → Clear memory* to reset.

**`max_tokens` seems ignored** — this is DSH kernel behavior, not this plugin. The plugin forwards `max_tokens`
verbatim (shrinking only when it exceeds `maxTokensCap`). `X-Lantern-Max-Tokens` shows the value actually sent.

**Thinking model returns reasoning but no text** — increase `max_tokens`. Reasoning consumes the budget;
the plugin has a budget boost that retries once, but a generous budget is still recommended.

---

## Known limitations

| Limitation | Note |
|---|---|
| `reuse` bind address | Determined by DSH's `--host`; the plugin cannot change it |
| `max_tokens` ceiling | Ultimately decided by the upstream; the plugin can shrink but not raise it |
| Single-tier upstreams | Cannot express tier differences; all four tiers collapse to one word (see `contractLevels`) |
| Attachment reclamation | `dryRun` by default; must be turned off to actually delete |
| Usage ledger | Rolls over at the size cap; rolled-over part is not counted |

---

## Security

**Threat model.** Exposing to the LAN means **any client on the subnet may reach it**:

1. **Always set API keys** — do not enable `allowAnonymous` unless you fully trust the network
2. **Never bind `0.0.0.0` on a public network** — home LAN is fine; public Wi-Fi or office networks are not
3. **Watch usage statistics** — anomalous call volume is the first signal of unauthorized access
4. **Keep `exposure.maskTopology` on** — screenshots will not leak upstream topology

### What lives in `data/`

| File | Content | Sensitivity |
|---|---|---|
| `config.json` | Plugin config | Low (no upstream credentials) |
| `keys.json` | **API key plaintext and hashes** | **High** |
| `usage.jsonl` | Call ledger (model names, token counts, key fingerprints) | Medium |
| `capabilities.json` | Capability probe results | Low |
| `attachment-ledger.json` | Attachment references | Low |

> **Upstream credentials are never here** — they live in DSH's own configuration, which this plugin does not read or copy.

---

## Lineage & credits

This repository is a **fork of [Saretheya/dsh-lantern](https://github.com/Saretheya/dsh-lantern)**.

- **Original author**: [Saretheya](https://github.com/Saretheya)
- **Upstream repository**: https://github.com/Saretheya/dsh-lantern
- **Original license**: MIT
- **Upstream last commit**: 2026-10-03

Thanks to the original author for the architecture and the foundational implementation —
the three-protocol compatibility layer, the model catalog abstraction, the capability learning
mechanism and the first version of the four-tier reasoning contract all originate upstream.
This fork would have been far more work without them.

### What this fork changed

| Area | Summary |
|---|---|
| **Fixes** | Crash from malformed system messages (`content.some is not a function`); reasoning silently disabled on switch-only vocabularies; timeouts misclassified as empty replies |
| **Reliability** | Cooldowns now skip rather than reorder; empty replies no longer escalate exponentially; all-cooling returns an immediate 503 with a background sweep |
| **Capabilities** | Three-state capability gating refined; four-tier contract made consistent across all three protocols; tool-call capability detection |
| **Statistics** | Usage stats rebuilt (aggregation by the client-facing model name, month-over-month and daily average, sparklines, time-window filter); HTML report rebuilt (440 KB → 57 KB); CSV and PNG export |
| **Interface** | Collapsible panel sections, key bulk actions with search and sort, relative timestamps, merged diagnostics page, narrow-screen layout |
| **Engineering** | 792 offline regression checks (including integrity guards for module exports, panel field alignment and message shape); dead code from removed features dropped |

### Version numbering

This fork numbers independently from **1.0.0** (upstream is `0.1.x`) to keep the two code bases distinct.
Current version: **1.0.2**.

### License

MIT, inherited from upstream. See [LICENSE](./LICENSE).

---

<p align="center">
  <sub>Put the model quotas you already have to work across your whole LAN.</sub>
</p>