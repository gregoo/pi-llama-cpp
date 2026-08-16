import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LLAMA_PROVIDER_ID, THINKING_LEVELS } from "../constants";
import { ConfigResolver } from "../resolver";
import { StatsManager } from "../managers/stats";

/**
 * Supercharges Pi's built-in `llama.cpp` provider with per-model thinking
 * configuration.
 *
 * Mechanism (see docs/builtin-provider-strategy.md): the built-in provider
 * object is captured while it is still raw (`modelRegistry.getProvider()`
 * returns it untouched before we register anything) and then wrapped in a
 * native provider that passes its `auth`, `refreshModels`, `stream` and
 * friends straight through, and only transforms `getModels()`:
 *
 *   - wildcard-matched `thinkingLevelMap` + `reasoning` from
 *     `llamaModelsConfig` (with the global default map as fallback)
 *   - everything else (compat, contextWindow, cost, input, baseUrl...) is
 *     preserved exactly as the built-in defined it
 *
 * `streamSimple` is additionally wrapped with a provider-scoped fetch that
 * taps the SSE body for llama.cpp `prompt_progress` chunks (prefill stats).
 * pi-ai's openai-completions client honors `options.fetch`, so no global
 * fetch patching is needed.
 *
 * The transform reads the built-in's LIVE catalog on every call, so models
 * loaded/unloaded via Pi's `/llama` appear/disappear in `/model` immediately
 * — no polling, no re-registration, never stale.
 *
 * Note: this must use the native (full Provider) registration form. The
 * config form (`pi.registerProvider("llama.cpp", {...})`) evicts the
 * built-in's native provider and with it its auth and refresh behavior.
 */
const WRAPPER_MARKER = Symbol("llama-provider-wrapper");

export class LlamaProviderWrapper {
  private wrapped = false;

  constructor(
    private readonly resolver: ConfigResolver,
    private readonly stats: StatsManager,
  ) {}

  /** Whether the wrapper is registered. */
  get isWrapped(): boolean {
    return this.wrapped;
  }

  /**
   * Captures the built-in provider and registers the wrapper. Idempotent
   * per ModelRuntime — safe to call on every session start.
   *
   * /new and /resume rebuild the whole runtime (fresh ModelRuntime, fresh
   * extension instances), so each one gets its own wrap. The raw built-in
   * is read from the runtime's internal native-provider map: by the time
   * `session_start` fires we have already registered into this very
   * runtime, and `getProvider()` returns the COMPOSED provider (whose base
   * is our own wrapper) — wrapping that would double-wrap.
   *
   * @param pi The Pi extension API
   * @param ctx The Pi context (for the model registry)
   * @returns true when the wrapper is active for this runtime
   */
  init(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
    const registry = ctx.modelRegistry as unknown as {
      runtime?: { nativeExtensionProviders?: Map<string, unknown> };
    };
    const natives = registry.runtime?.nativeExtensionProviders;

    // The internal map is untyped; the value is either the raw built-in
    // provider or (after our first registration) our own wrapper.
    const builtin = (
      natives?.get(LLAMA_PROVIDER_ID) ??
      ctx.modelRegistry.getProvider(LLAMA_PROVIDER_ID)
    ) as Provider<Api> | undefined;
    if (!builtin || typeof builtin.getModels !== "function") return false;

    // Already wrapped this runtime: the registered provider carries our marker.
    if (
      this.wrapped &&
      (builtin as unknown as Record<PropertyKey, unknown>)[WRAPPER_MARKER]
    ) {
      return true;
    }

    const wrapperProvider: Provider<Api> = {
      // Pass through everything the built-in defines (auth, refreshModels,
      // stream, streamSimple, filterModels, deferred support...) and only
      // replace the model list with the supercharged one.
      ...builtin,
      id: LLAMA_PROVIDER_ID,
      name: builtin.name ?? LLAMA_PROVIDER_ID,
      getModels: () => this.supercharge(builtin.getModels()),
      streamSimple: (model, context, options) =>
        builtin.streamSimple(model, context, {
          ...options,
          fetch: this.stats.tapFetch(options?.fetch),
        }),
    };

    // Marker on the registered provider itself (the object literal above is
    // a new object; the raw built-in is never marked). A later init() on
    // the same runtime sees it via the internal map and bails.
    Object.defineProperty(wrapperProvider, WRAPPER_MARKER, {
      value: true,
      enumerable: false,
    });

    pi.registerProvider(wrapperProvider);

    this.wrapped = true;
    return true;
  }

  /**
   * Applies the wildcard-matched thinking configuration to a model list.
   *
   * Pure and total: a resolver failure for one model passes that model
   * through unmodified — the list never fails or shrinks because of our
   * overlay. Models whose effective level map has no available levels are
   * left untouched (no thinking UI, matching `reasoning: false`).
   *
   * @param models The built-in's current model list
   * @returns A new list with thinking metadata applied where configured
   */
  supercharge(models: readonly Model<Api>[]): Model<Api>[] {
    return models.map((model) => {
      try {
        const levelMap = this.resolver.resolveThinkingLevelMap(model.id);
        const hasLevels = THINKING_LEVELS.some(
          (level) => levelMap[level] !== null,
        );
        if (!hasLevels) return model;

        return { ...model, reasoning: true, thinkingLevelMap: levelMap };
      } catch {
        return model;
      }
    });
  }
}
