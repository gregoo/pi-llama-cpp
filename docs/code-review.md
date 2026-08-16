# Code review — pre-existing extension code

Review of the codebase as of `master` (post `llamaModelsConfig` merge, commit
`2f9ae59`). The new thinking/sampling code (`resolver.ts` thinking parts,
`managers/sampling.ts`, `events.ts` injection, `/models sampling`) was
written during this work and is not the subject of this review.

## Overall impression

The architecture is solid:

- Small, single-responsibility files with clean layering:
  `utils` → `interfaces` → `models` → `server` → `managers` → `index.ts`.
- The `ROUTER` / `LEGACY` / `SINGLE` model subclass strategy
  (`server.ts` mode detection + `models/*`) is an elegant way to handle
  ik_llama.cpp and legacy servers in one codebase.
- `ApiClient`'s TTL cache + per-key mutex dedup is exactly the right shape
  for a status-polling UI (many concurrent `getStatus()` callers collapse
  into one request).
- SSE with graceful fallback to polling; one shared connection per server,
  callback aggregation, wildcard dispatch.
- Good error messages with actionable hints ("Run `/models` to retry").
- Strong test coverage of resolver / events / command logic (124 tests).

## Bugs

### 1. `SingleModel.getCapabilities()` fallback is broken

`src/models/singleModel.ts` — the "auth wrong" path does:

```ts
const { models } = await this.server.fetchModels();
const [{ capabilities }] = models!;
```

But per `src/interfaces/endpoints/models.ts`, *"In single mode, the
`models` property is not returned"* — so in exactly the mode this class
serves, `models` is `undefined` and the destructure throws. The fallback
always crashes. Fix: use `data[].architecture.input_modalities` (what
`BaseModel.getCapabilities()` already does).

### 2. `pollStatus()` exits silently on FAILED

`src/models/baseModel.ts` — the loop condition is `=== Status.LOADING`, so
if the status becomes `FAILED` / `UNAUTHORIZED` — or the server briefly
drops (catch → `FAILED`) — `load()` resolves normally and `/models`
announces *"Model X ready"*. It should throw on a terminal non-success
status after an explicit load request.

### 3. `ApiClient` never checks `res.ok`

`src/api/client.ts` — `do_get` / `do_post` call `res.json()` unconditionally:

- Error bodies get **cached** like success responses (250 ms TTL — a
  transient 500 is shared with all deduped callers).
- Non-JSON error responses (e.g. an HTML 502 from a proxy) make
  `res.json()` throw, which `getStatus()` misreports as `FAILED`.
- `BaseModel.getStatus()` intentionally reads `error.code` out of the
  *response body* (the props endpoint returns `{ error: { code, message } }`
  for states like "model is not loaded"), so the fix needs care: keep
  parsing the body, but stop caching failures (and consider a structured
  error carrying the HTTP status).

### 4. `RouterModel.pollStatus()`'s 5-second "glitch" window is likely dead code

`src/models/routerModel.ts` — the first loop relies on
`fetchModelProps` *rejecting* for unloaded models, but given bug #3 the
props endpoint's `{ error: ... }` JSON body resolves fine, so the loop
breaks on the first iteration. Coupled with #3: if the client is fixed to
throw on `!res.ok`, this workaround starts actually doing what its comment
claims. Fix the two together.

### 5. No fetch timeouts in `ApiClient`

`src/api/client.ts` — `probeSSE` uses `AbortSignal.timeout`, but plain
`get` / `post` do not. A hung server hangs `ServerManager.update()`
forever (`/models` deliberately calls it with no timeout) and each
`getStatus()` poll can hang indefinitely. Fix: `AbortSignal.timeout(...)`
on both methods.

## Edge-case crashes

### 6. `Server.detectServerMode()` on an empty model list

`src/server.ts` — `"max_model_len" in data[0]` throws `TypeError` when
`/v1/models` returns no models.

### 7. `LegacyModel.getContextSize()` on an empty model list

`src/models/legacyModel.ts` — `const [{ max_model_len }] = data` — same
empty-list `TypeError`.

## Minor

8. **`SSEClient.connect()` assigns `eventSource.onopen` twice**
   (`src/sse/client.ts`) — the first handler is overwritten and never runs;
   confusing dead code.
9. **`SSEManager.subscribeToStatus()` overwrites the single shared
   `setOnConnectFailed` slot** each call and never clears it. Currently a
   no-op (stale `reject` on already-settled promises), but a trap for the
   next person.
10. **API key in SSE query string** (`?api_key=...`, `sse/manager.ts` and
    `sse/client.ts`) — unavoidable with `EventSource`, but worth a README
    note for people whose servers log URLs.
11. **`maxTokens: await this.getContextSize()`** (`baseModel.ts`
    `toProviderConfig`) — context window as max *output* tokens is a
    generous ceiling; fine, but deserves a comment.
12. **Inconsistent `ConfigResolver` instantiation** — `Server` holds one
    instance, while `baseModel.ts` / `events.ts` / `command.ts` create ad-hoc
    `new ConfigResolver()` per call.
13. **Test gap** — the trickiest code (`sse/client.ts`, `sse/manager.ts`,
    `api/client.ts`, `utils/*`: concurrency, reconnection, dedup) has zero
    tests, while resolver / events / command are well covered.

## Suggested fix order

The small, safe, high-value fixes (each independent of the
thinking/sampling work, good as a separate `fix:` commit before a PR):

1. #5 — fetch timeouts (two lines, unhangs everything)
2. #1 — `SingleModel.getCapabilities()` fallback (use `data[].architecture`)
3. #6 + #7 — empty-model-list guards
4. #2 — `pollStatus()` throw on terminal failure
5. #3 + #4 — error handling in `ApiClient` + re-enable the router glitch
   window (do together, add `api/client.ts` tests)
