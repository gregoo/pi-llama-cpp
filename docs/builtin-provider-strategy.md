# Strategy: supercharging Pi's built-in llama.cpp provider

Goal (owner's words, clarified 2026-08):

1. Use **Pi's built-in llama.cpp foundation** to connect to the backend
   (`/login llama.cpp`, `/llama`, router mode).
2. The llama backend gains **thinking levels**.
3. Supercharge it with our **hybrid overrides**: reasoning, thinking specs,
   sampling sets — keeping **wildcard model matching**.
4. Eventually: a clean **tokens/sec** implementation (from `stats/`).
5. Everything in pi-llama-cpp that duplicates Pi's connection / load /
   catalog work **gets removed** from the extension.

## What Pi ships today (verified in pi-coding-agent 0.84.2)

A bundled extension at `dist/extensions/llama/` (~1,200 lines):

- Provider id: **`"llama.cpp"`**, `api: "openai-completions"` (standard
  pi-ai stream — your guess was right).
- Auth: `/login llama.cpp` or `LLAMA_BASE_URL` / `LLAMA_API_KEY`.
- Live catalog: only **loaded** models are exposed to `/model`; the
  extension's `setCatalog()` + `modelRegistry.refresh({providers:["llama.cpp"]})`
  keeps it current after load/unload/download.
- `/llama` command: load / unload / HF search+download with progress,
  cancel, reconnect. Router mode only; single server.

What it does **not** do: no `reasoning`, no `thinkingLevelMap`
(`toPiModel()` hardcodes `reasoning: false`), no sampling config, no stats.

## The composition pipeline (the part that makes this possible)

`ModelRuntime.recomposeProvider()` + `composeModelProvider()` in
`dist/core/provider-composer.js` merge four layers per provider id:

```
base.getModels()          built-in llama extension's live catalog
→ applyModelsJson         ~/.pi/agent/models.json (models, baseUrl, compat)
→ applyExtension          config passed to pi.registerProvider("llama.cpp", {...})
→ modelOverrides [LAST]   models.json per-exact-model-id overrides ("topmost layer")
```

Registration forms matter (`dist/core/model-runtime.js`) — and one of them
is a trap:

| Call | Effect |
|---|---|
| `pi.registerProvider("llama.cpp", config)` | ⚠️ **TRAP.** `registerProvider` starts with `this.nativeExtensionProviders.delete(providerId)` — it *evicts* the built-in's native provider. The composed provider then has no base: it keeps our `models`, but loses the built-in's `auth` (check/resolve/login) and `refreshModels`. Result (reproduced): availability passes fail, `/model` is empty, `/llama` breaks. Do NOT use config-form for an id that has a native provider. |
| `pi.registerProvider(fullProviderObject)` | `registerNativeProvider` → becomes the base for that id (replaces the built-in's registration in the runtime; we keep our own reference to the built-in object). **This is what we use** — as a *wrapper*, not a reimplementation. |

Wrapper semantics: with no models.json config and no extension overlay, the
runtime uses a registered provider **untouched** ("No overlays: use the
builtin untouched") — so our wrapper's `getModels()` output is exactly what
`/model`, availability checks, and streaming see.

Streaming: a wrapper can pass through the built-in's `stream`/
`streamSimple` (or wrap them later for stats / `return_progress`).

Also available to extensions: `ctx.modelRegistry` (synchronous facade:
`getAll()`, `find()`, `getProvider("llama.cpp")`, `refresh()`), and
`before_provider_request` (payload mutation, fires for every provider).

**There is no catalog-changed event** — neither in the extension event list
nor on the shared `pi.events` bus. The wrapper design below makes this a
non-issue: we read the live catalog on every `getModels()` call.

## Target architecture

```
Pi built-in "llama.cpp" provider          OUR EXTENSION (what remains)
─────────────────────────────────         ──────────────────────────────
/login llama.cpp  (auth)                  • wildcard resolver (llamaModelsConfig)
/llama            (load/unload/download)  • provider wrapper: registers a native
router client + SSE load progress           provider that passes the built-in's
model catalog + refresh                     auth/refresh/stream through and
                                            supercharges getModels() live:
                                            thinkingLevelMap/reasoning per model,
                                            wildcard-matched, on every call
                                            • before_provider_request injection
                                              (thinking kwargs/budget + sampling
                                              sets), gated on provider === "llama.cpp"
                                            • (phase 2) streamSimple wrap:
                                              stats tap + return_progress
```

Removed from the extension: `Server`, `ServerManager`, `BaseModel` and
subclasses, SSE load-wait machinery, mode detection (ROUTER/LEGACY/SINGLE),
API-key settings plumbing, `/models` load/unload menu. Roughly two thirds
of the current codebase.

### Provider wrapper (the core new piece)

Once per session (on `session_start`, before we register anything):

1. **Capture the built-in**: `ctx.modelRegistry.getProvider("llama.cpp")`
   returns the raw built-in provider object while no overlay is registered
   (runtime uses it untouched). Keep a reference to it.
2. **Register our wrapper** (native form, full Provider object):
   ```ts
   pi.registerProvider({
     id: "llama.cpp",
     name: builtin.name,
     baseUrl: builtin.baseUrl,
     auth: builtin.auth,                 // pass-through: /login keeps working
     getModels: () => supercharge(builtin.getModels()),  // LIVE + wildcard overrides
     refreshModels: builtin.refreshModels, // pass-through: catalog sync/persist
     stream: builtin.stream,             // pass-through (wrap later for stats)
     streamSimple: builtin.streamSimple,
   });
   ```
3. **Supercharge** = clone each live model and apply the wildcard resolver:
   `reasoning: true` + `thinkingLevelMap` (level → display name / `null`,
   exactly what `resolveThinkingLevelMap()` already produces). Everything
   else — compat, contextWindow, cost, input — passes through untouched.

Why this beats the original overlay+probe design:

- **No masking, no probe, no polling, no re-registration.** `getModels()`
  reads the built-in's live closure state on every call, so a model loaded
  via `/llama` appears in `/model` immediately (next render), and unloading
  removes it. The discovery wrinkle below simply disappears.
- **Auth/login/refresh are the same objects** the built-in uses — nothing to
  replicate, nothing to fall out of sync.
- Verified headlessly (spike v2): supercharged models stay *available*
  through full availability passes; `/llama`'s `setCatalog` + refresh cycle
  still works; stream auth resolves (`baseUrl` + key); a real prompt
  round-trips through the wrapped provider.

### Payload injection (unchanged concept, better gate)

`before_provider_request` filtered by `model.provider === "llama.cpp"`:

- thinking spec for the active level → `thinking_budget_tokens` /
  `chat_template_kwargs` (additive per-level specs, as implemented)
- selected sampling set → verbatim top-level params
- `return_progress: true` (phase 2, or already here if stats wants it)

This also acts as a **backstop**: even a model whose metadata we haven't
supercharged yet (first sight) still gets correct thinking/sampling fields
from the configured default level.

### Stats (phase 2, from `stats/`)

Per `docs/stats-integration.md`, but simpler now that we own the overlay:

- register `{ api: "openai-completions", streamSimple }` in the same
  overlay call; wrap pi-ai's compat `streamSimple` with a fetch tap for
  `prompt_progress` (prefill bar) — scoped to this provider only.
- decode tok/s from `message_update` events (no stream parsing needed).
- No global fetch patch, no `/chat/completions` URL guessing.

## The discovery wrinkle (resolved)

The original design used a config-form overlay (`models` replacement at the
extension layer) plus a polling `GET /models` probe, because the overlay
*masks* the live base catalog — new models loaded via `/llama` would be
invisible to us until re-registered.

The wrapper design removes both problems: we never replace the list; we
transform it live on every read. The only remaining assumption is that
`getProvider("llama.cpp")` returns the raw built-in before our registration
(true while no overlay/native override exists — verified in dist and in the
spike).

## Risks & trade-offs

- **Coupling to Pi internals.** Documented surface we rely on:
  `registerProvider(fullProvider)`, `ctx.modelRegistry.getProvider()`,
  `before_provider_request`. Risky dist details: (a) config-form
  registration *evicts* native providers (`nativeExtensionProviders.delete`) —
  a behavior change here would break us loudly, not silently; (b) the raw
  built-in must be readable via `getProvider` before we wrap it; (c) the
  "no overlays → provider used untouched" shortcut; (d) for the /login
  default-model registration, `dist/core/model-resolver.js` keeps exporting
  a mutable `defaultModelPerProvider` object — resolved by walking up from
  `process.argv[1]` because the exports map blocks deep imports. That one
  degrades silently (stock login error returns) if the path moves.
  Mitigations: minimum peer-dependency version, an integration test
  asserting the composed list carries our `thinkingLevelMap` AND stays
  available after a full auth pass, and keeping the wrapper in one small
  module so a Pi API change is a local fix.
- **Router-only, single-server.** Inheriting the built-in means dropping
  single-model mode, legacy (ik_llama.cpp) mode, and multi-server
  `llamaServers` users. Accepted per owner; note it in the README migration
  section.
- **Wrapper must never drop models.** `supercharge()` is a pure map over the
  built-in's live list — if the resolver throws for one model, catch and
  pass the model through unmodified rather than failing the whole list.
- **Capture ordering.** We must capture the built-in *before* registering
  the wrapper (afterwards `getProvider` returns our own object). Capture on
  `session_start(startup)`; all bundled extensions are loaded by then.
- **Pre-wrap model resolution clamps thinking to off.** A llama.cpp model
  chosen via CLI `--model`, default settings or session resume is resolved
  *before* `session_start`, so the session holds a raw instance
  (`reasoning: false`) and Pi's `clampThinkingLevel` collapses every level
  to `off` at session creation. Fix (in `src/index.ts`): after wrapping,
  re-select the current model via `pi.setModel` (untouched models keep
  object identity, so this only fires when supercharge changed it) and
  re-apply the intended level — explicit `--thinking` from argv, else the
  settings default, else Pi's `DEFAULT_THINKING_LEVEL` (`medium`) — which
  now clamps against the supercharged model.

## Phased plan

1. **Spike — DONE (v2).** v1 proved the config-form overlay is a trap
   (native eviction → empty `/model`, broken `/llama`). v2 proves the
   wrapper end-to-end, headlessly: supercharged models available through
   full auth passes, live catalog pass-through, stream auth resolution,
   real prompt round-trip. TUI checks passed: `/model` shows thinking
   levels, payload injection reaches the server, `/llama` intact.
2. **Wrapper module — DONE.** `src/provider/wrapper.ts`: capture + wrap on
   `session_start(startup)`, resolver-driven supercharge (per-model
   `llamaModelsConfig` entries), pass-through models unchanged on resolver
   errors; inert when the built-in provider is absent.
3. **Injection cutover — DONE.** Thinking/sampling injection gated on
   `provider === "llama.cpp"`; level from `ctx.thinkingLevel` (session
   runtime) with settings/medium fallback; old server stack deleted
   (`Server`, `ServerManager`, models, SSE load-wait, model menu removed;
   sampling selection moved to a top-level `/sampling` command).
   Live-verified: `--thinking off|low` and the
   default chain all inject the right spec (mock router + payload capture),
   including the pre-wrap level-restore fix above.
4. **Stats — DONE.** `src/managers/stats.ts`: decode tok/s from
   `message_update`, prefill bar from a provider-scoped `options.fetch`
   tap on the wrapper's `streamSimple` (no global fetch patch),
   `return_progress: true` via `before_provider_request`, display in the
   `llama-stats` widget. Live-verified against a mock router emitting
   `prompt_progress`; standalone `stats/` extension deleted.
5. **Docs/README — DONE.** README rewritten around the built-in provider:
   setup via `/login llama.cpp` + `/llama`, `llamaModelsConfig` reference,
   sampling sets, top-level `/sampling` command.
