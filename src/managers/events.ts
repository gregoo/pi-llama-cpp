import {
  type BeforeProviderRequestEvent,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { READABLE_TIMEOUT } from "../constants";
import { ModelSelectEvent } from "../interfaces/events";
import { BaseModel } from "../models/baseModel";
import { ConfigResolver } from "../resolver";
import { Server } from "../server";

export class EventManager {
  static inflightModel: BaseModel | null = null;

  constructor(private readonly servers: Server[]) {}

  /**
   * Resets the in-flight model reference.
   */
  static resetInflightModel() {
    EventManager.inflightModel = null;
  }

  /**
   * Reacts to a new model event triggered by Pi
   *
   * @param event Model selection event
   * @param ctx Pi context
   */
  async onModelSelect(event: ModelSelectEvent, ctx: ExtensionContext) {
    for (const { providerId, models } of this.servers) {
      if (event.model.provider !== providerId) continue;

      const model = models.find((m) => m.id === event.model.id);
      if (!model) continue;

      ctx.ui.notify(`Loading ${model.name}...`, "info");
      await model
        .load()
        .then(() => ctx.ui.notify(`Model ${model.name} ready`, "info"))
        .catch(() =>
          ctx.ui.notify(`Failed to load model ${model.name}`, "error"),
        );
      return;
    }
  }

  /**
   * Session-switch handler. Registered once at extension init.
   * Only notifies if a model load is actually in-flight.
   *
   * @param ctx Pi context
   */
  async onSessionBeforeSwitch(ctx: ExtensionContext) {
    if (!EventManager.inflightModel) return;

    const messages = [
      `Session change detected while model '${EventManager.inflightModel.name}' was still loading.`,
      "Model load will continue in the background, but UI might not update.",
      "",
      "Verify that your new model is loaded, or use /models to re-select it afterwards.",
    ];
    ctx.ui.notify(messages.join("\n"), "warning");

    // Show the notification for a reasonable amount of time
    await new Promise((r) => setTimeout(r, READABLE_TIMEOUT));
  }

  /**
   * Intercepts the request to add extra information, useful to llama.cpp.
   * Resolves the per-level thinking spec for this model (from the
   * `llamaThinking` setting, or the global default map when no pattern
   * matches) and injects whatever fields the selected level's spec defines:
   * `thinking_budget_tokens` and/or `chat_template_kwargs`.
   *
   * @param event Request event
   * @returns Updated payload
   */
  async onBeforeProviderRequest(event: BeforeProviderRequestEvent) {
    const payload = event.payload as { model?: string };
    const { model } = payload;
    if (!model) return payload;

    // Check if this model belongs to one of our servers
    const isLlamaCpp = this.servers.some((s) =>
      s.models.some((m) => m.id === model),
    );

    if (!isLlamaCpp) return payload;

    // Resolve pi's current thinking level and this model's level specs
    const resolver = new ConfigResolver();
    const levels = resolver.resolveThinkingLevels(model);
    const level = resolver.resolveThinkingLevel() ?? "medium";

    // Unavailable levels add nothing (Pi should clamp away, defensive)
    const spec = levels[level];
    if (spec === null) return payload;

    // Inject whatever this level's spec defines
    const additions: Record<string, unknown> = {};
    if (spec.budget !== undefined)
      additions.thinking_budget_tokens = spec.budget;

    const kwargs: Record<string, unknown> = {};
    if (spec.effort !== undefined) kwargs.reasoning_effort = spec.effort;
    if (spec.enable_thinking !== undefined)
      kwargs.enable_thinking = spec.enable_thinking;
    if (spec.preserve_thinking !== undefined)
      kwargs.preserve_thinking = spec.preserve_thinking;
    if (Object.keys(kwargs).length > 0) additions.chat_template_kwargs = kwargs;

    return Object.keys(additions).length > 0
      ? { ...payload, ...additions }
      : payload;
  }
}
