import {
  type BeforeProviderRequestEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type MessageEndEvent,
  type MessageUpdateEvent,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { LLAMA_PROVIDER_ID, PROVIDER_NAME } from "./constants";
import { ModelSelectEvent } from "./interfaces/events";
import { CommandManager } from "./managers/command";
import { EventManager } from "./managers/events";
import { StatsManager } from "./managers/stats";
import { LlamaProviderWrapper } from "./provider/wrapper";
import { ConfigResolver } from "./resolver";

export default async function (pi: ExtensionAPI) {
  const resolver = new ConfigResolver();
  const stats = new StatsManager();
  const wrapper = new LlamaProviderWrapper(resolver, stats);
  const eventManager = new EventManager(resolver);
  const commandManager = new CommandManager(resolver);

  // Supercharge Pi's built-in llama.cpp provider. Runs at session startup,
  // when getProvider() still returns the raw built-in (no overlay yet).
  // Inert if the built-in provider is not present.
  pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
    if (event.reason !== "startup") return;
    wrapper.init(pi, ctx);

    // A llama.cpp model selected before the wrap (CLI --model, default
    // model, session restore) is a raw instance without thinking metadata,
    // so Pi clamped its thinking level to off at session creation.
    // Re-select it so the session holds the supercharged copy, then
    // restore the intended level. Untouched models keep their object
    // identity, so this is a no-op unless supercharge changed them.
    const current = ctx.model;
    if (!current || current.provider !== LLAMA_PROVIDER_ID) return;

    const fresh = ctx.modelRegistry.find(LLAMA_PROVIDER_ID, current.id);
    if (!fresh || fresh === current) return;

    await pi.setModel(fresh);

    // Pi's own resolution chain: CLI --thinking, then the settings default,
    // then its DEFAULT_THINKING_LEVEL ("medium"). Re-applying it now clamps
    // against the supercharged model instead of the raw one.
    const argv = process.argv;
    let cliLevel: string | undefined;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--thinking") cliLevel = argv[i + 1];
      else if (argv[i]?.startsWith("--thinking="))
        cliLevel = argv[i].slice("--thinking=".length);
    }
    // An explicit --thinking wins outright (including off); otherwise use
    // Pi's fallback chain: settings default, then "medium".
    const intended =
      cliLevel !== undefined
        ? cliLevel
        : (resolver.resolveThinkingLevel() ?? "medium");
    if (intended === "off") return;
    pi.setThinkingLevel(intended as ThinkingLevel);
  });

  // /sampling — select the sampling set injected for the current model
  pi.registerCommand("sampling", {
    description: `Select the ${PROVIDER_NAME} sampling set for the current model`,
    getArgumentCompletions: commandManager.getArgumentCompletions,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await commandManager.handleCommand(args, ctx, pi);
    },
  });

  // Events
  pi.on(
    "before_provider_request",
    async (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => {
      stats.attachUi(ctx);
      return await eventManager.onBeforeProviderRequest(event, ctx);
    },
  );

  pi.on(
    "model_select",
    (event: ModelSelectEvent, ctx: ExtensionContext) =>
      eventManager.onModelSelect(event, ctx),
  );

  // Generation stats: decode speed from per-delta updates, prefill from the
  // provider-scoped stream tap in the wrapper.
  pi.on("message_update", (event: MessageUpdateEvent, ctx: ExtensionContext) => {
    stats.attachUi(ctx);
    stats.onMessageUpdate(event);
  });

  pi.on("message_end", (event: MessageEndEvent) => stats.onMessageEnd(event));
}
