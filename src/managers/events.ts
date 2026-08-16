import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
  BeforeProviderRequestEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { LLAMA_PROVIDER_ID } from "../constants";
import type { ModelSelectEvent } from "../interfaces/events";
import { ConfigResolver } from "../resolver";
import { SamplingState, updateSamplingStatus } from "./sampling";

/**
 * Event manager: injects thinking and sampling parameters into outgoing
 * requests for the built-in llama.cpp provider.
 *
 * Isolation: all behavior is gated on `ctx.model.provider === "llama.cpp"`,
 * so other OpenAI-compatible providers are never touched.
 */
export class EventManager {
  constructor(private readonly resolver: ConfigResolver) {}

  /**
   * Restores the footer status for the selected model's sampling selection.
   *
   * @param event Model selection event
   * @param ctx Pi context
   */
  onModelSelect(event: ModelSelectEvent, ctx: ExtensionContext): void {
    if (event.model.provider !== LLAMA_PROVIDER_ID) return;

    updateSamplingStatus(ctx, event.model.id);
  }

  /**
   * Intercepts the request to add extra information useful to llama.cpp.
   *
   * Resolves the per-level thinking spec for this model (from the
   * `llamaModelsConfig` setting, or the global default map when no pattern
   * matches) and injects whatever fields the selected level's spec defines:
   * `thinking_budget_tokens` and/or `chat_template_kwargs`. Also injects the
   * selected named sampling set's parameters, if any.
   *
   * The current thinking level comes from the session runtime when
   * available (`ctx.thinkingLevel`), falling back to the configured default.
   *
   * @param event Request event
   * @param ctx Pi context
   * @returns Updated payload
   */
  async onBeforeProviderRequest(
    event: BeforeProviderRequestEvent,
    ctx: ExtensionContext,
  ) {
    const payload = event.payload as Record<string, unknown>;

    const model = ctx.model;
    if (!model || model.provider !== LLAMA_PROVIDER_ID) return payload;

    try {
      this.applyThinking(payload, model.id, ctx);
      this.applySampling(payload, model.id);
    } catch (error) {
      console.error("[pi-llama-cpp] Failed to configure request:", error);
    }

    return payload;
  }

  /**
   * Injects the thinking parameters defined by the current level's spec.
   */
  private applyThinking(
    payload: Record<string, unknown>,
    modelId: string,
    ctx: ExtensionContext,
  ): void {
    const level = (ctx.thinkingLevel ??
      this.resolver.resolveThinkingLevel() ??
      "medium") as ModelThinkingLevel;

    // Unavailable levels add nothing (Pi should clamp away, defensive)
    const spec = this.resolver.resolveThinkingLevels(modelId)[level];
    if (spec === null) return;

    if (spec.budget !== undefined) payload.thinking_budget_tokens = spec.budget;

    const kwargs: Record<string, unknown> = {};
    if (spec.effort !== undefined) kwargs.reasoning_effort = spec.effort;
    if (spec.enable_thinking !== undefined)
      kwargs.enable_thinking = spec.enable_thinking;
    if (spec.preserve_thinking !== undefined)
      kwargs.preserve_thinking = spec.preserve_thinking;

    if (Object.keys(kwargs).length > 0) payload.chat_template_kwargs = kwargs;
  }

  /**
   * Injects the selected named sampling set's parameters, if any.
   */
  private applySampling(
    payload: Record<string, unknown>,
    modelId: string,
  ): void {
    const setName = SamplingState.get(modelId);
    if (setName === undefined) return;

    const params = this.resolver.resolveSamplingMap(modelId)?.[setName];
    if (!params) return;

    for (const [key, value] of Object.entries(params)) payload[key] = value;
  }
}
