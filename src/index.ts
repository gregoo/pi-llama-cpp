import {
  type BeforeProviderRequestEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { PROVIDER_NAME } from "./constants";
import { ModelSelectEvent } from "./interfaces/events";
import { CommandManager } from "./managers/command";
import { EventManager } from "./managers/events";
import { LlamaProviderWrapper } from "./provider/wrapper";
import { ConfigResolver } from "./resolver";

export default async function (pi: ExtensionAPI) {
  const resolver = new ConfigResolver();
  const wrapper = new LlamaProviderWrapper(resolver);
  const eventManager = new EventManager(resolver);
  const commandManager = new CommandManager(resolver);

  // Supercharge Pi's built-in llama.cpp provider. Runs at session startup,
  // when getProvider() still returns the raw built-in (no overlay yet).
  // Inert if the built-in provider is not present.
  pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
    if (event.reason !== "startup") return;
    wrapper.init(pi, ctx);
  });

  // Single global /models command (sampling selection for the current model)
  pi.registerCommand("models", {
    description: `Configure ${PROVIDER_NAME} sampling for the current model`,
    getArgumentCompletions: commandManager.getArgumentCompletions,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await commandManager.handleCommand(args, ctx, pi);
    },
  });

  // Events
  pi.on(
    "before_provider_request",
    async (event: BeforeProviderRequestEvent, ctx: ExtensionContext) =>
      await eventManager.onBeforeProviderRequest(event, ctx),
  );

  pi.on(
    "model_select",
    (event: ModelSelectEvent, ctx: ExtensionContext) =>
      eventManager.onModelSelect(event, ctx),
  );
}
