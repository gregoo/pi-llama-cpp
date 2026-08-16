import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_THINKING_LEVELS } from "../src/constants";
import { SamplingState } from "../src/managers/sampling";
import { createMockModel, createMockServer } from "./mocks";

// Create a mutable mock object shared across tests
const mockSettingsManager = {
  getDefaultThinkingLevel: vi.fn(() => "medium"),
  getThinkingBudgets: vi.fn<() => Record<string, number> | undefined>(),
  getProjectSettings: vi.fn<() => Record<string, unknown>>(() => ({})),
  getGlobalSettings: vi.fn<() => Record<string, unknown>>(() => ({})),
};

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    SettingsManager: {
      create: () => mockSettingsManager,
    },
  };
});

let EventManager: typeof import("../src/managers/events").EventManager;

beforeAll(async () => {
  const mod = await vi.importActual("../src/managers/events");
  EventManager =
    mod.EventManager as typeof import("../src/managers/events").EventManager;
});

beforeEach(() => {
  vi.restoreAllMocks();
  EventManager.resetInflightModel();
  SamplingState.clear();
  mockSettingsManager.getDefaultThinkingLevel.mockReturnValue("medium");
  mockSettingsManager.getThinkingBudgets.mockReturnValue(undefined);
  mockSettingsManager.getProjectSettings.mockReturnValue({});
  mockSettingsManager.getGlobalSettings.mockReturnValue({});
});

const createPayload = (modelId: string) => ({
  model: modelId,
  messages: [{ role: "user", content: "hello" }],
});

const createNonLlamaPayload = () => ({
  model: "gpt-4",
  messages: [{ role: "user", content: "hello" }],
});

