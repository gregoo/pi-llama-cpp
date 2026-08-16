import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_THINKING_LEVELS, LLAMA_PROVIDER_ID } from "../src/constants";
import { EventManager } from "../src/managers/events";
import { SamplingState } from "../src/managers/sampling";
import { ConfigResolver } from "../src/resolver";

// Hoisted mock instances — survives vi.resetModules()
const mockSettingsManager = vi.hoisted(() => ({
  getDefaultThinkingLevel: vi.fn(),
  getThinkingBudgets: vi.fn(),
  getProjectSettings: vi.fn(),
  getGlobalSettings: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: vi.fn().mockReturnValue("/fake/agent/dir"),
  readStoredCredential: vi.fn(),
  SettingsManager: {
    create: vi.fn().mockReturnValue(mockSettingsManager),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockSettingsManager.getDefaultThinkingLevel.mockReturnValue("medium");
  mockSettingsManager.getThinkingBudgets.mockReturnValue(undefined);
  mockSettingsManager.getProjectSettings.mockReturnValue({});
  mockSettingsManager.getGlobalSettings.mockReturnValue({});
  SamplingState.clear();
});

/** Builds a minimal extension context with a current model. */
const createCtx = (
  model?: { id: string; provider: string },
  thinkingLevel?: ModelThinkingLevel,
): ExtensionContext =>
  ({ model, thinkingLevel }) as unknown as ExtensionContext;

const llamaCtx = (modelId: string, thinkingLevel?: ModelThinkingLevel) =>
  createCtx({ id: modelId, provider: LLAMA_PROVIDER_ID }, thinkingLevel);

const createPayload = (extra: Record<string, unknown> = {}) => ({
  messages: [{ role: "user", content: "hello" }],
  ...extra,
});

/** Runs a before_provider_request through a fresh EventManager. */
const runRequest = async (
  payload: Record<string, unknown>,
  ctx: ExtensionContext,
) => {
  const eventManager = new EventManager(new ConfigResolver());
  return (await eventManager.onBeforeProviderRequest(
    { payload } as any,
    ctx,
  )) as Record<string, unknown>;
};

describe("EventManager.onBeforeProviderRequest", () => {
  describe("normal usage — each thinking level", () => {
    const cases: { level: ModelThinkingLevel; expected: Record<string, unknown> }[] = [
      {
        level: "off",
        expected: { chat_template_kwargs: { enable_thinking: false } },
      },
      { level: "minimal", expected: { thinking_budget_tokens: 1024 } },
      { level: "low", expected: { thinking_budget_tokens: 2048 } },
      { level: "medium", expected: { thinking_budget_tokens: 8192 } },
      { level: "high", expected: { thinking_budget_tokens: 16384 } },
      { level: "xhigh", expected: { thinking_budget_tokens: 32768 } },
      { level: "max", expected: {} },
    ];

    it.each(cases)(
      'level "$level" should return $expected',
      async ({ level, expected }) => {
        const result = await runRequest(createPayload(), llamaCtx("m", level));

        expect(result).toMatchObject(expected);
      },
    );

    it("should preserve original payload fields alongside new ones", async () => {
      const payload = createPayload({ temperature: 0.7 });

      const result = await runRequest(payload, llamaCtx("m", "low"));

      expect(result.messages).toEqual([{ role: "user", content: "hello" }]);
      expect(result.temperature).toBe(0.7);
      expect(result.thinking_budget_tokens).toBe(
        DEFAULT_THINKING_LEVELS.low.budget,
      );
    });
  });

  describe("provider gating", () => {
    it("should return the payload unchanged for non-llama.cpp providers", async () => {
      const payload = createPayload();
      const ctx = createCtx({ id: "gpt-4", provider: "openai" }, "medium");

      const result = await runRequest(payload, ctx);

      expect(result).toBe(payload);
    });

    it("should return the payload unchanged when no model is set", async () => {
      const payload = createPayload();

      const result = await runRequest(payload, createCtx(undefined));

      expect(result).toBe(payload);
    });

    it("should request prompt_progress for llama.cpp models only", async () => {
      const llamaResult = await runRequest(createPayload(), llamaCtx("m"));
      expect(llamaResult.return_progress).toBe(true);

      const otherResult = await runRequest(
        createPayload(),
        createCtx({ id: "gpt-4", provider: "openai" }, "medium"),
      );
      expect(otherResult).not.toHaveProperty("return_progress");
    });
  });

  describe("thinking level resolution", () => {
    it("should prefer the session thinking level over the configured default", async () => {
      mockSettingsManager.getDefaultThinkingLevel.mockReturnValue("low");

      const result = await runRequest(createPayload(), llamaCtx("m", "high"));

      expect(result.thinking_budget_tokens).toBe(
        DEFAULT_THINKING_LEVELS.high.budget,
      );
    });

    it("should fall back to the configured default when the session level is unset", async () => {
      mockSettingsManager.getDefaultThinkingLevel.mockReturnValue("low");

      const result = await runRequest(createPayload(), llamaCtx("m"));

      expect(result.thinking_budget_tokens).toBe(
        DEFAULT_THINKING_LEVELS.low.budget,
      );
    });

    it("should fall back to medium when neither session nor default is set", async () => {
      mockSettingsManager.getDefaultThinkingLevel.mockReturnValue(undefined);

      const result = await runRequest(createPayload(), llamaCtx("m"));

      expect(result.thinking_budget_tokens).toBe(
        DEFAULT_THINKING_LEVELS.medium.budget,
      );
    });
  });

  describe("user-defined budget overrides", () => {
    it("should use user-defined budgets instead of defaults", async () => {
      mockSettingsManager.getThinkingBudgets.mockReturnValue({ low: 4096 });

      const result = await runRequest(createPayload(), llamaCtx("m", "low"));

      expect(result.thinking_budget_tokens).toBe(4096);
    });

    it("should merge user budgets with defaults (partial override)", async () => {
      mockSettingsManager.getThinkingBudgets.mockReturnValue({ low: 4096 });

      const result = await runRequest(createPayload(), llamaCtx("m", "medium"));

      // medium uses default since user only overrode low
      expect(result.thinking_budget_tokens).toBe(
        DEFAULT_THINKING_LEVELS.medium.budget,
      );
    });
  });

  // ─── Edge cases ─────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should ignore invalid keys in user budgets (they are silently dropped)", async () => {
      mockSettingsManager.getThinkingBudgets.mockReturnValue({
        foo: 999,
        bar: 123,
      } as any);

      const result = await runRequest(createPayload(), llamaCtx("m", "medium"));

      expect(result.thinking_budget_tokens).toBe(
        DEFAULT_THINKING_LEVELS.medium.budget,
      );
    });

    it("should not allow overriding 'off' — thinking stays disabled", async () => {
      mockSettingsManager.getThinkingBudgets.mockReturnValue({
        off: 99999,
      } as any);

      const result = await runRequest(createPayload(), llamaCtx("m", "off"));

      expect(result).toMatchObject({
        chat_template_kwargs: { enable_thinking: false },
      });
      expect(result).not.toHaveProperty("thinking_budget_tokens");
    });

    it("should not apply thinkingBudgets overrides to 'max' (stays unbounded)", async () => {
      mockSettingsManager.getThinkingBudgets.mockReturnValue({
        max: 50000,
      } as any);

      const payload = createPayload();
      const result = await runRequest(payload, llamaCtx("m", "max"));

      expect(result).toEqual({ ...payload, return_progress: true });
      expect(result).not.toHaveProperty("thinking_budget_tokens");
    });
  });

  // ─── Per-model thinking configuration (llamaModelsConfig) ─────────────

  describe("per-model llamaModelsConfig configuration", () => {
    const QWEN35_MAP = {
      off: { enable_thinking: false, preserve_thinking: false },
      minimal: { effort: "low", budget: 1024 },
      low: { effort: "low", budget: 8192 },
      medium: { effort: "medium", budget: 8192 },
      high: { effort: "xhigh", budget: 8192 },
      xhigh: { effort: "xhigh" },
    };

    const setLlamaModelsConfig = (entries: Record<string, unknown>) =>
      mockSettingsManager.getProjectSettings.mockReturnValue({
        llamaModelsConfig: entries,
      });

    it("should inject both effort and budget when both are set", async () => {
      setLlamaModelsConfig({ "qwen3.5*": { thinkingLevelMap: QWEN35_MAP } });

      const result = await runRequest(createPayload(), llamaCtx("qwen3.5-27b", "minimal"));

      expect(result).toMatchObject({
        thinking_budget_tokens: 1024,
        chat_template_kwargs: { reasoning_effort: "low" },
      });
    });

    it("should inject only the effort when no budget is set (unbounded)", async () => {
      setLlamaModelsConfig({ "qwen3.5*": { thinkingLevelMap: QWEN35_MAP } });

      const result = await runRequest(createPayload(), llamaCtx("qwen3.5-27b", "xhigh"));

      expect(result).toMatchObject({
        chat_template_kwargs: { reasoning_effort: "xhigh" },
      });
      expect(result).not.toHaveProperty("thinking_budget_tokens");
    });

    it("should inject the off kwargs when configured for the off level", async () => {
      setLlamaModelsConfig({ "qwen3.5*": { thinkingLevelMap: QWEN35_MAP } });

      const result = await runRequest(createPayload(), llamaCtx("qwen3.5-27b", "off"));

      expect(result).toMatchObject({
        chat_template_kwargs: {
          enable_thinking: false,
          preserve_thinking: false,
        },
      });
      expect(result).not.toHaveProperty("thinking_budget_tokens");
    });

    it("should support off with both the kwargs and a budget of 0", async () => {
      setLlamaModelsConfig({
        "*": {
          thinkingLevelMap: {
            off: {
              enable_thinking: false,
              preserve_thinking: false,
              budget: 0,
            },
          },
        },
      });

      const result = await runRequest(createPayload(), llamaCtx("m", "off"));

      expect(result).toMatchObject({
        thinking_budget_tokens: 0,
        chat_template_kwargs: {
          enable_thinking: false,
          preserve_thinking: false,
        },
      });
    });

    it("should leave the payload untouched for hole levels (absent keys)", async () => {
      setLlamaModelsConfig({ "qwen3.5*": { thinkingLevelMap: QWEN35_MAP } });

      const payload = createPayload();
      const result = await runRequest(payload, llamaCtx("qwen3.5-27b", "max"));

      expect(result).toEqual({ ...payload, return_progress: true });
    });

    it("should leave the payload untouched for explicit null levels", async () => {
      setLlamaModelsConfig({ "*": { thinkingLevelMap: { low: null } } });

      const payload = createPayload();
      const result = await runRequest(payload, llamaCtx("m", "low"));

      expect(result).toEqual({ ...payload, return_progress: true });
    });

    it("should leave the payload untouched for empty-object levels", async () => {
      setLlamaModelsConfig({ "*": { thinkingLevelMap: { low: {} } } });

      const payload = createPayload();
      const result = await runRequest(payload, llamaCtx("m", "low"));

      expect(result).toEqual({ ...payload, return_progress: true });
    });

    it("should use budget-only entries for budget models (e.g. qwen3.6)", async () => {
      setLlamaModelsConfig({
        "qwen3.6*": {
          thinkingLevelMap: {
            off: { enable_thinking: false, preserve_thinking: false },
            low: { budget: 2048 },
            medium: { budget: 8192 },
          },
        },
      });

      const result = await runRequest(createPayload(), llamaCtx("qwen3.6-27b", "low"));

      expect(result).toMatchObject({ thinking_budget_tokens: 2048 });
      expect(result).not.toHaveProperty("chat_template_kwargs");
    });

    it("should fall back to the historical budget behavior when no pattern matches", async () => {
      setLlamaModelsConfig({ "qwen3.5*": { thinkingLevelMap: QWEN35_MAP } });

      const result = await runRequest(createPayload(), llamaCtx("some-other-model", "high"));

      expect(result.thinking_budget_tokens).toBe(
        DEFAULT_THINKING_LEVELS.high.budget,
      );
    });

    it("should prefer the most specific matching pattern", async () => {
      setLlamaModelsConfig({
        "*": { thinkingLevelMap: { low: { budget: 1 } } },
        "qwen3.5*": { thinkingLevelMap: { low: { budget: 2 } } },
      });

      const result = await runRequest(createPayload(), llamaCtx("qwen3.5-27b", "low"));

      expect(result.thinking_budget_tokens).toBe(2);
    });

    describe("sampling set injection", () => {
      const setSamplingConfig = (entries: Record<string, unknown>) =>
        mockSettingsManager.getProjectSettings.mockReturnValue({
          llamaModelsConfig: entries,
        });

      it("should inject the selected set's parameters top-level", async () => {
        setSamplingConfig({
          "*": {
            samplingMap: {
              thinking: {
                temperature: 1.0,
                top_p: 0.95,
                presence_penalty: 0.0,
              },
            },
          },
        });
        SamplingState.set("m", "thinking");

        const result = await runRequest(createPayload(), llamaCtx("m"));

        expect(result).toMatchObject({
          temperature: 1.0,
          top_p: 0.95,
          presence_penalty: 0.0,
        });
      });

      it("should inject sampling params alongside the thinking spec", async () => {
        setSamplingConfig({
          "*": {
            thinkingLevelMap: { low: { budget: 8192 } },
            samplingMap: { instruct: { temperature: 0.7 } },
          },
        });
        SamplingState.set("m", "instruct");

        const result = await runRequest(createPayload(), llamaCtx("m", "low"));

        expect(result).toMatchObject({
          thinking_budget_tokens: 8192,
          temperature: 0.7,
        });
      });

      it("should inject nothing when no set is selected", async () => {
        setSamplingConfig({
          "*": { samplingMap: { thinking: { temperature: 1.0 } } },
        });

        const result = await runRequest(createPayload(), llamaCtx("m"));

        expect(result).toEqual({
          ...createPayload(),
          return_progress: true,
          thinking_budget_tokens: DEFAULT_THINKING_LEVELS.medium.budget,
        });
      });

      it("should not leak a selection from another model", async () => {
        setSamplingConfig({
          "*": { samplingMap: { thinking: { temperature: 1.0 } } },
        });
        SamplingState.set("other-model", "thinking");

        const result = await runRequest(createPayload(), llamaCtx("m"));

        expect(result).not.toHaveProperty("temperature");
      });

      it("should ignore a selected set that no longer exists for the model", async () => {
        setSamplingConfig({
          "*": { samplingMap: { instruct: { temperature: 0.7 } } },
        });
        SamplingState.set("m", "thinking");

        const result = await runRequest(createPayload(), llamaCtx("m"));

        expect(result).not.toHaveProperty("temperature");
      });

      it("should inject nothing for models without a samplingMap", async () => {
        SamplingState.set("m", "thinking");

        const result = await runRequest(createPayload(), llamaCtx("m"));

        expect(result).not.toHaveProperty("temperature");
      });
    });
  });
});

