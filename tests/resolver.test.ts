import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_KEY_PLACEHOLDER,
  DEFAULT_LLAMA_SERVER_URL,
  DEFAULT_THINKING_LEVELS,
} from "../src/constants";

// Hoisted mock instances — survives vi.resetModules()
const mockReadStoredCredential = vi.hoisted(() => vi.fn());

const mockSettingsManager = vi.hoisted(() => ({
  getProjectSettings: vi.fn(),
  getGlobalSettings: vi.fn(),
  getThinkingBudgets: vi.fn(),
}));

// Mock getAgentDir, readStoredCredential, and SettingsManager before importing resolver
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: vi.fn().mockReturnValue("/fake/agent/dir"),
  readStoredCredential: (...args: unknown[]) =>
    mockReadStoredCredential(...args),
  SettingsManager: {
    create: vi.fn().mockReturnValue(mockSettingsManager),
  },
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

// Import mocked modules
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { ConfigResolver } from "../src/resolver";

describe("URL resolution fallback chain", () => {
  const mockReadFile = vi.mocked(readFile);
  const mockGetAgentDir = vi.mocked(getAgentDir);
  const mockGetProjectSettings = vi.mocked(
    mockSettingsManager.getProjectSettings,
  );
  const mockGetGlobalSettings = vi.mocked(
    mockSettingsManager.getGlobalSettings,
  );

  afterEach(() => {
    delete process.env.LLAMA_SERVER_URL;
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAgentDir.mockReturnValue("/fake/agent/dir");
    // Default: no settings found
    mockGetProjectSettings.mockReturnValue({});
    mockGetGlobalSettings.mockReturnValue({});
  });

  it("should return default URL when no config is found", async () => {
    const resolver = new ConfigResolver();
    const result = await resolver.resolveUrls();

    expect(result).toEqual([DEFAULT_LLAMA_SERVER_URL]);
  });

  it("should prioritize project config over env variable", async () => {
    mockGetProjectSettings.mockReturnValue({
      llamaServerUrl: "http://localhost:9999",
    });
    process.env.LLAMA_SERVER_URL = "http://env-url:8080";

    const resolver = new ConfigResolver();
    const result = await resolver.resolveUrls();

    expect(result).toEqual(["http://localhost:9999"]);
  });

  it("should use env variable when no project config exists", async () => {
    mockGetProjectSettings.mockReturnValue({});
    process.env.LLAMA_SERVER_URL = "http://env-url:8080";

    const resolver = new ConfigResolver();
    const result = await resolver.resolveUrls();

    expect(result).toEqual(["http://env-url:8080"]);
  });

  it("should use global settings when no project config or env exists", async () => {
    mockGetProjectSettings.mockReturnValue({});
    mockGetGlobalSettings.mockReturnValue({
      llamaServerUrl: "http://global:8080",
    });

    const resolver = new ConfigResolver();
    const result = await resolver.resolveUrls();

    expect(result).toEqual(["http://global:8080"]);
  });

  it("should strip trailing slashes from resolved URL", async () => {
    mockGetProjectSettings.mockReturnValue({
      llamaServerUrl: "http://localhost:8080/",
    });

    const resolver = new ConfigResolver();
    const result = await resolver.resolveUrls();

    expect(result).toEqual(["http://localhost:8080"]);
  });

  it("should cache the resolved URL on subsequent calls", async () => {
    mockGetProjectSettings.mockReturnValue({
      llamaServerUrl: "http://first:8080",
    });

    const resolver = new ConfigResolver();
    const result1 = await resolver.resolveUrls();
    const result2 = await resolver.resolveUrls();

    expect(result1).toEqual(["http://first:8080"]);
    expect(result2).toEqual(["http://first:8080"]);
  });

  it("should handle multiple URLs separated by semicolons", async () => {
    mockGetProjectSettings.mockReturnValue({
      llamaServerUrl: "http://first:8080;http://second:9090/",
    });

    const resolver = new ConfigResolver();
    const result = await resolver.resolveUrls();

    expect(result).toEqual(["http://first:8080", "http://second:9090"]);
  });
});

