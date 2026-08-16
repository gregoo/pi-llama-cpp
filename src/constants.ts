import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/**
 * The ID of Pi's built-in llama.cpp provider, which this extension wraps
 */
export const LLAMA_PROVIDER_ID = "llama.cpp";

/**
 * This provider's name
 */
export const PROVIDER_NAME = "Llama.cpp";

/**
 * All the thinking levels Pi knows about.
 */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelThinkingLevel[];

/**
 * Additive per-level thinking spec. Whatever fields are set get injected
 * into the request payload; the rest is left alone. Level names carry no
 * special meaning — the spec itself dictates what happens.
 */
export interface ThinkingLevelSpec {
  /**
   * Injected as `thinking_budget_tokens` (0 is a valid value). Omit the
   * field for an unbounded level (no cap is injected).
   */
  budget?: number;
  /** Injected as `chat_template_kwargs.reasoning_effort` */
  effort?: string;
  /** Injected as `chat_template_kwargs.enable_thinking` */
  enable_thinking?: boolean;
  /**
   * Injected as `chat_template_kwargs.preserve_thinking` (model-specific,
   * does not control thinking enablement)
   */
  preserve_thinking?: boolean;
}

/**
 * The global default per-level thinking specs, used for models that have no
 * matching `llamaModelsConfig` pattern. The legacy `thinkingBudgets`
 * setting can
 * override the `budget` field for `minimal` through `xhigh` (see
 * {@link THINKING_BUDGET_OVERRIDE_LEVELS}).
 */
export const DEFAULT_THINKING_LEVELS: Record<
  ModelThinkingLevel,
  ThinkingLevelSpec
> = {
  off: { enable_thinking: false },
  minimal: { budget: 1024 },
  low: { budget: 2048 },
  medium: { budget: 8192 },
  high: { budget: 16384 },
  xhigh: { budget: 32768 },
  max: {},
};

/**
 * Sampling parameters accepted in `samplingMap` entries, as recognized by
 * the llama.cpp server API. Keys pass through verbatim to the request
 * payload, so names must match the server's field names. All values are
 * numbers. To support a new server parameter, add its name here.
 */
export const SAMPLING_PARAM_FIELDS = [
  // Core sampling
  "temperature",
  "top_k",
  "top_p",
  "min_p",
  "top_nsigma",
  "typical_p",
  "xtc_probability",
  "xtc_threshold",
  // Penalties
  "repeat_penalty",
  "penalty_last_n",
  "presence_penalty",
  "frequency_penalty",
  // DRY sampling
  "dry_multiplier",
  "dry_base",
  "dry_allowed_length",
  "dry_penalty_last_n",
  // adaptive-p
  "adaptive_target",
  "adaptive_decay",
  // Dynamic temperature
  "dynatemp_range",
  "dynatemp_exp",
  // Mirostat
  "mirostat",
  "mirostat_lms_lr",
  "mirostat_ent_max",
  // Reproducibility
  "seed",
] as const;

/**
 * Levels whose default `budget` can be overridden via `thinkingBudgets`.
 * `off` and `max` are fixed (they are not budget-driven).
 */
export const THINKING_BUDGET_OVERRIDE_LEVELS = THINKING_LEVELS.filter(
  (level) => level !== "off" && level !== "max",
) as ModelThinkingLevel[];
