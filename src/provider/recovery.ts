import type { Model } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import {
  LLAMA_PROVIDER_ID,
  PROVIDER_NAME,
  type RetryConfig,
} from "../constants";
import type { ConfigResolver } from "../resolver";
import { getLlamaDefaultModel } from "./defaultModel";

/**
 * Pi's placeholder model (pi-agent-core's `DEFAULT_MODEL`) — what a session
 * ends up with when no model could be resolved at startup, e.g. because
 * llama.cpp's catalogue was empty at that moment (server still starting,
 * no model loaded yet, or a failed refresh).
 */
export function isUnknownModel(
  model: { provider?: string; id?: string } | null | undefined,
): boolean {
  return !!model && model.provider === "unknown" && model.id === "unknown";
}

/**
 * How long the backend re-read may take. Matches Pi's own model-catalogue
 * refresh timeout.
 */
const REFRESH_TIMEOUT_MS = 15_000;

/**
 * Waits `ms` milliseconds.
 */
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Re-reads the llama.cpp backend catalogue until it is non-empty or the
 * retry budget is exhausted.
 *
 * Each attempt forces a fresh query of the server (capped by
 * {@link REFRESH_TIMEOUT_MS}); a failing refresh (backend unreachable) does
 * not abort the loop. Attempts are spaced by `config.delaySeconds`, with no
 * wait after the last one.
 *
 * @param ctx Extension context (for the model registry)
 * @param config The retry configuration (tries, delaySeconds)
 * @param sleepFn Injectable for tests
 * @returns The loaded models (possibly empty when the budget is exhausted)
 */
export async function pollCatalogue(
  ctx: ExtensionContext,
  config: RetryConfig,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<readonly Model<any>[]> {
  let models: readonly Model<any>[] = [];
  for (let attempt = 1; attempt <= config.tries; attempt++) {
    try {
      const registry: ModelRegistry = ctx.modelRegistry;
      await registry.refresh({
        providers: [LLAMA_PROVIDER_ID],
        force: true,
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
    } catch {
      // Backend unreachable — keep polling.
    }

    const provider = ctx.modelRegistry.getProvider(LLAMA_PROVIDER_ID);
    models = provider?.getModels?.() ?? [];
    if (models.length > 0) return models;
    if (attempt < config.tries) await sleepFn(config.delaySeconds * 1000);
  }
  return models;
}

/**
 * Recovers a llama.cpp model after the session resolved to the `unknown`
 * placeholder.
 *
 * Only acts when the user's persisted intent is llama.cpp (the settings
 * default provider) — an `unknown` model with a different default is Pi's
 * stock behavior and left alone. Re-reads the backend catalogue in a
 * re-poll (retry count and delay from the `llamaRetry` setting), then
 * prefers, in order:
 *
 * 1. the most recently selected llama.cpp model in this process (the
 *    in-memory default map — this is what `/new` used to have selected),
 * 2. the persisted settings default model,
 * 3. the first loaded model.
 *
 * @returns The model to switch to, or `undefined` when nothing can be
 *          recovered (backend still has no models — Pi keeps the
 *          placeholder and the user is notified).
 */
export async function recoverLlamaModel(
  ctx: ExtensionContext,
  resolver: ConfigResolver,
): Promise<Model<any> | undefined> {
  if (resolver.getDefaultProvider() !== LLAMA_PROVIDER_ID) return undefined;

  // The catalogue was empty at resolution time — re-read the backend.
  const models = await pollCatalogue(ctx, resolver.resolveRetryConfig());
  if (models.length === 0) {
    if (ctx.hasUI)
      ctx.ui.notify(
        `${PROVIDER_NAME}: no models loaded — load one with /llama`,
        "warning",
      );
    return undefined;
  }

  const preferred =
    (await getLlamaDefaultModel()) ?? resolver.getDefaultModel();

  return models.find((m) => m.id === preferred) ?? models[0];
}