describe("API key resolution", () => {
  const mockGetAgentDir = vi.mocked(getAgentDir);

  afterEach(() => {
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAgentDir.mockReturnValue("/fake/agent/dir");
    mockReadStoredCredential.mockReturnValue(undefined);
  });

  it("should return placeholder when credential is not found", () => {
    mockReadStoredCredential.mockReturnValue(undefined);

    const resolver = new ConfigResolver();
    const result = resolver.resolveApiKey("llama-server=http://127.0.0.1:8080");

    expect(result).toEqual(API_KEY_PLACEHOLDER);
  });

  it("should return placeholder when apiKey is missing from credential", () => {
    mockReadStoredCredential.mockReturnValue({});

    const resolver = new ConfigResolver();
    const result = resolver.resolveApiKey("llama-server=http://127.0.0.1:8080");

    expect(result).toEqual(API_KEY_PLACEHOLDER);
  });

  it("should return the apiKey when present in credential", () => {
    mockReadStoredCredential.mockReturnValue({ key: "test-api-key" });

    const resolver = new ConfigResolver();
    const result = resolver.resolveApiKey("llama-server=http://127.0.0.1:8080");

    expect(result).toEqual("test-api-key");
  });

  it("should call readStoredCredential with the provider ID", () => {
    mockReadStoredCredential.mockReturnValue({ apiKey: "test-key" });

    const resolver = new ConfigResolver();
    resolver.resolveApiKey("llama-server=http://127.0.0.1:8080");

    expect(mockReadStoredCredential).toHaveBeenCalledWith(
      "llama-server=http://127.0.0.1:8080",
    );
  });
});

