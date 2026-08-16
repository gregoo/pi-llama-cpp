# pi-llama-cpp

A [Pi Coding Agent](https://pi.dev/) extension that integrates with running [llama.cpp servers](https://github.com/ggml-org/llama.cpp) to provide live model browsing, loading, and switching directly from Pi.

## Features

- **Auto-detect models** — discovers all models available on your running llama.cpp server
- **Live status indicators** — see which models are loaded, loading, failed, sleeping, or unloaded with color-coded icons
- **Load / unload / switch** — manage models directly from the Pi command palette
- **Multi-model router support** — works with both single-model and multi-model llama.cpp server configurations
- **Image capabilities detection** — detects multimodal models automatically
- **Flexible URL resolution** — configures the server URL via project config, environment variable, or global settings
- **Auth support** — allows to login into a llama.cpp server that was secured with an API key
- **Multiple server support** — connect to multiple llama.cpp servers simultaneously by separating URLs with semicolons
- **Thinking level support** — configurable token budgets or named reasoning efforts for model reasoning/thinking, mapped to Pi's thinking levels
- **Real-time progress tracking** — live loading progress via SSE (falls back to polling)

### Status Indicators

| Icon | Status       | Description                            |
| ---- | ------------ | -------------------------------------- |
| 🟢   | Loaded       | Model is active and ready to use       |
| 🟡   | Loading      | Model is currently being loaded        |
| 🔴   | Failed       | Model failed to load                   |
| 🔵   | Sleeping     | Model is available, but inactive       |
| ⚪   | Unloaded     | Model is not loaded on the server      |
| ⛔   | Unauthorized | Model can't be used (API key required) |

> **Note**: The `Sleeping` status only shows when you start your server with `llama-server --sleep-idle-seconds <n> ...`.
> This is a **llama.cpp server flag** that tells the server to put idle models to sleep after `n` seconds.
> The model awakens automatically when you send a message.

> **Note:** You can run your server with API authentication with `llama-server --api-key <your key> ...`.

## Installation

This package is a Pi extension. Install it with

```bash
pi install npm:pi-llama-cpp
```

or

```bash
pi install https://github.com/gsanhueza/pi-llama-cpp
```

## Configuration

The extension resolves the llama.cpp server URL(s) using the following priority order:

1. **Per-project config** — `.pi/settings.json` in your project root:

   ```json
   {
     "llamaServerUrl": "http://127.0.0.1:8080"
   }
   ```

2. **Environment variable** — `LLAMA_SERVER_URL`

3. **Global settings** — `~/.pi/agent/settings.json`:

   ```json
   {
     "llamaServerUrl": "http://127.0.0.1:8080"
   }
   ```

4. **Default** — `http://127.0.0.1:8080`

### Multiple Servers

To connect to multiple llama.cpp servers simultaneously, add your URLs as a single string **separated with semicolons** in any of the examples above:

```bash
# Example for env, but you can use any of the other methods
LLAMA_SERVER_URL="http://127.0.0.1:8080;http://127.0.0.1:8081;http://10.0.0.5:8080"
```

Each server gets its own provider (e.g., **Llama.cpp (http://127.0.0.1:8080)**) and its own set of models. The `/models` command lists all models from all servers, labeled with their server URL.

### API Key

If your llama.cpp server requires authentication, use `/login` in Pi, select the "API key" option, and choose the provider from the list that correlates with the server needing the API key.

Alternatively, configure the API key in `~/.pi/agent/auth.json`:
Use the provider ID `llama-server=<url>`:

```json
{
  "llama-server=http://127.0.0.1:8080": {
    "type": "api_key",
    "key": "<key-for-server-1>"
  },
  "llama-server=https://some-url-for-llama-cpp": {
    "type": "api_key",
    "key": "<key-for-server-2>"
  }
}
```

## Usage

### Prerequisites

Make sure your llama.cpp server is running with the appropriate flags.

- For multi-model support (model router), start the server with:

```bash
llama-server --models-preset path/to/presets.ini ...
```

- For single-model mode, start the server with:

```bash
llama-server --model path/to/model.gguf ...
```

- For legacy-model mode (e.g., [ik_llama.cpp](https://github.com/ikawrakow/ik_llama.cpp)), the extension auto-detects and handles it transparently.

> **Note:** This extension is focused on llama.cpp, not on ik_llama.cpp. Nonetheless, since I found a way to make it work with this extension, I added the option.

> **Note:** The ik_llama.cpp fork is not legacy at all, but it uses an old way of describing models compared to llama.cpp.

The extension determines the context size as follows:

- **Router mode**
  - When loaded, reads `meta.n_ctx` from the `/v1/models` endpoint
  - When not loaded, reads `--ctx-size` and/or `--fit-ctx` from the server arguments (which can also originate from the **presets.ini** file the llama.cpp server uses to load its models).
- **Single mode** — reads `meta.n_ctx` from the `/v1/models` endpoint
- **Legacy mode** — reads `max_model_len` from `/v1/models`, falling back to `n_ctx` from `/props`
- Falls back to `128000` if not available

### Commands

| Command          | Description                                                                        |
| ---------------- | ---------------------------------------------------------------------------------- |
| `/models`        | Browse your models with live status. Select a model to load, switch, or unload it. |
| `/models info`   | Show detailed information for all available models at once.                        |
| `/models unload` | Unload all loaded models at once.                                                  |

> **Note:** When a llama.cpp server is slow to respond, it will be skipped at startup with a warning. Run `/models` to retry without timeout and see all models.

> **Note:** When a llama.cpp server is unreachable, `/models` displays an error notification with the configured server URL, but healthy servers continue to show their models.

> **Note:** The `/models unload` command only makes sense in router mode.

### Model Actions

When browsing models via the `/models` command, you can:

- **Load & switch** — Load an unloaded model and switch to it
- **Switch model** — Switch to a model that is already loaded
- **Unload** — Unload a loaded model to free memory
- **Retry** — Retry loading a failed model
- **Info** — View model details (ID, capabilities, context size)
- **Cancel** — Cancel the current operation

> **Note:** In single-model and legacy-model mode, **Unload** is not available, since there is only one model on the server.

### Thinking Levels

The extension translates Pi's thinking level selector (off, minimal, low, medium, high, xhigh, max) into something llama.cpp understands. By default every model uses numeric **thinking budgets** (`thinking_budget_tokens`):

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

#### Per-model thinking configuration (`llamaThinking`)

Different models need different treatment (e.g., Qwen3.5 speaks named reasoning efforts, while Qwen3.6 only understands numeric budgets). The `llamaThinking` setting — a dict of **wildcard model patterns** to entries in `.pi/settings.json` or `~/.pi/agent/settings.json` — lets you pre-configure exactly what gets sent to each model, per level:

```json
{
  "llamaThinking": {
    "qwen3.5*": {
      "thinkingLevelMap": {
        "off": { "enable_thinking": false },
        "minimal": { "effort": "low", "budget": 1024 },
        "low": { "effort": "low", "budget": 8192 },
        "medium": { "effort": "medium", "budget": 8192 },
        "high": { "effort": "xhigh", "budget": 8192 },
        "xhigh": { "effort": "xhigh" }
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

### Model Selection Event

When you switch models via Pi's model picker (instead of using the `/models` command), the extension listens for the `model_select` event, which also loads the requested model before the conversation begins.

This keeps the server in sync with the active model in Pi, regardless of how the switch was initiated — you don't need to manually load models before using them.

> **Note:** If you switch sessions while a model load is in-flight, you'll see a warning, but the load continues in the background. Use `/models` in the new session to verify the model status.

### Loading Models

When you trigger a load, switch, or retry action, the extension uses SSE (Server-Sent Events) to receive real-time progress updates from the server. If SSE is not available, it falls back to polling.

If loading takes longer than **60 seconds**, the operation times out with an error.

> **Note:** The timeout only applies to the progress detection. The model might still be loading in the background.

### Model Configuration

Each model exposed to Pi includes the following defaults:

- **`maxTokens`** — dynamically set to the model's context window (detected from llama-server)
- **`reasoning`** — `true` (assumed, as llama.cpp's `/v1/models` endpoint does not expose it)
- **`cost`** — all zero (local models)

## Dependencies

| Peer dependency                   | Purpose             |
| --------------------------------- | ------------------- |
| `@earendil-works/pi-ai`           | Pi AI SDK           |
| `@earendil-works/pi-coding-agent` | Pi Coding Agent SDK |
| `@earendil-works/pi-tui`          | Pi TUI SDK          |
