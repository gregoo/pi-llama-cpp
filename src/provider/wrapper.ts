import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LLAMA_PROVIDER_ID, THINKING_LEVELS } from "../constants";
import { ConfigResolver } from "../resolver";

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
 * The transform reads the built-in's LIVE catalog on every call, so models
 * loaded/unloaded via Pi's `/llama` appear/disappear in `/model` immediately
 * — no polling, no re-registration, never stale.
 *
 * Note: this must use the native (full Provider) registration form. The
 * config form (`pi.registerProvider("llama.cpp", {...})`) evicts the
 * built-in's native provider and with it its auth and refresh behavior.
 */
export class LlamaProviderWrapper {
  private wrapped = false;

  constructor(private readonly resolver: ConfigResolver) {}

  /** Whether the wrapper is registered. */
  get isWrapped(): boolean {
    return this.wrapped;
  }

  /**
   * Captures the built-in provider and registers the wrapper. Idempotent —
   * safe to call from several event handlers until it succeeds.
   *
   * Must be called before any other registration for `llama.cpp`, while
   * `getProvider()` still returns the raw built-in.
   *
   * @param pi The Pi extension API
   * @param ctx The Pi context (for the model registry)
   * @returns true when the wrapper is active
   */
  init(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
    if (this.wrapped) return true;

    const builtin = ctx.modelRegistry.getProvider(LLAMA_PROVIDER_ID);
    if (!builtin || typeof builtin.getModels !== "function") return false;

    pi.registerProvider({
      // Pass through everything the built-in defines (auth, refreshModels,
      // stream, streamSimple, filterModels, deferred support...) and only
      // replace the model list with the supercharged one.
      ...builtin,
      id: LLAMA_PROVIDER_ID,
      name: builtin.name ?? LLAMA_PROVIDER_ID,
      getModels: () => this.supercharge(builtin.getModels()),
    });

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
