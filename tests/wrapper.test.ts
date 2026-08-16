import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock instances — survives vi.resetModules()
const mockSettingsManager = vi.hoisted(() => ({
  getProjectSettings: vi.fn(),
  getGlobalSettings: vi.fn(),
  getThinkingBudgets: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: vi.fn().mockReturnValue("/fake/agent/dir"),
  SettingsManager: {
    create: vi.fn().mockReturnValue(mockSettingsManager),
  },
}));

import { StatsManager } from "../src/managers/stats";
import { ConfigResolver } from "../src/resolver";
import { LlamaProviderWrapper } from "../src/provider/wrapper";

const baseModel = (id: string): Model<Api> =>
  ({
    id,
    name: id,
    api: "openai-completions",
    provider: "llama.cpp",
    baseUrl: "http://127.0.0.1:8080/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 131072,
  }) as Model<Api>;

describe("LlamaProviderWrapper.supercharge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettingsManager.getProjectSettings.mockReturnValue({});
    mockSettingsManager.getGlobalSettings.mockReturnValue({});
    mockSettingsManager.getThinkingBudgets.mockReturnValue(undefined);
  });

  afterEach(() => vi.resetModules());

  it("applies reasoning + thinkingLevelMap using the default map when no pattern matches", () => {
    const wrapper = new LlamaProviderWrapper(new ConfigResolver(), new StatsManager());
    const [model] = wrapper.supercharge([baseModel("qwen38-27b")]);

    expect(model.reasoning).toBe(true);
    expect(model.thinkingLevelMap).toEqual({
      off: "off",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    });
  });

  it("preserves all other model fields untouched", () => {
    const wrapper = new LlamaProviderWrapper(new ConfigResolver(), new StatsManager());
    const original = baseModel("qwen38-27b");
    const [model] = wrapper.supercharge([original]);

    expect(model).toEqual({
      ...original,
      reasoning: true,
      thinkingLevelMap: expect.any(Object),
    });
    expect(model).not.toBe(original); // cloned, not mutated
  });

  it("applies the wildcard-matched thinkingLevelMap from llamaModelsConfig", () => {
    mockSettingsManager.getGlobalSettings.mockReturnValue({
      llamaModelsConfig: {
        "*qwen38*": {
          thinkingLevelMap: {
            off: { enable_thinking: false },
            low: { budget: 2048 },
            // hole: medium unavailable
          },
        },
      },
    });

    const wrapper = new LlamaProviderWrapper(new ConfigResolver(), new StatsManager());
    const [model] = wrapper.supercharge([baseModel("qwen38-27b")]);

    expect(model.reasoning).toBe(true);
    expect(model.thinkingLevelMap).toEqual({
      off: "off",
      minimal: null,
      low: "low",
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    });
  });

  it("leaves models untouched when the effective level map has no available levels", () => {
    mockSettingsManager.getGlobalSettings.mockReturnValue({
      llamaModelsConfig: {
        "*": { thinkingLevelMap: { off: null, minimal: null } },
      },
    });

    const wrapper = new LlamaProviderWrapper(new ConfigResolver(), new StatsManager());
    const original = baseModel("gemma4-26b");
    const [model] = wrapper.supercharge([original]);

    expect(model).toBe(original); // same reference, no thinking UI
  });

  it("passes a model through unmodified when the resolver throws for it", () => {
    mockSettingsManager.getGlobalSettings.mockImplementation(() => {
      throw new Error("settings exploded");
    });

    const wrapper = new LlamaProviderWrapper(new ConfigResolver(), new StatsManager());
    const original = baseModel("qwen38-27b");
    const [model] = wrapper.supercharge([original]);

    expect(model).toBe(original);
  });

  it("supercharges the rest of the list when one model fails", () => {
    mockSettingsManager.getGlobalSettings.mockReturnValue({
      llamaModelsConfig: {
        "*": { thinkingLevelMap: { off: null, minimal: null } },
        "good*": { thinkingLevelMap: { off: { enable_thinking: false } } },
      },
    });

    const wrapper = new LlamaProviderWrapper(new ConfigResolver(), new StatsManager());
    const bad = baseModel("bad-model");
    const good = baseModel("good-model");
    const [modelBad, modelGood] = wrapper.supercharge([bad, good]);

    expect(modelBad).toBe(bad); // no available levels -> untouched
    expect(modelGood.reasoning).toBe(true);
    expect(modelGood.thinkingLevelMap?.off).toBe("off");
  });

  it("returns an empty list for an empty catalog", () => {
    const wrapper = new LlamaProviderWrapper(new ConfigResolver(), new StatsManager());
    expect(wrapper.supercharge([])).toEqual([]);
  });
});