describe("EventManager.onBeforeProviderRequest", () => {
  describe("normal usage — each thinking level", () => {
    it.each([
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
    ])(
      'level "$level" should return $expected',
      async ({ level, expected }) => {
        mockSettingsManager.getDefaultThinkingLevel.mockReturnValue(level);

        const server = createMockServer({
          models: ["model-a"].map((id) => createMockModel(id)),
        });
        const eventManager = new EventManager([server]);
        const event = { payload: createPayload("model-a") };

        const result = (await eventManager.onBeforeProviderRequest(
          event as any,
        )) as Record<string, unknown>;

        expect(result.model).toBe("model-a");
        expect(result).toMatchObject(expected);
      },
    );

    it("should preserve original payload fields alongside new ones", async () => {
      mockSettingsManager.getDefaultThinkingLevel.mockReturnValue("low");

      const server = createMockServer({
        models: ["model-b"].map((id) => createMockModel(id)),
      });
      const eventManager = new EventManager([server]);
      const event = {
        payload: {
          model: "model-b",
          messages: [{ role: "user", content: "test" }],
          temperature: 0.7,
        },
      };

      const result = (await eventManager.onBeforeProviderRequest(
        event as any,
      )) as Record<string, unknown>;

      expect(result.messages).toEqual([{ role: "user", content: "test" }]);
      expect(result.temperature).toBe(0.7);
      expect(result.thinking_budget_tokens).toBe(
        DEFAULT_THINKING_LEVELS.low.budget,
      );
    });
  });

  describe("non-llama.cpp models", () => {
    it("should return the payload unchanged for unknown models", async () => {
      const server = createMockServer({
        models: ["model-a"].map((id) => createMockModel(id)),
      });
      const eventManager = new EventManager([server]);
      const event = { payload: createNonLlamaPayload() };

      const result = await eventManager.onBeforeProviderRequest(event as any);

      expect(result).toEqual(createNonLlamaPayload());
    });
  });

  describe("missing model in payload", () => {
    it("should return the payload unchanged when model is absent", async () => {
      const server = createMockServer({
        models: ["model-a"].map((id) => createMockModel(id)),
      });
      const eventManager = new EventManager([server]);
      const event = { payload: { messages: [] } };

      const result = await eventManager.onBeforeProviderRequest(event as any);

      expect(result).toEqual({ messages: [] });
    });
  });

  describe("user-defined budget overrides", () => {
    it("should use user-defined budgets instead of defaults", async () => {
      mockSettingsManager.getDefaultThinkingLevel.mockReturnValue("low");
      mockSettingsManager.getThinkingBudgets.mockReturnValue({ low: 4096 });

      const server = createMockServer({
        models: ["model-a"].map((id) => createMockModel(id)),
      });
      const eventManager = new EventManager([server]);
      const event = { payload: createPayload("model-a") };

      const result = (await eventManager.onBeforeProviderRequest(
        event as any,
      )) as Record<string, unknown>;

      expect(result.thinking_budget_tokens).toBe(4096);
    });

    it("should merge user budgets with defaults (partial override)", async () => {
      mockSettingsManager.getDefaultThinkingLevel.mockReturnValue("medium");
      mockSettingsManager.getThinkingBudgets.mockReturnValue({ low: 4096 });

      const server = createMockServer({
        models: ["model-a"].map((id) => createMockModel(id)),
      });
      const eventManager = new EventManager([server]);
      const event = { payload: createPayload("model-a") };

      const result = (await eventManager.onBeforeProviderRequest(
        event as any,
      )) as Record<string, unknown>;

      // medium uses default since user only overrode low
      expect(result.thinking_budget_tokens).toBe(
        DEFAULT_THINKING_LEVELS.medium.budget,
      );
    });
  });

  // ─── Edge cases ─────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should ignore invalid keys in user budgets (they are silently dropped)", async () => {
      mockSettingsManager.getDefaultThinkingLevel.mockReturnValue("medium");
      mockSettingsManager.getThinkingBudgets.mockReturnValue({
        foo: 999,
        bar: 123,
      } as any);

      const server = createMockServer({
        models: ["model-a"].map((id) => createMockModel(id)),
      });
      const eventManager = new EventManager([server]);
      const event = { payload: createPayload("model-a") };

      const result = (await eventManager.onBeforeProviderRequest(
        event as any,
      )) as Record<string, unknown>;

      // Should fall back to default since "medium" is not in user budgets
      expect(result.thinking_budget_tokens).toBe(
        DEFAULT_THINKING_LEVELS.medium.budget,
      );
    });

    it("should not allow overriding 'off' — thinking stays disabled", async () => {
      mockSettingsManager.getDefaultThinkingLevel.mockReturnValue("off");
      mockSettingsManager.getThinkingBudgets.mockReturnValue({
        off: 99999,
      } as any);

      const server = createMockServer({
        models: ["model-a"].map((id) => createMockModel(id)),
      });
      const eventManager = new EventManager([server]);
      const event = { payload: createPayload("model-a") };

      const result = (await eventManager.onBeforeProviderRequest(
        event as any,
      )) as Record<string, unknown>;

      expect(result).toMatchObject({
        chat_template_kwargs: { enable_thinking: false },
      });
      expect(result).not.toHaveProperty("thinking_budget_tokens");
    });

    it("should not apply thinkingBudgets overrides to 'max' (stays unbounded)", async () => {
      mockSettingsManager.getDefaultThinkingLevel.mockReturnValue("max");
      mockSettingsManager.getThinkingBudgets.mockReturnValue({
        max: 50000,
      } as any);

      const server = createMockServer({
        models: ["model-a"].map((id) => createMockModel(id)),
      });
      const eventManager = new EventManager([server]);
      const event = { payload: createPayload("model-a") };

      const result = (await eventManager.onBeforeProviderRequest(
        event as any,
      )) as Record<string, unknown>;

      expect(result).toEqual(createPayload("model-a"));
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

    const setLlamaThinking = (entries: Record<string, unknown>) =>
      mockSettingsManager.getProjectSettings.mockReturnValue({
        llamaModelsConfig: entries,
      });

    const runRequest = async (modelId: string) => {
      const server = createMockServer({
        models: [modelId].map((id) => createMockModel(id)),
      });
      const eventManager = new EventManager([server]);
      const event = { payload: createPayload(modelId) };

      return (await eventManager.onBeforeProviderRequest(
        event as any,
      )) as Record<string, unknown>;
    };

    it("should inject both effort and budget when both are set", async () => {
      setLlamaThinking({ "qwen3.5*": { thinkingLevelMap: QWEN35_MAP } });
      mockSettingsManager.getDefaultThinkingLevel.mockReturnValue("minimal");

      const result = await runRequest("qwen3.5-27b");

      expect(result).toMatchObject({
        thinking_budget_tokens: 1024,
        chat_template_kwargs: { reasoning_effort: "low" },
      });
    });

    it("should inject only the effort when no budget is set (unbounded)", async () => {
      setLlamaThinking({ "qwen3.5*": { thinkingLevelMap: QWEN35_MAP } });
      mockSettingsManager.getDefaultThinkingLevel.mockReturnValue("xhigh");

      const result = await runRequest("qwen3.5-27b");

      expect(result).toMatchObject({
        chat_template_kwargs: { reasoning_effort: "xhigh" },
      });
      expect(result).not.toHaveProperty("thinking_budget_tokens");
    });

    it("should inject the off kwargs when configured for the off level", async () => {
      setLlamaThinking({ "qwen3.5*": { thinkingLevelMap: QWEN35_MAP } });
      mockSettingsManager.getDefaultThinkingLevel.mockReturnValue("off");

      const result = await runRequest("qwen3.5-27b");

      expect(result).toMatchObject({
        chat_template_kwargs: {
          enable_thinking: false,
          preserve_thinking: false,
        },
      });
      expect(result).not.toHaveProperty("thinking_budget_tokens");
    });

    it("should support off with both the kwargs and a budget of 0", async () => {
      setLlamaThinking({
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
      mockSettingsManager.getDefaultThinkingLevel.mockReturnValue("off");

      const result = await runRequest("m");

      expect(result).toMatchObject({
        thinking_budget_tokens: 0,
        chat_template_kwargs: {
          enable_thinking: false,
          preserve_thinking: false,
        },
      });
    });

    it("should leave the payload untouched for hole levels (absent keys)", async () => {
      setLlamaThinking({ "qwen3.5*": { thinkingLevelMap: QWEN35_MAP } });
      mockSettingsManager.getDefaultThinkingLevel.mockReturnValue("max");

      const result = await runRequest("qwen3.5-27b");

      expect(result).toEqual(createPayload("qwen3.5-27b"));
    });

    it("should leave the payload untouched for explicit null levels", async () => {
      setLlamaThinking({ "*": { thinkingLevelMap: { low: null } } });
      mockSettingsManager.getDefaultThinkingLevel.mockReturnValue("low");

      const result = await runRequest("m");

      expect(result).toEqual(createPayload("m"));
    });

    it("should leave the payload untouched for empty-object levels", async () => {
      setLlamaThinking({ "*": { thinkingLevelMap: { low: {} } } });
      mockSettingsManager.getDefaultThinkingLevel.mockReturnValue("low");

      const result = await runRequest("m");

      expect(result).toEqual(createPayload("m"));
    });

    describe("sampling set injection", () => {
      const setSamplingConfig = (entries: Record<string, unknown>) =>
        mockSettingsManager.getProjectSettings.mockReturnValue({
          llamaModelsConfig: entries,
        });

      const runRequest = async (modelId: string) => {
        const server = createMockServer({
          models: [modelId].map((id) => createMockModel(id)),
        });
        const eventManager = new EventManager([server]);
        const event = { payload: createPayload(modelId) };

        return (await eventManager.onBeforeProviderRequest(
          event as any,
        )) as Record<string, unknown>;
      };

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

        const result = await runRequest("m");

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
        mockSettingsManager.getDefaultThinkingLevel.mockReturnValue("low");

        const result = await runRequest("m");

        expect(result).toMatchObject({
          thinking_budget_tokens: 8192,
          temperature: 0.7,
        });
      });

      // With no sampling set active, only the default thinking budget applies
      const UNCHANGED_BY_SAMPLING = {
        ...createPayload("m"),
        thinking_budget_tokens: DEFAULT_THINKING_LEVELS.medium.budget,
      };

      it("should inject nothing when no set is selected", async () => {
        setSamplingConfig({
          "*": {
            samplingMap: { thinking: { temperature: 1.0 } },
          },
        });

        const result = await runRequest("m");

        expect(result).toEqual(UNCHANGED_BY_SAMPLING);
      });

      it("should not leak a selection from another model", async () => {
        setSamplingConfig({
          "*": {
            samplingMap: { thinking: { temperature: 1.0 } },
          },
        });
        SamplingState.set("other-model", "thinking");

        const result = await runRequest("m");

        expect(result).toEqual(UNCHANGED_BY_SAMPLING);
      });

      it("should ignore a selected set that no longer exists for the model", async () => {
        setSamplingConfig({
          "*": { samplingMap: { instruct: { temperature: 0.7 } } },
        });
        SamplingState.set("m", "thinking");

        const result = await runRequest("m");

        expect(result).toEqual(UNCHANGED_BY_SAMPLING);
      });

      it("should inject nothing for models without a samplingMap", async () => {
        SamplingState.set("m", "thinking");

        const result = await runRequest("m");

        expect(result).toEqual(UNCHANGED_BY_SAMPLING);
      });
    });

    it("should use budget-only entries for budget models (e.g. qwen3.6)", async () => {
      setLlamaThinking({
        "qwen3.6*": {
          thinkingLevelMap: {
            off: { enable_thinking: false, preserve_thinking: false },
            low: { budget: 2048 },
            medium: { budget: 8192 },
          },
        },
      });
      mockSettingsManager.getDefaultThinkingLevel.mockReturnValue("low");

      const result = await runRequest("qwen3.6-27b");

      expect(result).toMatchObject({ thinking_budget_tokens: 2048 });
      expect(result).not.toHaveProperty("chat_template_kwargs");
    });

    it("should fall back to the historical budget behavior when no pattern matches", async () => {
      setLlamaThinking({ "qwen3.5*": { thinkingLevelMap: QWEN35_MAP } });
      mockSettingsManager.getDefaultThinkingLevel.mockReturnValue("high");

      const result = await runRequest("some-other-model");

      expect(result.thinking_budget_tokens).toBe(
        DEFAULT_THINKING_LEVELS.high.budget,
      );
    });

    it("should prefer the most specific matching pattern", async () => {
      setLlamaThinking({
        "*": { thinkingLevelMap: { low: { budget: 1 } } },
        "qwen3.5*": { thinkingLevelMap: { low: { budget: 2 } } },
      });
      mockSettingsManager.getDefaultThinkingLevel.mockReturnValue("low");

      const result = await runRequest("qwen3.5-27b");

      expect(result.thinking_budget_tokens).toBe(2);
    });
  });
});
