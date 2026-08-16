import { ApiKeyCredential, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  readStoredCredential,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  API_KEY_PLACEHOLDER,
  DEFAULT_LLAMA_SERVER_URL,
  DEFAULT_THINKING_LEVELS,
  SAMPLING_PARAM_FIELDS,
  THINKING_BUDGET_OVERRIDE_LEVELS,
  THINKING_LEVELS,
  type ThinkingLevelSpec,
} from "./constants";

export class ConfigResolver {
  private warnings: string[] = [];

  private cachedUrls: string[] = [];
  private settingsManager = SettingsManager.create(
    process.cwd(),
    getAgentDir(),
  );

  /**
   * Resolves the llama-server URL by searching in the global settings.json
   */
  private async resolveGlobalUrl(): Promise<string | null> {
    const settings = this.settingsManager.getGlobalSettings();
    const { llamaServerUrl = null } = settings as Record<string, string>;

    return llamaServerUrl;
  }

  /**
   * Resolves the llama-server URL by searching in the project's .pi/settings.json
   */
  private async resolveProjectUrl(): Promise<string | null> {
    // Warn the user for deprecation
    try {
      const filePath = join(process.cwd(), ".pi", "llama-server.json");
      const { url = null } = JSON.parse(await readFile(filePath, "utf-8"));

      const messages = [
        "[pi-llama-cpp]",
        "The project-level `.pi/llama-server.json` file has been deprecated.",
        "It will work for now, but you must follow these instructions as soon as possible:",
        '- Move your url to the project-level `.pi/settings.json` file as {"llamaServerUrl": "<url>"}.',
        "- Remove the old `.pi/llama-server.json` file.",
      ];

      this.warnings.push(messages.join("\n"));

      return url;
    } catch {
      // No old file available, continue as normal
    }

    const settings = this.settingsManager.getProjectSettings();
    const { llamaServerUrl = null } = settings as Record<string, string>;

    return llamaServerUrl;
  }

  /**
   * Resolves the llama-server URL from the environment
   */
  private async resolveEnvUrl(): Promise<string | null> {
    return process.env.LLAMA_SERVER_URL ?? null;
  }

  /**
   * Tries all possible ways to retrieve the llama-server URL(s)
   */
  private async extractJoinedUrls(): Promise<string> {
    // 1. per-project config
    let response = await this.resolveProjectUrl();
    if (response) return response;

    // 2. env
    response = await this.resolveEnvUrl();
    if (response) return response;

    // 3. global settings
    response = await this.resolveGlobalUrl();
    if (response) return response;

    // 4. default
    return DEFAULT_LLAMA_SERVER_URL;
  }

  /**
   * Resolves URLs where llama-servers are running (cached)
   */
  async resolveUrls(): Promise<string[]> {
    if (this.cachedUrls.length > 0) return this.cachedUrls;

    const raw = await this.extractJoinedUrls();
    const urls = raw
      .split(";")
      .map((u) => u.trim())
      .filter((u) => u.length > 0)
      .map((u) => u.replace(/\/+$/, ""));

    this.cachedUrls = urls;
    return this.cachedUrls;
  }

  /**
   * Resolves API key for the provider ID using Pi's stored credentials
   */
  resolveApiKey(providerId: string): string {
    const credential = readStoredCredential(providerId) as ApiKeyCredential;
    return credential?.key ?? API_KEY_PLACEHOLDER;
  }

  /**
   * Returns warnings collected during URL resolution.
   */
  getWarnings(): string[] {
    const warnings = [...this.warnings];
    this.warnings.length = 0;

    return warnings;
  }

  /*
   * Resolves the current thinking level from Pi.
   *
   * @returns Selected level
   */
  resolveThinkingLevel(): ModelThinkingLevel | undefined {
    return this.settingsManager.getDefaultThinkingLevel();
  }