describe("LlamaProviderWrapper.init", () => {
  const fakeBuiltin = {
    id: "llama.cpp",
    name: "llama.cpp",
    baseUrl: "http://192.168.1.190:8080/v1",
    auth: { apiKey: {} },
    getModels: () => [baseModel("qwen38-27b")],
    refreshModels: async () => {},
    stream: () => {},
    streamSimple: () => {},
  };

  // Models Pi's real ModelRuntime shape: the raw built-in lives in the
  // internal nativeExtensionProviders map, and registerProvider() swaps it
  // out (later init() calls must read the updated value).
  const makeCtx = (builtin: unknown) => {
    const natives = new Map<string, unknown>(
      builtin === undefined ? [] : [["llama.cpp", builtin]],
    );
    const runtime = { nativeExtensionProviders: natives };
    return {
      modelRegistry: {
        runtime,
        getProvider: vi.fn().mockReturnValue(builtin),
      },
      _register: (p: unknown) => natives.set("llama.cpp", p),
    } as any;
  };

  const makePi = (ctx: any) => {
    const registerProvider = vi.fn((p: unknown) => ctx._register(p));
    return {
      pi: { registerProvider } as unknown as ExtensionAPI,
      registerProvider,
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSettingsManager.getProjectSettings.mockReturnValue({});
    mockSettingsManager.getGlobalSettings.mockReturnValue({});
    mockSettingsManager.getThinkingBudgets.mockReturnValue(undefined);
  });

  it("registers a native provider that passes the built-in through and supercharges getModels", () => {
    const ctx = makeCtx(fakeBuiltin);
    const { pi, registerProvider } = makePi(ctx);
    const wrapper = new LlamaProviderWrapper(new ConfigResolver(), new StatsManager());

    expect(wrapper.init(pi, ctx)).toBe(true);
    expect(wrapper.isWrapped).toBe(true);

    expect(registerProvider).toHaveBeenCalledTimes(1);
    const registered = registerProvider.mock.calls[0][0] as any;
    expect(registered.id).toBe("llama.cpp");
    expect(registered.auth).toBe(fakeBuiltin.auth); // same object
    expect(registered.refreshModels).toBe(fakeBuiltin.refreshModels);
    expect(registered.stream).toBe(fakeBuiltin.stream);
    expect(typeof registered.streamSimple).toBe("function");

    const models = registered.getModels();
    expect(models).toHaveLength(1);
    expect(models[0].reasoning).toBe(true);
    expect(models[0].thinkingLevelMap).toBeDefined();
  });

  it("wraps streamSimple with a provider-scoped stats fetch tap", async () => {
    const builtinStreamSimple = vi.fn(
      async (_model: unknown, _context: unknown, _options: unknown) => {},
    );
    const dynamicBuiltin = { ...fakeBuiltin, streamSimple: builtinStreamSimple };
    const ctx = makeCtx(dynamicBuiltin);
    const { pi } = makePi(ctx);
    const wrapper = new LlamaProviderWrapper(new ConfigResolver(), new StatsManager());

    expect(wrapper.init(pi, ctx)).toBe(true);
    const registered = (pi.registerProvider as any).mock.calls[0][0];

    // No options.fetch: the tap is still provided (defaults to global fetch)
    await registered.streamSimple(baseModel("m"), {}, {});
    expect(builtinStreamSimple).toHaveBeenCalledTimes(1);
    const passedOptions = builtinStreamSimple.mock.calls[0][2] as {
      fetch?: unknown;
    };
    expect(typeof passedOptions.fetch).toBe("function");

    // Caller-provided fetch: wrapped, not replaced
    const callerFetch = vi.fn();
    await registered.streamSimple(baseModel("m"), {}, { fetch: callerFetch });
    const wrappedFetch = (builtinStreamSimple.mock.calls[1][2] as {
      fetch?: unknown;
    }).fetch;
    expect(wrappedFetch).not.toBe(callerFetch);
  });

  it("reflects live catalog changes without re-registration", () => {
    let live: Model<Api>[] = [baseModel("qwen38-27b")];
    const dynamicBuiltin = { ...fakeBuiltin, getModels: () => live };
    const ctx = makeCtx(dynamicBuiltin);
    const { pi, registerProvider } = makePi(ctx);
    const wrapper = new LlamaProviderWrapper(new ConfigResolver(), new StatsManager());
    wrapper.init(pi, ctx);

    const registered = registerProvider.mock.calls[0][0] as any;
    expect(registered.getModels().map((m: Model<Api>) => m.id)).toEqual([
      "qwen38-27b",
    ]);

    // /llama loads another model in the built-in's closure state
    live = [baseModel("qwen38-27b"), baseModel("gemma4-26b")];
    expect(registered.getModels().map((m: Model<Api>) => m.id)).toEqual([
      "qwen38-27b",
      "gemma4-26b",
    ]);
  });

  it("is idempotent — a second init on the same runtime does not re-register", () => {
    const ctx = makeCtx(fakeBuiltin);
    const { pi, registerProvider } = makePi(ctx);
    const wrapper = new LlamaProviderWrapper(new ConfigResolver(), new StatsManager());
    wrapper.init(pi, ctx);
    expect(wrapper.init(pi, ctx)).toBe(true);
    expect(registerProvider).toHaveBeenCalledTimes(1);
  });

  it("re-wraps when the runtime is rebuilt (fresh native map)", () => {
    const ctx1 = makeCtx(fakeBuiltin);
    const { pi, registerProvider } = makePi(ctx1);
    const wrapper = new LlamaProviderWrapper(new ConfigResolver(), new StatsManager());
    wrapper.init(pi, ctx1);

    // /new or /resume: a fresh ModelRuntime with the raw built-in again.
    const ctx2 = makeCtx(fakeBuiltin);
    expect(wrapper.init(pi, ctx2)).toBe(true);
    expect(registerProvider).toHaveBeenCalledTimes(2);
  });

  it("stays inert when the built-in provider is not present", () => {
    const ctx = makeCtx(undefined);
    const { pi, registerProvider } = makePi(ctx);
    const wrapper = new LlamaProviderWrapper(new ConfigResolver(), new StatsManager());

    expect(wrapper.init(pi, ctx)).toBe(false);
    expect(wrapper.isWrapped).toBe(false);
    expect(registerProvider).not.toHaveBeenCalled();
  });
});
