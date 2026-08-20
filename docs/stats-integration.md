# Integrating `stats/llama-cpp-stats.ts` into pi-llama-cpp — DONE

**Status (implemented):** the standalone `stats/` extension is deleted. Its
functionality now lives in `src/managers/stats.ts` (`StatsManager`), wired as
planned below: `return_progress: true` via `before_provider_request`, decode
tok/s via `message_update`, prefill via a provider-scoped `options.fetch`
tap on the wrapper's `streamSimple`. Live-verified: prompt_progress chunks
extracted through the real Pi stream path, body pass-through intact.

**Compaction coverage (added):** compaction and branch summarization bypass
the agent loop — they call `completeSummarization()` straight through the
provider's `streamSimple`, so `before_provider_request` / `message_update` /
`message_end` never fire. The fetch tap is now the primary feed and handles
them fully:

- **Request injection in the tap** — `withReturnProgress()` rewrites the JSON
  body to add `return_progress: true` (and drops the stale content-length).
  Scoped by construction: the tap only wraps this provider's `streamSimple`.
  The `before_provider_request` injection stays for agent-loop requests;
  whichever runs first wins, the other short-circuits.
- **Decode from raw chunks** — `chunkDeltaKind()` mirrors pi-ai's parser
  (`content`, reasoning fields, `tool_calls`) and counts token arrivals
  directly off the SSE stream. First-wins `deltaSource` dedup means the tap
  and `message_update` never double-count the same token.
- **Final stats on body completion** — when the tapped body ends naturally,
  `finishStream()` finalizes (chunk `usage` as a token-count fallback).
  For regular turns `message_end` follows and re-finalizes with authoritative
  usage; for compaction it is the only finalization.
- **UI attach at `session_start`** — so streams that fire before any per-turn
  event (auto-compaction on the first turn after resume) still render.

Live-verified against a mock router: `/compact` shows the prefill progress
bar, live decode tok/s and final stats, exactly like a normal turn.

---

Original analysis of merging the standalone stats extension (real-time
prefill/decode speed + prefill progress bar) into the main extension, and
the impact on the issues listed in [`code-review.md`](./code-review.md).

## What the stats extension does today

It is a separate extension that works by **monkey-patching `globalThis.fetch`**:

1. **Request side** — for any URL containing `/chat/completions`, it rewrites
   the body to add `return_progress: true` (llama.cpp-specific; makes the
   server emit `prompt_progress` SSE chunks).
2. **Response side** — wraps the response body in a pass-through
   `ReadableStream` that taps each SSE chunk to read:
   - `prompt_progress` → prefill % bar + prefill tok/s (only available if the
     server build supports it)
   - token arrival timestamps → decode tok/s, token count, final stats
3. Displays via `ctx.ui.setWidget("llama-stats", ...)` and a `/llama-stats`
   debug command.

## Why it exists as a separate extension (and why the fetch patch)

Pi's extension events do **not** expose the raw provider response body:

- `after_provider_response` → only `status` + `headers`.
- pi-ai's OpenAI-compatible parser drops non-standard chunk fields, so
  llama.cpp's `prompt_progress` never surfaces through any event.

So a raw stream tap is genuinely required for **prefill progress**. What the
fetch patch does *additionally* (request rewriting, decode-speed token
timing) has cleaner alternatives:

| Stats job | Fetch patch? | Better mechanism |
|---|---|---|
| Inject `return_progress: true` | yes (body rewrite) | `before_provider_request` — the same hook we already use for thinking/sampling; properly scoped to llama models |
| Decode tok/s + token count | yes (chunk timing) | `message_update` event — fires per delta (`text_delta` / `thinking_delta` / `toolcall_delta`) with a `partial: AssistantMessage`; final `done` carries full `usage` |
| Prefill % + prefill tok/s | yes (raw chunk tap) | **No event alternative** — must tap the raw SSE body |

## Recommended integration design

