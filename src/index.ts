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
import { setLlamaDefaultModel } from "./provider/defaultModel";
import { ConfigResolver } from "./resolver";

export default async function (pi: ExtensionAPI) {
  const resolver = new ConfigResolver();
  const stats = new StatsManager();
  const wrapper = new LlamaProviderWrapper(resolver, stats);
  const eventManager = new EventManager(resolver);
  const commandManager = new CommandManager(resolver);

  // Supercharge Pi's built-in llama.cpp provider. Runs on EVERY session
  // start: /new and /resume rebuild the whole runtime (fresh ModelRuntime,
  // re-executed extension factories), so each one needs its own wrap.
  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const wrapped = wrapper.init(pi, ctx);

    // Register a default model for llama.cpp in Pi's login flow so
    // /login llama.cpp auto-selects it instead of erroring with "no
    // default model is configured". Prefer the current model when it is
    // already a llama.cpp one; otherwise the first loaded model.
    const provider = ctx.modelRegistry.getProvider(LLAMA_PROVIDER_ID);
    const defaultModelId =
      ctx.model && ctx.model.provider === LLAMA_PROVIDER_ID
        ? ctx.model.id
        : provider?.getModels?.()[0]?.id;
    if (defaultModelId) void setLlamaDefaultModel(defaultModelId);

    // A llama.cpp model selected before the wrap (CLI --model, settings
    // default, session restore) is a raw instance without thinking
    // metadata. Pi resolves the initial thinking level against that raw
    // model at session creation — and when no model was even resolved yet,
    // it forces the level to off outright. Either way the level in the
    // session is not what the user asked for.
    //
    // Re-select the model so the session holds the supercharged copy, then
    // restore the intended level. The composed provider mints a new model
    // object on every getModels() call, so identity can never be used to
    // detect "already supercharged" — the re-select always runs, which is
    // harmless (setModel to an equal model keeps the current level).
    const current = ctx.model;
    if (!current || current.provider !== LLAMA_PROVIDER_ID) return;

    const fresh = ctx.modelRegistry.find(LLAMA_PROVIDER_ID, current.id);
    if (!fresh) return;

    await pi.setModel(fresh);

    // The session's thinking level was resolved against the RAW model
    // before the wrap. If the raw model had no thinking metadata (the
    // normal case), Pi clamped whatever was requested to off — so the
    // session level is not what the user asked for. Restore it using Pi's
    // own chain: settings defaultThinkingLevel, then "medium".
    //
    // If the raw model already had thinking metadata (e.g. from models.json
    // overrides), the session level is genuine and must be kept as-is.
    //
    // Note: main.js re-applies --thinking AFTER session_start, so we cannot
    // read the CLI flag here — we rely on the settings chain instead.
    // The session's thinking level was resolved against the RAW model
    // before the wrap, so it was clamped to off. Restore it using Pi's
    // own chain: CLI --thinking (if present), then settings default,
    // then "medium".
    const argv = process.argv;
    let cliLevel: string | undefined;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--thinking") cliLevel = argv[i + 1];
      else if (argv[i]?.startsWith("--thinking="))
        cliLevel = argv[i].slice("--thinking=".length);
    }
    const intended =
      cliLevel ?? resolver.resolveThinkingLevel() ?? "medium";
    if (intended !== "off") {
      pi.setThinkingLevel(intended as ThinkingLevel);
    }
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
