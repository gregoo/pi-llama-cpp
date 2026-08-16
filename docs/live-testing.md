# Live testing the extension headlessly

How to drive a real Pi TUI process from the CLI against a mock llama.cpp
router, without a human in front of a terminal. Used to verify the wrapper
(supercharge, thinking-level restore, `/new` and resume behavior) end to end.

Everything lives in a scratch dir (`/tmp/pi-agent-test`) so the real
`~/.pi/agent` is never touched.

## 1. The mock llama router

[`live-testing/mock-server.mjs`](live-testing/mock-server.mjs) is a ~50-line
Node HTTP server that speaks just enough of the llama.cpp router API for
Pi's built-in provider:

- `GET /models` — catalog (one loaded model)
- `POST /v1/chat/completions` — SSE stream with `prompt_progress`,
  `timings` (server-reported stats), content chunks, `[DONE]`. It also
  dumps the raw request body to `payload.json` so you can assert on the
  injected fields (`enable_thinking`, budgets, sampling params).

```bash
node docs/live-testing/mock-server.mjs   # listens on 127.0.0.1:18923
```

## 2. The isolated agent dir

`PI_CODING_AGENT_DIR` redirects all of Pi's state (settings, auth, model
store, sessions) to the scratch dir:

| file | purpose |
|---|---|
| `auth.json` | `LLAMA_BASE_URL=http://127.0.0.1:18923` — points the built-in provider at the mock |
| `settings.json` | `llamaModelsConfig` (thinking levels + sampling sets), `defaultProvider`, `defaultModel`, `defaultThinkingLevel` |
| `models-store.json` | what `/login` persisted; makes the model resolvable before any network refresh |

Key trick: the settings' `llamaModelsConfig` is the extension's own
config, so the live run exercises wildcard matching + level resolution
exactly as a real user would.

## 3. Driving the TUI from bash

Pi's TUI exits immediately without a PTY, so wrap it in macOS `script`
(which allocates one) and capture the output:

```bash
PI_CODING_AGENT_DIR=/tmp/pi-agent-test \
  timeout 15 script -q /tmp/pi-agent-test/out.log \
  pi -e ./src/index.ts --provider llama.cpp --model qwen38-27b --thinking high \
  </dev/null >/dev/null 2>&1
```

The output is a raw ANSI transcript. Strip escape sequences to read it:

```bash
sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g' out.log | grep -o "• [a-z]*"
# -> • high
```

Useful assertions from the transcript:

- **status bar** — `qwen38-27b • <level>` shows the effective thinking level
- **`/tmp/pi-agent-test/payload.json`** — the actual request body; check
  `enable_thinking`, `thinking_budget`, sampling params, and that the
  `timings`-driven stats ran

## 4. Driving the TUI with typed input (Python + pty)

For scenarios that need interaction (`/new`, `/model`, `/sampling ...`),
[`live-testing/pty-drive.py`](live-testing/pty-drive.py) forks a real PTY,
runs Pi inside it, types keystrokes with delays, and saves both the raw
and ANSI-stripped transcripts:

```bash
python3 docs/live-testing/pty-drive.py tag "/new\r"   # type /new + Enter
# -> /tmp/pi-agent-test/pty-tag.log (raw)
# -> /tmp/pi-agent-test/pty-tag.clean (stripped)
```

The child command is built inside the script (`pi -e ./src/index.ts ...`);
edit it to change flags or model. Inputs are written verbatim — send a
literal `\r` for Enter.

## 5. Debugging inside the extension

When behavior is wrong, add temporary `console.error(...)` lines in
`src/index.ts` / `src/provider/wrapper.ts`. They appear in the transcript
(stdout/stderr both land in the `script` capture), e.g.:

```bash
grep -a "\[dbg\]" out.log
```

Remove them before committing. (This is how the session-restore bug was
found: the logs showed the model was already supercharged at
`session_start`, which meant `registerNativeProvider` re-composes the
provider immediately — and that Pi's initial thinking level is resolved
against the *raw* model, or forced to `off` when no model is resolved yet.)

## 6. Verified scenarios

| command | expected status bar |
|---|---|
| `--thinking high` | `• high` |
| (no flag; settings default `low`) | `• low` |
| `--thinking off` | `• thinking off` |
| `/new` then prompt | level restored from settings/CLI on the fresh runtime |

## Cleanup

```bash
kill $(cat /tmp/pi-agent-test/server.pid) 2>/dev/null
rm -rf /tmp/pi-agent-test
```