  /**
   * Resolves the effective per-level thinking specs for a model.
   *
   * Reads the `thinkingLevelMap` of the model's `llamaModelsConfig` entry
   * (see {@link resolveLlamaModelsEntry}):
   *
   * ```json
   * {
   *   "llamaModelsConfig": {
   *     "qwen3.5*": {
   *       "thinkingLevelMap": {
   *         "off": { "enable_thinking": false },
   *         "minimal": { "effort": "low", "budget": 1024 },
   *         "low": { "effort": "low", "budget": 8192 },
   *         "medium": { "effort": "medium", "budget": 8192 },
   *         "high": { "effort": "xhigh", "budget": 8192 },
   *         "xhigh": { "effort": "xhigh" }
   *       }
   *     }
   *   }
   * }
   * ```
   *
   * Each present level key maps to an additive spec — whatever fields are
   * set get injected into the request payload (see {@link ThinkingLevelSpec}).
   * Multiple fields can be set at once (e.g. effort + budget). Holes (absent
   * keys) and explicit `null` mean the level is unavailable; an empty object
   * means the level is available but adds nothing to the payload.
   *
   * When no pattern matches the model (or the entry has no usable
   * `thinkingLevelMap`), the global default map is used instead, with the
   * legacy `thinkingBudgets` setting applied as per-level `budget` overrides.
   *
   * @param modelId The model ID from the request payload
   * @returns The effective per-level thinking specs
   */
  resolveThinkingLevels(
    modelId: string,
  ): Record<ModelThinkingLevel, ThinkingLevelSpec | null> {
    const raw = this.resolveLlamaModelsEntry(modelId)?.thinkingLevelMap;

    if (raw === null || typeof raw !== "object")
      return this.resolveDefaultLevels();

    const levels = {} as Record<ModelThinkingLevel, ThinkingLevelSpec | null>;
    for (const level of THINKING_LEVELS)
      levels[level] = this.parseLevelSpec(
        (raw as Record<string, unknown>)[level],
      );

    return levels;
  }

  /**
   * Resolves the named sampling parameter sets for a model.
   *
   * Reads the `samplingMap` of the model's `llamaModelsConfig` entry:
   *
   * ```json
   * {
   *   "llamaModelsConfig": {
   *     "qwen3.5*": {
   *       "samplingMap": {
   *         "thinking": {
   *           "temperature": 1.0,
   *           "top_p": 0.95,
   *           "top_k": 20,
   *           "presence_penalty": 0.0,
   *           "repeat_penalty": 1.0
   *         },
   *         "instruct": {
   *           "temperature": 0.7,
   *           "top_p": 0.8,
   *           "top_k": 20,
   *           "presence_penalty": 1.5,
   *           "repeat_penalty": 1.0
   *         }
   *       }
   *     }
   *   }
   * }
   * ```
   *
   * Each key is a set name and its value is a dict of sampling parameters.
   * Parameter keys pass through verbatim to the request payload, so they
   * must match the llama.cpp server's field names (see
   * {@link SAMPLING_PARAM_FIELDS}); unknown or non-numeric fields are
   * dropped. Sets with no usable fields are omitted.
   *
   * There is no default sampling map — nothing is injected unless the user
   * selects a set for the model (session-only, per model).
   *
   * @param modelId The model ID
   * @returns The set name → parameters map, or undefined if none available
   */
  resolveSamplingMap(
    modelId: string,
  ): Record<string, Record<string, number>> | undefined {
    const raw = this.resolveLlamaModelsEntry(modelId)?.samplingMap;
    if (raw === null || typeof raw !== "object") return undefined;

    const map: Record<string, Record<string, number>> = {};
    for (const [name, value] of Object.entries(
      raw as Record<string, unknown>,
    )) {
      const params = this.parseSamplingSet(value);
      if (params) map[name] = params;
    }

    return Object.keys(map).length > 0 ? map : undefined;
  }

  /**
   * Resolves the raw `llamaModelsConfig` entry for a model.
   *
   * Reads the `llamaModelsConfig` setting — a dict of wildcard model
   * patterns to entries, project-level overriding global (see
   * {@link findBestModelPattern}).
   *
   * @param modelId The model ID
   * @returns The matching entry, if any
   */
  private resolveLlamaModelsEntry(
    modelId: string,
  ): LlamaModelsConfigEntry | undefined {
    const project = this.settingsManager.getProjectSettings() as Record<
      string,
      unknown
    >;
    const global = this.settingsManager.getGlobalSettings() as Record<
      string,
      unknown
    >;

    const entries: Record<string, LlamaModelsConfigEntry> = {
      ...((global.llamaModelsConfig as Record<
        string,
        LlamaModelsConfigEntry
      >) ?? {}),
      ...((project.llamaModelsConfig as Record<
        string,
        LlamaModelsConfigEntry
      >) ?? {}),
    };

    const pattern = this.findBestModelPattern(entries, modelId);
    return pattern !== undefined ? entries[pattern] : undefined;
  }