Move stats into the main extension as e.g. `src/managers/stats.ts`, and
replace the global fetch patch with a **provider-scoped** stream handler:

```ts
import { streamSimple as baseStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";

pi.registerProvider(providerId, {
  ...existing config,
  streamSimple: (model, context, options) =>
    baseStreamSimple(model, context, {
      ...options,
      // Provider-scoped fetch override — pi-ai's openai-completions client
      // honors options.fetch (verified in dist/api/openai-completions.js).
      fetch: tapProgressFetch(options?.fetch ?? globalThis.fetch),
    }),
});
```

where `tapProgressFetch` wraps only `<baseUrl>/chat/completions` responses,
scans chunks for `prompt_progress`, and passes the body through unchanged.

- **Request injection** (`return_progress: true`): add in
  `EventManager.onBeforeProviderRequest` alongside thinking/sampling (or in
  the fetch wrapper if payload shape makes that awkward — verify at
  implementation time). Either way it is scoped to our provider, unlike the
  current global patch.
- **Decode speed**: subscribe to `pi.on("message_update", ...)`; timestamp
  deltas while `event.message.provider` starts with `llama-server`. No stream
  parsing needed for this half.
- **Display**: keep `setWidget("llama-stats")` — widgets are a separate slot
  from `setStatus`, so no conflict with the sampling status line.
- **Gate behind a setting** (e.g. `llamaStats: true`, default on or off):
  today the stats extension patches global fetch for *every* process that
  loads it; a merged extension should make the tap opt-in/opt-out.

### What this eliminates / fixes in the stats code

1. **`globalThis.fetch` monkey-patch** — gone. No process-wide side effect,
   no restore-on-shutdown bookkeeping, no interaction with other extensions.
2. **Over-broad request matching** — `url.includes("/chat/completions")`
   currently intercepts *any* OpenAI-compatible provider the user runs
   (another llama server, vLLM, …) and injects `return_progress` into all of
   them. Provider-scoped fetch fixes this by construction.
3. **Response reconstruction** (`new Response(wrappedBody, {...})`) — still
   needed for the tap, but now confined to one provider's requests.
4. **Debug leftovers** — `fetchHit`/`llamaHit`/`sseChunkCount` counters and
   the `console.log` on shutdown should be dropped (or moved behind a debug
   flag) before this ships in the main extension.

## Impact on the code-review.md issues

**None of the 13 issues change.** They are all **control-plane** code
(`ApiClient` → `/health`, `/v1/models`, `/props`, `/models/load|unload`;
SSEManager → `/models/sse`). The stats feature is purely **data-plane**
(chat/completions streaming), which the main extension does not touch today.

What the merge does clarify:

- **Confirms the plane split is correct.** Chat requests must *never* be
  routed through `ApiClient` — its TTL cache + dedup mutex would break
  streaming (and cache responses). The stats work stays in its own fetch tap.
- **Issue #5 (no fetch timeouts) stays scoped to `ApiClient`** — do not add
  a blanket timeout to the stats tap's fetch: generation streams are
  legitimately long-lived; the tap must not abort them.
- **New constraint for any future refactor**: if `onBeforeProviderRequest`
  or the provider registration ever changes shape, the stats tap and the
  thinking/sampling injection both depend on it — keep them in one place
  (`EventManager`) with shared tests.

## Suggested implementation order

1. Port decode-speed tracking to `message_update` (no fetch involved) —
   standalone, testable, immediately removes half the patch's job.
2. Add `return_progress: true` injection in `onBeforeProviderRequest`.
3. Implement the provider-scoped `streamSimple` + fetch tap for
   `prompt_progress`; verify pi-ai passes `options.fetch` through (it does,
   per current dist) and that `before_provider_request` still fires with a
   custom `streamSimple` (pi-coding-agent may apply it around the provider's
   stream function — test empirically; if not, inject `return_progress` in
   the fetch wrapper instead).
4. Move display + optional `/llama-stats` debug command; add setting gate.
5. Delete `stats/`.
