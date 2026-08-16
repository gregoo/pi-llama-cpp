# pi-llama-cpp

A [Pi Coding Agent](https://pi.dev/) extension that supercharges Pi's built-in [llama.cpp](https://github.com/ggml-org/llama.cpp) provider with **per-model thinking levels** and **named sampling parameter sets**.

## How it works

Pi ships a first-class `llama.cpp` provider: you point it at your server with `/login llama.cpp`, browse and load models with `/llama`, and switch between them with `/model`. This extension wraps that provider and adds two things the built-in catalog does not carry:

- **Thinking levels** — Pi's thinking selector (off, minimal, low, medium, high, xhigh, max) is translated into whatever your model's chat template understands (`thinking_budget_tokens`, `reasoning_effort`, `enable_thinking`, …), per model, via wildcard patterns.
- **Sampling sets** — named bundles of llama.cpp sampling parameters you can switch between per model during a session.

Everything else — server connection, authentication, model loading/unloading, context size detection — is owned by Pi's built-in provider. The extension never talks to the server itself.

## Features

- **Per-model thinking configuration** — wildcard-matched `llamaModelsConfig` entries define exactly which levels each model offers and what each level sends
- **Additive level specs** — combine `budget`, `effort`, `enable_thinking` and `preserve_thinking` freely on any level
- **Named sampling sets** — independent of thinking; select per model with `/sampling`, session-only
- **Generation stats** — real-time tokens/sec during decoding, a prefill progress bar, cache-hit and draft-acceptance (speculative decoding) figures, in its own widget slot
- **Live catalog** — the supercharged metadata is applied to Pi's live model list, so `/model` always shows the right levels for whatever is loaded

## Installation

This package is a Pi extension. Install it with

```bash
pi install https://github.com/gregoo/pi-llama-cpp
```

## Setup

1. **Connect your server** — run `/login llama.cpp` in Pi and set the base URL (e.g. `http://192.168.1.1:8080`). The value is stored as the `LLAMA_BASE_URL` credential for the built-in provider. When a model is loaded, the extension registers it as the provider's default so login selects it automatically instead of complaining that no default model is configured.
2. **Load models** — run `/llama` to browse your server's model router and load/unload models. Loaded models appear in Pi's model list.
3. **Pick a model** — use `/model` (or `--provider llama.cpp --model <id>` on the CLI) as usual.

## Commands

| Command            | Description                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `/sampling`        | Open the sampling set picker for the current model.                                             |
| `/sampling <name>` | Select the named sampling set for the current model directly.                                   |
| `/sampling none`   | Clear the selection (server/model defaults apply).                                              |

## Thinking Levels

The extension translates Pi's thinking level selector into something llama.cpp understands. By default every model uses numeric **thinking budgets** (`thinking_budget_tokens`):

| Level     | Tokens | Description                  |
| --------- | ------ | ---------------------------- |
| `off`     | —      | Thinking disabled            |
| `minimal` | 1,024  | Short reasoning steps        |
| `low`     | 2,048  | Light reasoning              |
| `medium`  | 8,192  | Balanced reasoning (default) |
| `high`    | 16,384 | Extended reasoning           |
| `xhigh`   | 32,768 | Deep reasoning               |
| `max`     | —      | Unlimited reasoning          |

Levels without a `budget` (like `max`) get no `thinking_budget_tokens` at all — unbounded by omission. The same applies to per-model entries below: omit the field instead of using a sentinel value.

Budget values can be overridden by adding a `thinkingBudgets` object to `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (per-project):

```json
{
  "thinkingBudgets": {
    "minimal": 256,
    "low": 1024,
    "medium": 2048,
    "high": 4096,
    "xhigh": 8192
  }
}
```

Only the `minimal` through `xhigh` budgets can be overridden — `off` and `max` are fixed: `off` always disables thinking via the chat template kwargs, and `max` is always unbounded.

### Per-model configuration (`llamaModelsConfig`)

Different models need different treatment (e.g., Qwen3.5 speaks named reasoning efforts, while Qwen3.6 only understands numeric budgets). The `llamaModelsConfig` setting — a dict of **wildcard model patterns** to entries in `.pi/settings.json` or `~/.pi/agent/settings.json` — lets you pre-configure exactly what gets sent to each model: a per-level **thinking map** and/or named **sampling sets**:

```json
{
  "llamaModelsConfig": {
    "qwen3.8*": {
      "thinkingLevelMap": {
        "off": { "enable_thinking": false },
        "minimal": { "effort": "low", "budget": 1024 },
        "low": { "effort": "low", "budget": 8192 },
        "medium": { "effort": "medium", "budget": 8192 },
        "high": { "effort": "xhigh", "budget": 8192 },
        "xhigh": { "effort": "xhigh" }
      },
      "samplingMap": {
        "thinking": {
          "temperature": 1.0,
          "top_p": 0.95,
          "top_k": 20,
          "min_p": 0.0,
          "presence_penalty": 0.0,
          "repeat_penalty": 1.0
        },
        "instruct": {
          "temperature": 0.7,
          "top_p": 0.8,
          "top_k": 20,
          "min_p": 0.0,
          "presence_penalty": 1.5,
          "repeat_penalty": 1.0
        }
      }
    },
    "qwen3.6*": {
      "thinkingLevelMap": {
        "off": { "enable_thinking": false },
        "low": { "budget": 2048 },
        "medium": { "budget": 8192 }
      }
    }
  }
}
```

How it works:

- **Pattern matching** — keys are matched against the model ID, `*` is a wildcard (e.g., `qwen3.5*` matches `qwen3.5-27b`). The most specific (longest) matching pattern wins; `"*"` acts as the catch-all entry. Project-level entries override global ones for the same pattern.
- **Per-level entries are additive** — each present level maps to an object whose fields are injected into the request payload:
  - `budget` (number) → `thinking_budget_tokens` (0 is a valid value; omit it for an unbounded level)
  - `effort` (string) → `chat_template_kwargs.reasoning_effort` (the exact effort names your model's chat template accepts)
  - `enable_thinking` (boolean) → `chat_template_kwargs.enable_thinking` (what actually toggles thinking off)
  - `preserve_thinking` (boolean) → `chat_template_kwargs.preserve_thinking` (model-specific; does not control thinking enablement — set it only when your model's chat template needs it)

  Fields can be combined freely (e.g., `effort` + `budget` on one level). An empty object `{}` makes the level available without adding anything to the payload — that's how `max` is expressed.

- **Level availability** — a level is only offered in Pi when it is present in the map. Holes (absent keys) and explicit `null` make the level unavailable (`null` to Pi, so it is hidden/skipped/clamped away), and the extension injects nothing for it.
- **No match** — when no pattern matches the model, the global default map above is used, with any `thinkingBudgets` overrides applied to the `minimal`–`xhigh` budgets.

Level names carry no special meaning in either path — the spec dictates what is injected, so a level with only `enable_thinking: false` disables thinking, a level with only `effort` sends just the effort, and an empty level sends nothing.

## Generation stats

While a llama.cpp model generates, the extension shows a status widget with:

- **Prefill** — a progress bar with prefill tokens/sec and an ETA when your llama.cpp build emits `prompt_progress` events (the extension requests them via `return_progress: true`). Builds without that support still get a token counter from the per-chunk `timings` field.
- **Decode** — live token count and tokens/sec (🔧 while streaming tool calls). When the server reports `timings`, its cumulative `predicted_n`/`predicted_per_second` are used — authoritative under speculative decoding, where one SSE chunk can carry several tokens. Otherwise a client-side rolling estimate is shown.
- **Final line** — prefill and decode totals kept visible until the next generation, e.g. `📖 27591 (27572 cached) @ 29.1 tok/s · ✨ 422 @ 28.1 tok/s · spec 76%`. The cache figure appears when prompt tokens were served from the KV cache, and the draft-acceptance percentage (`spec`) when the model runs speculative decoding (MTP, ngram, ...).

The stats are scoped to the built-in llama.cpp provider: decode speed comes from Pi's `message_update` events, and prefill from a fetch tap on that provider's own stream — no global `fetch` patching, and other providers are never touched.

### Sampling sets (`samplingMap`)

A `samplingMap` defines **named sets of sampling parameters** for a model, independent of the thinking level. There is no default sampling map — the server/model defaults apply until you select a set, and selecting nothing sends no sampling fields at all.

- **Selection** — `/sampling` shows a picker of the current model's sets (plus `none`); `/sampling <name>` selects directly; `/sampling none` clears. The selection is per model and session-only: switching models remembers each model's choice, and restarting Pi resets everything. When a set is active, the footer shows `sampling: <name>`.
- **Parameters** — set keys pass through **verbatim** to the request payload, so they must match the llama.cpp server's field names (e.g. `repeat_penalty`, not the HF/transformers `repetition_penalty`). All values are numbers. Unknown or non-numeric fields are dropped.
- **Supported fields** — `temperature`, `top_k`, `top_p`, `min_p`, `top_nsigma`, `typical_p`, `xtc_probability`, `xtc_threshold`, `repeat_penalty`, `penalty_last_n`, `presence_penalty`, `frequency_penalty`, `dry_multiplier`, `dry_base`, `dry_allowed_length`, `dry_penalty_last_n`, `adaptive_target`, `adaptive_decay`, `dynatemp_range`, `dynatemp_exp`, `mirostat`, `mirostat_lms_lr`, `mirostat_ent_max`, `seed`.

## Dependencies

| Peer dependency                   | Purpose             |
| --------------------------------- | ------------------- |
| `@earendil-works/pi-ai`           | Pi AI SDK           |
| `@earendil-works/pi-coding-agent` | Pi Coding Agent SDK |
| `@earendil-works/pi-tui`          | Pi TUI SDK          |