  /**
   * Parses a single sampling set from raw settings, keeping only fields the
   * llama.cpp server accepts (see {@link SAMPLING_PARAM_FIELDS}) with
   * numeric values.
   *
   * @param value The raw value for one set name
   * @returns The parsed parameters, or null if the set has no usable fields
   */
  private parseSamplingSet(value: unknown): Record<string, number> | null {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return null;

    const params: Record<string, number> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (
        (SAMPLING_PARAM_FIELDS as readonly string[]).includes(key) &&
        typeof raw === "number" &&
        Number.isFinite(raw)
      )
        params[key] = raw;
    }

    return Object.keys(params).length > 0 ? params : null;
  }

  /**
   * Resolves the global default per-level thinking specs, applying the
   * legacy `thinkingBudgets` setting as `budget` overrides for the
   * overridable levels (minimal through xhigh).
   *
   * @returns The effective default per-level thinking specs
   */
  private resolveDefaultLevels(): Record<
    ModelThinkingLevel,
    ThinkingLevelSpec
  > {
    const overrides = (this.settingsManager.getThinkingBudgets() ??
      {}) as Partial<Record<ModelThinkingLevel, number>>;

    const levels = {} as Record<ModelThinkingLevel, ThinkingLevelSpec>;
    for (const level of THINKING_LEVELS) {
      const base = DEFAULT_THINKING_LEVELS[level];

      levels[level] =
        THINKING_BUDGET_OVERRIDE_LEVELS.includes(level) &&
        typeof overrides[level] === "number"
          ? { ...base, budget: overrides[level] }
          : { ...base };
    }

    return levels;
  }

  /**
   * Resolves the thinking level map exposed to Pi for a model.
   * Available levels are advertised by name; unavailable levels are `null`
   * (hidden/skipped/clamped by Pi).
   *
   * @param modelId The model ID
   * @returns The effective thinking level map
   */
  resolveThinkingLevelMap(
    modelId: string,
  ): Record<ModelThinkingLevel, string | null> {
    const levels = this.resolveThinkingLevels(modelId);

    const map = {} as Record<ModelThinkingLevel, string | null>;
    for (const level of THINKING_LEVELS)
      map[level] = levels[level] !== null ? level : null;

    return map;
  }

  /**
   * Parses a single level spec from raw settings.
   *
   * @param value The raw value (absent, null, or a spec object)
   * @returns The parsed spec, or null if the level is unavailable
   */
  private parseLevelSpec(value: unknown): ThinkingLevelSpec | null {
    if (value === null || typeof value !== "object") return null;

    const v = value as Record<string, unknown>;
    const spec: ThinkingLevelSpec = {};
    if (typeof v.budget === "number") spec.budget = v.budget;
    if (typeof v.effort === "string") spec.effort = v.effort;
    if (typeof v.enable_thinking === "boolean")
      spec.enable_thinking = v.enable_thinking;
    if (typeof v.preserve_thinking === "boolean")
      spec.preserve_thinking = v.preserve_thinking;

    return spec;
  }

  /**
   * Finds the most specific `llamaModelsConfig` pattern matching a model ID.
   * Patterns support `*` wildcards. Longest pattern wins; first-defined wins
   * on ties.
   *
   * @param entries The `llamaModelsConfig` entries
   * @param modelId The model ID to match
   * @returns The winning pattern, if any
   */
  private findBestModelPattern(
    entries: Record<string, LlamaModelsConfigEntry>,
    modelId: string,
  ): string | undefined {
    let best: string | undefined;

    for (const pattern of Object.keys(entries)) {
      if (!this.matchesPattern(pattern, modelId)) continue;
      if (best === undefined || pattern.length > best.length) best = pattern;
    }

    return best;
  }

  /**
   * Checks whether a wildcard pattern matches a model ID.
   *
   * @param pattern The pattern (supports `*` wildcards)
   * @param modelId The model ID
   * @returns Whether the pattern matches
   */
  private matchesPattern(pattern: string, modelId: string): boolean {
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");

    return new RegExp(`^${escaped}$`).test(modelId);
  }
}

/**
 * A single `llamaModelsConfig` settings entry.
 */
interface LlamaModelsConfigEntry {
  thinkingLevelMap?: unknown;
  samplingMap?: unknown;
}
