import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LLAMA_PROVIDER_ID } from "../src/constants";
import { CommandManager } from "../src/managers/command";
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

const SAMPLING_CONFIG = {
  "*": {
    samplingMap: {
      thinking: { temperature: 1.0, top_p: 0.95 },
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
    llamaModelsConfig: SAMPLING_CONFIG,
  });
});

/** Builds a minimal command context with a current model. */
const createCtx = (model?: { id: string; provider: string }) => {
  const ctx = {
    model,
    ui: {
      notify: vi.fn(),
      select: vi.fn<() => Promise<string | null>>(),
      setStatus: vi.fn(),
    },
  };
  return ctx as unknown as ExtensionCommandContext & {
    ui: {
      notify: ReturnType<typeof vi.fn>;
      select: ReturnType<typeof vi.fn>;
      setStatus: ReturnType<typeof vi.fn>;
    };
  };
};

const llamaModel = (id: string) => ({ id, provider: LLAMA_PROVIDER_ID });

describe("CommandManager", () => {
  let commandManager: CommandManager;

  beforeEach(() => {
    commandManager = new CommandManager(new ConfigResolver());
  });

  describe("getArgumentCompletions", () => {
    it("should provide completions for /models", () => {
      const items = commandManager.getArgumentCompletions("");

      expect(items).toEqual([
        {
          value: "sampling",
          label: "sampling",
          description: "Select the sampling set for the current model",
        },
      ]);
    });

    it("should filter completions by prefix", () => {
      const items = commandManager.getArgumentCompletions("sam");

      expect(items?.[0].value).toBe("sampling");
    });

    it("should return null when no completions match", () => {
      expect(commandManager.getArgumentCompletions("info")).toBeNull();
    });
  });

  describe("handleCommand 'sampling'", () => {
    it("should warn when the current model is not a llama.cpp model", async () => {
      const ctx = createCtx({ id: "gpt-4", provider: "openai" });

      await commandManager.handleCommand("sampling thinking", ctx, {} as any);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("only apply to"),
        "warning",
      );
    });

    it("should warn when there is no current model", async () => {
      const ctx = createCtx();

      await commandManager.handleCommand("sampling thinking", ctx, {} as any);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("only apply to"),
        "warning",
      );
    });

    it("should warn when the model has no sampling sets", async () => {
      mockSettingsManager.getGlobalSettings.mockReturnValue({});
      const ctx = createCtx(llamaModel("m"));

      await commandManager.handleCommand("sampling thinking", ctx, {} as any);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("No sampling sets defined"),
        "warning",
      );
    });

    it("should select a set by name and update the status", async () => {
      const ctx = createCtx(llamaModel("m"));

      await commandManager.handleCommand("sampling thinking", ctx, {} as any);

      expect(SamplingState.get("m")).toBe("thinking");
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "Llama.cpp",
        "sampling: thinking",
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Sampling set"),
        "info",
      );
    });

    it("should treat a bare 'sampling' argument as the picker", async () => {
      const ctx = createCtx(llamaModel("m"));
      ctx.ui.select.mockResolvedValue("instruct");

      await commandManager.handleCommand("sampling", ctx, {} as any);

      expect(ctx.ui.select).toHaveBeenCalledWith(
        expect.stringContaining("sampling sets"),
        ["thinking", "instruct", "none"],
      );
      expect(SamplingState.get("m")).toBe("instruct");
    });

    it("should treat no argument as the picker", async () => {
      const ctx = createCtx(llamaModel("m"));
      ctx.ui.select.mockResolvedValue("thinking");

      await commandManager.handleCommand("", ctx, {} as any);

      expect(ctx.ui.select).toHaveBeenCalled();
      expect(SamplingState.get("m")).toBe("thinking");
    });

    it("should clear the selection with 'none' and update the status", async () => {
      SamplingState.set("m", "thinking");
      const ctx = createCtx(llamaModel("m"));

      await commandManager.handleCommand("sampling none", ctx, {} as any);

      expect(SamplingState.get("m")).toBeUndefined();
      expect(ctx.ui.setStatus).toHaveBeenCalledWith("Llama.cpp", undefined);
    });

    it("should error on an unknown set name", async () => {
      const ctx = createCtx(llamaModel("m"));

      await commandManager.handleCommand("sampling bogus", ctx, {} as any);

      expect(SamplingState.get("m")).toBeUndefined();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Unknown sampling set"),
        "error",
      );
    });

    it("should not select a set when the picker is cancelled", async () => {
      const ctx = createCtx(llamaModel("m"));
      ctx.ui.select.mockResolvedValue(null);

      await commandManager.handleCommand("sampling", ctx, {} as any);

      expect(SamplingState.get("m")).toBeUndefined();
    });
  });
});