describe("thinking configuration resolution", () => {
  const mockGetProjectSettings = vi.mocked(
    mockSettingsManager.getProjectSettings,
  );
  const mockGetGlobalSettings = vi.mocked(
    mockSettingsManager.getGlobalSettings,
  );
  const mockGetThinkingBudgets = vi.mocked(
    mockSettingsManager.getThinkingBudgets,
  );

  const FULL_MAP: Record<string, string> = {
    off: "off",
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProjectSettings.mockReturnValue({});
    mockGetGlobalSettings.mockReturnValue({});
    mockGetThinkingBudgets.mockReturnValue(undefined);
  });

  describe("global default map (no matching pattern)", () => {
    it("should return the default per-level specs", () => {
      const levels = new ConfigResolver().resolveThinkingLevels("any-model");

      for (const level of Object.keys(FULL_MAP))
        expect(levels[level as keyof typeof levels]).toEqual(
          DEFAULT_THINKING_LEVELS[level as keyof typeof levels],
        );
    });

    it("should apply thinkingBudgets overrides to the overridable levels", () => {
      mockGetThinkingBudgets.mockReturnValue({ low: 4096 });

      const levels = new ConfigResolver().resolveThinkingLevels("m");

      expect(levels.low).toEqual({ budget: 4096 });
      // Untouched levels keep their defaults
      expect(levels.minimal).toEqual({ budget: 1024 });
      expect(levels.high).toEqual({ budget: 16384 });
    });

    it("should not apply thinkingBudgets to off and max", () => {
      mockGetThinkingBudgets.mockReturnValue({
        off: 99999,
        max: 1,
      } as any);

      const levels = new ConfigResolver().resolveThinkingLevels("m");

      expect(levels.off).toEqual({ enable_thinking: false });
      expect(levels.max).toEqual({});
    });

    it("should use the defaults when the pattern does not match", () => {
      mockGetProjectSettings.mockReturnValue({
        llamaModelsConfig: { "qwen3.5*": { thinkingLevelMap: { low: {} } } },
      });

      const levels = new ConfigResolver().resolveThinkingLevels("llama-3.1-8b");

      for (const level of Object.keys(FULL_MAP))
        expect(levels[level as keyof typeof levels]).toEqual(
          DEFAULT_THINKING_LEVELS[level as keyof typeof levels],
        );
    });

    it("should use the defaults when the entry has no usable level map", () => {
      mockGetProjectSettings.mockReturnValue({
        llamaModelsConfig: { "*": {} },
      });

      expect(new ConfigResolver().resolveThinkingLevels("m").low).toEqual(
        DEFAULT_THINKING_LEVELS.low,
      );
    });
  });

  describe("llamaModelsConfig pattern matching", () => {
    it("should match wildcard patterns", () => {
      mockGetProjectSettings.mockReturnValue({
        llamaModelsConfig: { "qwen3.5*": { thinkingLevelMap: { low: {} } } },
      });

      expect(
        new ConfigResolver().resolveThinkingLevels("qwen3.5-27b").low,
      ).toEqual({});
      expect(
        new ConfigResolver().resolveThinkingLevels("other-model").low,
      ).toEqual(DEFAULT_THINKING_LEVELS.low);
    });

    it("should treat literal special characters literally, not as regex", () => {
      mockGetProjectSettings.mockReturnValue({
        llamaModelsConfig: { "model.v2": { thinkingLevelMap: { low: {} } } },
      });

      expect(new ConfigResolver().resolveThinkingLevels("modelv2").low).toEqual(
        DEFAULT_THINKING_LEVELS.low,
      );
      expect(
        new ConfigResolver().resolveThinkingLevels("model.v2").low,
      ).toEqual({});
    });

    it("should prefer the most specific (longest) matching pattern", () => {
      mockGetProjectSettings.mockReturnValue({
        llamaModelsConfig: {
          "qwen3.5*": { thinkingLevelMap: { low: { budget: 1 } } },
          "*": { thinkingLevelMap: { low: { budget: 2 } } },
        },
      });

      expect(
        new ConfigResolver().resolveThinkingLevels("qwen3.5-27b").low,
      ).toEqual({ budget: 1 });
    });

    it("should prefer project entries over global entries for the same pattern", () => {
      mockGetProjectSettings.mockReturnValue({
        llamaModelsConfig: {
          "*": { thinkingLevelMap: { low: { budget: 1 } } },
        },
      });
      mockGetGlobalSettings.mockReturnValue({
        llamaModelsConfig: {
          "*": { thinkingLevelMap: { low: { budget: 2 } } },
        },
      });

      expect(new ConfigResolver().resolveThinkingLevels("m").low).toEqual({
        budget: 1,
      });
    });

    it("should keep global patterns when project defines different ones", () => {
      mockGetProjectSettings.mockReturnValue({
        llamaModelsConfig: {
          "qwen3.5*": { thinkingLevelMap: { low: { budget: 1 } } },
        },
      });
      mockGetGlobalSettings.mockReturnValue({
        llamaModelsConfig: {
          "qwen3.6*": { thinkingLevelMap: { low: { budget: 2 } } },
        },
      });

      expect(
        new ConfigResolver().resolveThinkingLevels("qwen3.5-27b").low,
      ).toEqual({ budget: 1 });
      expect(
        new ConfigResolver().resolveThinkingLevels("qwen3.6-27b").low,
      ).toEqual({ budget: 2 });
    });
  });

  describe("llamaModelsConfig level spec parsing", () => {
    const setMap = (thinkingLevelMap: Record<string, unknown>) =>
      mockGetProjectSettings.mockReturnValue({
        llamaModelsConfig: { "*": { thinkingLevelMap } },
      });

    it("should parse all additive fields", () => {
      setMap({
        low: {
          budget: 1024,
          effort: "low",
          enable_thinking: true,
          preserve_thinking: false,
        },
      });

      expect(new ConfigResolver().resolveThinkingLevels("m").low).toEqual({
        budget: 1024,
        effort: "low",
        enable_thinking: true,
        preserve_thinking: false,
      });
    });

    it("should treat budget 0 as a valid explicit value", () => {
      setMap({ off: { budget: 0 } });

      expect(new ConfigResolver().resolveThinkingLevels("m").off).toEqual({
        budget: 0,
      });
    });

    it("should treat an empty object as available but adding nothing", () => {
      setMap({ xhigh: {} });

      expect(new ConfigResolver().resolveThinkingLevels("m").xhigh).toEqual({});
    });

    it("should treat holes (absent keys) as unavailable (null)", () => {
      setMap({ low: {} });

      const levels = new ConfigResolver().resolveThinkingLevels("m");

      expect(levels.low).toEqual({});
      for (const level of Object.keys(FULL_MAP)) {
        if (level === "low") continue;
        expect(levels[level as keyof typeof levels]).toBeNull();
      }
    });

    it("should treat explicit null as unavailable", () => {
      setMap({ low: null, medium: {} });

      const levels = new ConfigResolver().resolveThinkingLevels("m");

      expect(levels.low).toBeNull();
      expect(levels.medium).toEqual({});
    });

    it("should ignore fields with invalid types", () => {
      setMap({ low: { budget: "big", effort: 5, enable_thinking: "yes" } });

      expect(new ConfigResolver().resolveThinkingLevels("m").low).toEqual({});
    });
  });

  describe("resolveThinkingLevelMap", () => {
    it("should return the full map when no pattern matches", () => {
      expect(new ConfigResolver().resolveThinkingLevelMap("any-model")).toEqual(
        FULL_MAP,
      );
    });

    it("should expose available levels by name and null for holes", () => {
      mockGetProjectSettings.mockReturnValue({
        llamaModelsConfig: {
          "*": {
            thinkingLevelMap: {
              off: { enable_thinking: false },
              low: {},
              xhigh: { effort: "xhigh" },
            },
          },
        },
      });

      const map = new ConfigResolver().resolveThinkingLevelMap("m");

      expect(map.off).toBe("off");
      expect(map.low).toBe("low");
      expect(map.xhigh).toBe("xhigh");
      expect(map.minimal).toBeNull();
      expect(map.medium).toBeNull();
      expect(map.high).toBeNull();
      expect(map.max).toBeNull();
    });
  });

  describe("llamaModelsConfig samplingMap resolution", () => {
    const setSamplingMap = (samplingMap: unknown) =>
      mockGetProjectSettings.mockReturnValue({
        llamaModelsConfig: { "*": { samplingMap } },
      });

    it("should parse sets with whitelisted fields, passing keys through verbatim", () => {
      setSamplingMap({
        thinking: {
          temperature: 1.0,
          top_p: 0.95,
          top_k: 20,
          min_p: 0.0,
          presence_penalty: 0.0,
          repeat_penalty: 1.0,
        },
        instruct: {
          temperature: 0.7,
          top_p: 0.8,
          repeat_penalty: 1.05,
        },
      });

      expect(new ConfigResolver().resolveSamplingMap("m")).toEqual({
        thinking: {
          temperature: 1.0,
          top_p: 0.95,
          top_k: 20,
          min_p: 0.0,
          presence_penalty: 0.0,
          repeat_penalty: 1.0,
        },
        instruct: {
          temperature: 0.7,
          top_p: 0.8,
          repeat_penalty: 1.05,
        },
      });
    });

    it("should drop unknown fields (e.g. HF naming) and non-numeric values", () => {
      setSamplingMap({
        broken: {
          repetition_penalty: 1.0, // HF name, not a server field
          temperature: "hot",
          top_p: NaN,
          min_p: 0.0,
        },
      });

      expect(new ConfigResolver().resolveSamplingMap("m")).toEqual({
        broken: { min_p: 0.0 },
      });
    });

    it("should omit sets with no usable fields", () => {
      setSamplingMap({
        empty: {},
        unknownOnly: { repetition_penalty: 1.0 },
        good: { temperature: 0.7 },
      });

      expect(new ConfigResolver().resolveSamplingMap("m")).toEqual({
        good: { temperature: 0.7 },
      });
    });

    it("should return undefined when there is no matching pattern", () => {
      mockGetProjectSettings.mockReturnValue({
        llamaModelsConfig: {
          "qwen*": { samplingMap: { thinking: { temperature: 1.0 } } },
        },
      });

      expect(
        new ConfigResolver().resolveSamplingMap("other-model"),
      ).toBeUndefined();
    });

    it("should return undefined when the entry has no usable samplingMap", () => {
      setSamplingMap({});

      expect(new ConfigResolver().resolveSamplingMap("m")).toBeUndefined();
    });

    it("should share pattern matching with thinkingLevelMap", () => {
      mockGetProjectSettings.mockReturnValue({
        llamaModelsConfig: {
          "qwen3.5*": {
            thinkingLevelMap: { low: {} },
            samplingMap: { thinking: { temperature: 1.0 } },
          },
        },
      });

      const levels = new ConfigResolver().resolveThinkingLevels("qwen3.5-27b");
      expect(levels.low).toEqual({});
      expect(new ConfigResolver().resolveSamplingMap("qwen3.5-27b")).toEqual({
        thinking: { temperature: 1.0 },
      });
    });
  });
});
