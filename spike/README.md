# Spike v2: supercharging the built-in llama.cpp provider

Proves the mechanism from `../docs/builtin-provider-strategy.md`:
a **native wrapper provider** that passes the built-in's auth / refresh /
stream through and supercharges `getModels()` live with wildcard-matched
`reasoning` + `thinkingLevelMap`.

## Why v2 (the v1 finding)

v1 tried the config form: `pi.registerProvider("llama.cpp", { models })`.
That is a **trap**: `ModelRuntime.registerProvider` starts with
`this.nativeExtensionProviders.delete(providerId)` — it evicts the
built-in's native provider. The composed provider then has no base: our
models show up in `getAll()`, but the built-in's auth check/resolve/login
and `refreshModels` are gone → full availability passes fail → `/model`
empty, `/llama` broken. (Reproduced deterministically; see strategy doc.)

v2 registers a **full Provider object** that wraps the captured built-in:

```ts
const builtin = ctx.modelRegistry.getProvider("llama.cpp"); // raw, pre-wrap
pi.registerProvider({
  id: "llama.cpp",
  auth: builtin.auth,                    // pass-through
  getModels: () => supercharge(builtin.getModels()), // live + overrides
  refreshModels: builtin.refreshModels,  // pass-through
  stream: builtin.stream,
  streamSimple: builtin.streamSimple,
});
```

No probe, no polling, no re-registration — `getModels()` reads the
built-in's live catalog on every call.

## Verified headlessly (this machine)

- supercharged model (`thinkingLevelMap`) present in composed list and
  **stays available through a full availability pass** (the v1 failure);
- `/llama`'s `setCatalog` + `modelRegistry.refresh` cycle still works;
- stream auth resolves (`baseUrl` + key) for the supercharged model;
- real prompt round-trips: `pi -ne -e ./supercharge.ts --print "..."` →
  answer from the router.

## Run (TUI checks that remain)

```bash
pi -ne -e /path/to/pi-llama-cpp/spike/supercharge.ts
```

Needs `/login llama.cpp` done and at least one model loaded via `/llama`.

1. Footer shows `llama-spike: wrapped builtin: <model ids>`.
2. `/model`: the model lists thinking levels (Off…Max) — the built-in alone
   registers `reasoning: false`, so this proves the supercharge reached the
   UI. Toggle a level.
3. Send a prompt; in the llama-server logs you should see
   `thinking_budget_tokens` (or `chat_template_kwargs.enable_thinking:
   false` for Off). `max` sends neither.
4. `/llama`: load/unload/download still work as before; new loads appear in
   `/model` immediately (live pass-through, no sync delay).
5. Kill the router and back: catalog follows the built-in's own refresh
   behavior (no emptying from our side).

## Notes

- Single catch-all `"*"` override hardcoded on purpose; the real extension
  plugs `llamaModelsConfig` resolution in here (per-pattern entries, longest
  match wins — same rule as `src/resolver.ts`).
- Capture happens on `session_start(startup)` — all bundled extensions are
  loaded by then, so `getProvider("llama.cpp")` is still the raw built-in.
  Backstop re-capture on `model_select`/`turn_start` until wrapped.
