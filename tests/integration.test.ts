import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LLAMA_PROVIDER_ID } from "../src/constants";
import { CommandManager } from "../src/managers/command";
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

const CONFIG = {
  "*qwen*": {
    thinkingLevelMap: {
      off: { enable_thinking: false },
      low: { budget: 2048 },
    },
    samplingMap: {
      instruct: { temperature: 0.7, top_p: 0.8 },
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  SamplingState.clear();
  mockSettingsManager.getDefaultThinkingLevel.mockReturnValue("medium");
  mockSettingsManager.getThinkingBudgets.mockReturnValue(undefined);
  mockSettingsManager.getProjectSettings.mockReturnValue({});
  mockSettingsManager.getGlobalSettings.mockReturnValue({
    llamaModelsConfig: CONFIG,
  });
});

/** One resolver shared by both managers, as wired in src/index.ts. */
const createManagers = () => {
  const resolver = new ConfigResolver();
  return { command: new CommandManager(resolver), events: new EventManager(resolver) };
};

const llamaModel = (id: string) => ({ id, provider: LLAMA_PROVIDER_ID });

const createCommandCtx = (model?: { id: string; provider: string }) => {
  const ctx = {
    model,
    ui: { notify: vi.fn(), select: vi.fn(), setStatus: vi.fn() },
  };
  return ctx as unknown as ExtensionCommandContext & {
    ui: {
      notify: ReturnType<typeof vi.fn>;
      select: ReturnType<typeof vi.fn>;
      setStatus: ReturnType<typeof vi.fn>;
    };
  };
};

const createRequestCtx = (model?: { id: string; provider: string }) =>
  ({ model, thinkingLevel: "low" }) as unknown as ExtensionContext;

describe("command → state → payload integration", () => {
  it("should inject the set selected via /models sampling into the next request", async () => {
    const { command, events } = createManagers();

    await command.handleCommand(
      "instruct",
      createCommandCtx(llamaModel("qwen38-27b")),
      {} as any,
    );
    expect(SamplingState.get("qwen38-27b")).toBe("instruct");

    const payload = await events.onBeforeProviderRequest(
      { payload: { messages: [] } } as any,
      createRequestCtx(llamaModel("qwen38-27b")),
    );

    expect(payload).toMatchObject({
      // thinking spec for level "low" (ctx.thinkingLevel)
      thinking_budget_tokens: 2048,
      // sampling set selected by the command
      temperature: 0.7,
      top_p: 0.8,
    });
  });

  it("should stop injecting after the selection is cleared", async () => {
    const { command, events } = createManagers();

    await command.handleCommand(
      "instruct",
      createCommandCtx(llamaModel("qwen38-27b")),
      {} as any,
    );
    await command.handleCommand(
      "none",
      createCommandCtx(llamaModel("qwen38-27b")),
      {} as any,
    );

    const payload = await events.onBeforeProviderRequest(
      { payload: { messages: [] } } as any,
      createRequestCtx(llamaModel("qwen38-27b")),
    );

    expect(payload).toMatchObject({ thinking_budget_tokens: 2048 });
    expect(payload).not.toHaveProperty("temperature");
    expect(payload).not.toHaveProperty("top_p");
  });

  it("should restore the sampling status when the model is re-selected", async () => {
    const { command, events } = createManagers();

    await command.handleCommand(
      "instruct",
      createCommandCtx(llamaModel("qwen38-27b")),
      {} as any,
    );

    const ctx = createRequestCtx(llamaModel("qwen38-27b")) as ExtensionContext & {
      ui: { setStatus: ReturnType<typeof vi.fn> };
    };
    (ctx as any).ui = { setStatus: vi.fn() };

    events.onModelSelect(
      { type: "model_select", model: llamaModel("qwen38-27b") } as any,
      ctx,
    );

    expect((ctx as any).ui.setStatus).toHaveBeenCalledWith(
      "Llama.cpp",
      "sampling: instruct",
    );
  });
});
