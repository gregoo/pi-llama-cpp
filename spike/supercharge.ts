/**
 * SPIKE v2 — supercharge Pi's built-in "llama.cpp" provider with thinking levels.
 *
 * FINDING that reshaped this (see docs/builtin-provider-strategy.md):
 *   pi.registerProvider("llama.cpp", {models}) — the CONFIG form — DELETES the
 *   built-in's native provider registration (model-runtime.js registerProvider:
 *   `this.nativeExtensionProviders.delete(providerId)`). The composed provider
 *   then has no base → loses the built-in's auth check/resolve/login and its
 *   refreshModels → availability fails → /model empty, /llama broken.
 *
 * So instead we register a NATIVE provider (full object) that WRAPS the
 * built-in:
 *   - auth: pass-through of the built-in's auth object (login/check/resolve)
 *   - refreshModels: pass-through (catalog updates + persistence keep working;
 *     /llama's setCatalog mutates the same closure state)
 *   - stream/streamSimple: pass-through (wrap later for stats)
 *   - getModels: supercharge(builtin.getModels()) — LIVE catalog with
 *     wildcard-matched reasoning + thinkingLevelMap applied per call.
 *     No masking, no probe, no polling, no re-registration, never stale.
 *
 * Run:  pi -ne -e ./spike/supercharge.ts
 * Needs: /login llama.cpp (or LLAMA_BASE_URL) already configured, router mode.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "llama.cpp";
const STATUS_KEY = "llama-spike";

// ── Wildcard thinking config (spike: single catch-all) ──────────────────────
interface Override {
  reasoning: boolean;
  levels: Record<string, string | null>;
}

const OVERRIDES: Record<string, Override> = {
  "*": {
    reasoning: true,
    levels: {
      off: "Off",
      minimal: "Minimal",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "XHigh",
      max: "Max",
    },
  },
};

// Longest matching pattern wins (same rule as the extension's resolver).
function matchOverride(modelId: string): Override | undefined {
  let best: { key: string; value: Override } | undefined;
  for (const [key, value] of Object.entries(OVERRIDES)) {
    const re = new RegExp(
      "^" + key.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
    );
    if (re.test(modelId) && (!best || key.length > best.key.length)) best = { key, value };
  }
  return best?.value;
}

// Apply wildcard overrides to the built-in's live model list. Pure function:
// clones each model, adds reasoning/thinkingLevelMap, keeps everything else
// (compat, contextWindow, cost, input...) exactly as the built-in defined it.
interface Superchargable {
  id: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}

function supercharge<T extends Superchargable>(models: readonly T[]): T[] {
  return models.map((model) => {
    const ovr = matchOverride(model.id);
    if (!ovr) return model;
    return {
      ...model,
      reasoning: ovr.reasoning || model.reasoning,
      thinkingLevelMap: ovr.levels ?? model.thinkingLevelMap,
    };
  });
}

// ── State ───────────────────────────────────────────────────────────────────
let builtinProvider: any; // captured built-in provider object (for diagnostics)
let wrapped = false;

function superchargedIds(ctx: ExtensionContext): string[] {
  try {
    return ctx.modelRegistry
      .getAll()
      .filter((m) => m.provider === PROVIDER_ID)
      .map((m) => m.id);
  } catch {
    return [];
  }
}

// ── Wrap the built-in provider (once) ───────────────────────────────────────
function wrapBuiltin(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (wrapped) return;
  // Before we register anything, getProvider returns the raw built-in
  // (no overlays → runtime uses it untouched).
  const builtin = ctx.modelRegistry.getProvider(PROVIDER_ID);
  if (!builtin || typeof builtin.getModels !== "function") {
    console.log("[llama-spike] built-in llama.cpp provider not found; staying inert");
    return;
  }
  builtinProvider = builtin;

  // THE line under test: native-form registration that wraps the built-in.
  pi.registerProvider({
    id: PROVIDER_ID,
    name: builtin.name ?? "llama.cpp",
    baseUrl: builtin.baseUrl,
    auth: builtin.auth, // pass-through: /login llama.cpp keeps working
    getModels: () => supercharge(builtin.getModels() ?? []),
    refreshModels: builtin.refreshModels, // pass-through: /llama catalog sync
    stream: builtin.stream,
    streamSimple: builtin.streamSimple,
  });
  wrapped = true;

  const ids = superchargedIds(ctx);
  ctx.ui.setStatus(STATUS_KEY, `wrapped builtin: ${ids.join(", ") || "(none loaded)"}`);
  console.log(
    `[llama-spike][post-wrap] error=${JSON.stringify(ctx.modelRegistry.getError())} ` +
      `all=[${ids.join(",")}] ` +
      `available=[${ctx.modelRegistry
        .getAvailable()
        .filter((m) => m.provider === PROVIDER_ID)
        .map((m) => m.id)
        .join(",")}]`,
  );
}

// ── Payload injection: prove the selected level reaches llama-server ───────
const LEVEL_BUDGETS: Record<string, number | undefined> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: undefined, // unbounded = omit
};

// ── Extension entry ─────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI): void {
  const onSessionEvent = (ctx: ExtensionContext) => {
    wrapBuiltin(pi, ctx);
  };

  pi.on("session_start", (event, ctx) => {
    if (event.reason === "startup") onSessionEvent(ctx);
  });
  // Backstop in case session_start(startup) fires before the built-in loads.
  pi.on("model_select", (_e, ctx) => onSessionEvent(ctx));
  pi.on("turn_start", (_e, ctx) => onSessionEvent(ctx));

  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload as { model?: string } | undefined;
    // Gate: only models from the llama.cpp provider.
    if (!payload?.model || !superchargedIds(ctx).includes(payload.model)) {
      return payload;
    }

    const level = pi.getThinkingLevel();
    const additions: Record<string, unknown> = {};
    if (level === "off") {
      additions.chat_template_kwargs = { enable_thinking: false };
    } else {
      const budget = LEVEL_BUDGETS[level];
      if (budget !== undefined) additions.thinking_budget_tokens = budget;
    }
    return Object.keys(additions).length > 0
      ? { ...payload, ...additions }
      : payload;
  });
}