describe("EventManager.onModelSelect", () => {
  it("should restore the sampling status for llama.cpp models", () => {
    const setStatus = vi.fn();
    const ctx = createCtx({ id: "m", provider: LLAMA_PROVIDER_ID });
    (ctx as any).ui = { setStatus };
    SamplingState.set("m", "thinking");

    new EventManager(new ConfigResolver()).onModelSelect(
      { model: { id: "m", provider: LLAMA_PROVIDER_ID } },
      ctx,
    );

    expect(setStatus).toHaveBeenCalledWith("Llama.cpp", "sampling: thinking");
  });

  it("should clear the status when no set is selected", () => {
    const setStatus = vi.fn();
    const ctx = createCtx({ id: "m", provider: LLAMA_PROVIDER_ID });
    (ctx as any).ui = { setStatus };

    new EventManager(new ConfigResolver()).onModelSelect(
      { model: { id: "m", provider: LLAMA_PROVIDER_ID } },
      ctx,
    );

    expect(setStatus).toHaveBeenCalledWith("Llama.cpp", undefined);
  });

  it("should ignore non-llama.cpp models", () => {
    const setStatus = vi.fn();
    const ctx = createCtx({ id: "gpt-4", provider: "openai" });
    (ctx as any).ui = { setStatus };

    new EventManager(new ConfigResolver()).onModelSelect(
      { model: { id: "gpt-4", provider: "openai" } },
      ctx,
    );

    expect(setStatus).not.toHaveBeenCalled();
  });
});
